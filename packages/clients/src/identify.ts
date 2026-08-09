/**
 * Product identification. UPC/ASIN/ISBN win when present; otherwise the
 * Anthropic API normalizes the raw listing title into a canonical product
 * name + category + condition guess (structured outputs, Redis-cached 7d,
 * hourly budget capped).
 */
import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { compsQueryFromTitle } from "./comps.js";
import type { LoggerLike } from "@flipsight/shared";
import type { Redis } from "ioredis";
import { z } from "zod";

const DEFAULT_MODEL = "claude-sonnet-5";
const CACHE_TTL_SEC = 7 * 24 * 3600;

export const ProductIdentitySchema = z.object({
  canonicalName: z.string().describe("Canonical product name: brand + model + key variant, no condition/lot noise"),
  brand: z.string().nullable(),
  model: z.string().nullable(),
  category: z.string().describe("Product category, e.g. Power Tools, Vintage Audio, Video Game Consoles"),
  conditionGuess: z
    .enum(["new", "like_new", "used_good", "used_fair", "for_parts", "unknown"])
    .describe("Condition inferred from the title/condition text"),
  searchQuery: z.string().describe("Best eBay sold-comps search query for this exact product"),
  confidence: z.number().min(0).max(1).describe("How confidently the title maps to one specific product"),
});
export type ProductIdentityAI = z.infer<typeof ProductIdentitySchema>;

export interface ProductIdentity {
  canonicalName: string;
  searchQuery: string;
  category: string | null;
  conditionGuess: string | null;
  brand: string | null;
  /** How the product was identified. */
  method: "upc" | "asin" | "isbn" | "ai" | "heuristic";
  aiConfidence: number | null;
}

export interface IdentifyInput {
  title: string;
  upc?: string | null;
  asin?: string | null;
  isbn?: string | null;
  category?: string | null;
  condition?: string | null;
  currentPrice?: number;
}

export class ProductIdentifier {
  private readonly client: Anthropic | null;
  readonly model: string;

  constructor(
    private readonly deps: { redis: Redis; log: LoggerLike },
    options: { apiKey?: string; model?: string } = {},
  ) {
    const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
    this.client = apiKey ? new Anthropic({ apiKey }) : null;
    this.model = options.model ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL;
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  async identify(
    input: IdentifyInput,
    options: { useAI: boolean; maxAiPerHour: number },
  ): Promise<ProductIdentity> {
    // 1. Hard identifiers win outright.
    if (input.upc) return this.fromCode("upc", input);
    if (input.asin) return this.fromCode("asin", input);
    if (input.isbn) return this.fromCode("isbn", input);

    // 2. AI normalization (cached; budget-capped).
    if (options.useAI && this.client) {
      const cacheKey = `identify:${createHash("sha1").update(input.title.toLowerCase().trim()).digest("hex")}`;
      const cached = await this.deps.redis.get(cacheKey);
      if (cached) {
        return { ...(JSON.parse(cached) as ProductIdentity) };
      }
      if (await this.takeAiBudget(options.maxAiPerHour)) {
        const ai = await this.identifyWithAI(input);
        if (ai) {
          const identity: ProductIdentity = {
            canonicalName: ai.canonicalName,
            searchQuery: ai.searchQuery,
            category: ai.category,
            conditionGuess: ai.conditionGuess,
            brand: ai.brand,
            method: "ai",
            aiConfidence: ai.confidence,
          };
          await this.deps.redis.set(cacheKey, JSON.stringify(identity), "EX", CACHE_TTL_SEC);
          return identity;
        }
      }
    }

    // 3. Heuristic fallback.
    const query = compsQueryFromTitle(input.title);
    return {
      canonicalName: query,
      searchQuery: query,
      category: input.category ?? null,
      conditionGuess: null,
      brand: null,
      method: "heuristic",
      aiConfidence: null,
    };
  }

  private fromCode(method: "upc" | "asin" | "isbn", input: IdentifyInput): ProductIdentity {
    const code = input[method]!;
    return {
      canonicalName: `${method}:${code}`,
      searchQuery: compsQueryFromTitle(input.title),
      category: input.category ?? null,
      conditionGuess: null,
      brand: null,
      method,
      aiConfidence: null,
    };
  }

  private async takeAiBudget(maxPerHour: number): Promise<boolean> {
    if (maxPerHour <= 0) return false;
    const key = "identify:ai-budget";
    const count = await this.deps.redis.incr(key);
    if (count === 1) await this.deps.redis.expire(key, 3600);
    if (count > maxPerHour) {
      this.deps.log.warn({ event: "identify_ai_budget_exhausted", maxPerHour }, "AI identification budget exhausted this hour");
      return false;
    }
    return true;
  }

  private async identifyWithAI(input: IdentifyInput): Promise<ProductIdentityAI | null> {
    const startedAt = Date.now();
    try {
      const response = await this.client!.messages.parse({
        model: this.model,
        max_tokens: 1024,
        system:
          "You normalize marketplace listing titles into canonical product identities for a resale " +
          "valuation engine. Be precise: canonicalName identifies ONE product (brand + model + key " +
          "variant), never a lot or vague description. searchQuery is what you'd type into eBay sold " +
          "listings to find comps for this exact product. Low confidence (<0.5) when the title is too " +
          "vague to pin one product.",
        messages: [
          {
            role: "user",
            content:
              `Listing title: ${input.title}\n` +
              (input.category ? `Source category: ${input.category}\n` : "") +
              (input.condition ? `Stated condition: ${input.condition}\n` : "") +
              (input.currentPrice ? `Current price: $${input.currentPrice}\n` : "") +
              "Identify the product.",
          },
        ],
        output_config: { format: zodOutputFormat(ProductIdentitySchema) },
      });
      if (response.stop_reason === "refusal" || !response.parsed_output) return null;
      this.deps.log.info(
        {
          event: "identify_ai",
          durationMs: Date.now() - startedAt,
          canonicalName: response.parsed_output.canonicalName,
          confidence: response.parsed_output.confidence,
        },
        "product identified via AI",
      );
      return response.parsed_output;
    } catch (err) {
      this.deps.log.warn(
        { event: "identify_ai_failed", err: err instanceof Error ? err.message : String(err) },
        "AI identification failed — falling back to heuristic",
      );
      return null;
    }
  }
}

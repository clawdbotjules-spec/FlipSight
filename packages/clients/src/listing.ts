/**
 * AI Listing Assistant: photos + a few words in → a comp-optimized eBay
 * listing draft out (≤80-char title, item specifics, description), as
 * schema-validated structured output. Price suggestion comes from the comp
 * engine when eBay credentials exist, else from the model's own estimate.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { LoggerLike } from "@flipsight/shared";
import { z } from "zod";

const DEFAULT_MODEL = "claude-sonnet-5";

export const ListingDraftSchema = z.object({
  title: z
    .string()
    .describe("eBay listing title, MAXIMUM 80 characters, keyword-dense: brand model variant key specs condition"),
  itemSpecifics: z
    .array(z.object({ name: z.string(), value: z.string() }))
    .describe("eBay item specifics (Brand, Model, Type, Color, Size, MPN, ...) inferred from photos/notes"),
  description: z
    .string()
    .describe("Full listing description: what it is, condition details visible in photos, what's included, shipping note"),
  condition: z
    .enum(["new", "open_box", "refurbished", "used_excellent", "used_good", "used_fair", "for_parts"])
    .describe("Condition judged from the photos and notes"),
  categorySuggestion: z.string().describe("Best-fit eBay category path, e.g. 'Consumer Electronics > Portable Audio'"),
  searchQuery: z.string().describe("Sold-comps search query for this exact product"),
  estimatedPriceRange: z
    .object({ low: z.number(), high: z.number() })
    .describe("Model's own resale estimate in USD, used when no comp data is available"),
  keywords: z.array(z.string()).describe("Extra search keywords worth working into the listing"),
});
export type ListingDraft = z.infer<typeof ListingDraftSchema>;

export interface ListingImageInput {
  /** https image URL (fetched by the API provider) ... */
  url?: string;
  /** ... or inline base64. */
  base64?: { mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif"; data: string };
}

export class ListingAssistant {
  private readonly client: Anthropic | null;
  readonly model: string;

  constructor(
    private readonly log: LoggerLike,
    options: { apiKey?: string; model?: string } = {},
  ) {
    const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
    this.client = apiKey ? new Anthropic({ apiKey }) : null;
    this.model = options.model ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL;
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  async draft(input: { notes: string; images: ListingImageInput[] }): Promise<ListingDraft | null> {
    if (!this.client) return null;
    const startedAt = Date.now();

    const imageBlocks: Anthropic.Messages.ImageBlockParam[] = [];
    for (const image of input.images.slice(0, 4)) {
      if (image.base64) {
        imageBlocks.push({
          type: "image",
          source: { type: "base64", media_type: image.base64.mediaType, data: image.base64.data },
        });
      } else if (image.url) {
        imageBlocks.push({ type: "image", source: { type: "url", url: image.url } });
      }
    }

    const response = await this.client.messages.parse({
      model: this.model,
      max_tokens: 4096,
      system:
        "You are an expert eBay lister. Draft listings that sell fast at strong prices: " +
        "titles are keyword-dense and NEVER exceed 80 characters (count them); item specifics are " +
        "complete; descriptions are honest about condition (call out every flaw visible in the " +
        "photos), scannable, and end with what's included. Never invent details the photos and " +
        "notes don't support.",
      messages: [
        {
          role: "user",
          content: [
            ...imageBlocks,
            {
              type: "text",
              text:
                `Seller notes: ${input.notes}\n\n` +
                "Draft the eBay listing from these photos and notes.",
            },
          ] satisfies Anthropic.Messages.ContentBlockParam[],
        },
      ],
      output_config: { format: zodOutputFormat(ListingDraftSchema) },
    });

    if (response.stop_reason === "refusal" || !response.parsed_output) {
      this.log.warn({ event: "listing_draft_unparsed", stopReason: response.stop_reason }, "listing draft failed");
      return null;
    }
    const draft = response.parsed_output;
    // Enforce the 80-char eBay hard limit even if the model overshoots.
    draft.title = draft.title.length > 80 ? draft.title.slice(0, 77).trimEnd() + "..." : draft.title;
    this.log.info(
      { event: "listing_drafted", model: this.model, durationMs: Date.now() - startedAt, images: imageBlocks.length },
      "listing draft generated",
    );
    return draft;
  }
}

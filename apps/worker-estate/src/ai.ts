/**
 * Anthropic-powered estate-sale analysis: extracts notable brands, item
 * categories, and a "worth attending" score with reasoning from a sale's
 * description text. Uses structured outputs (`messages.parse` + zod) so the
 * result is schema-validated — no prompt-format parsing.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { Logger } from "@flipsight/worker-core";
import { z } from "zod";

// The product spec calls for claude-sonnet for enrichment; override via env.
const DEFAULT_MODEL = "claude-sonnet-5";

export const EstateAnalysisSchema = z.object({
  notableBrands: z
    .array(z.string())
    .describe("High-resale-value brands explicitly mentioned (e.g. Snap-on, Herman Miller, McIntosh)"),
  categories: z
    .array(z.string())
    .describe("Item categories present at the sale (tools, vintage audio, furniture, jewelry, ...)"),
  worthAttendingScore: z
    .number()
    .min(0)
    .max(100)
    .describe("0-100: how promising this sale is for a reseller"),
  reasoning: z.string().describe("2-3 sentences explaining the score"),
  standoutItems: z.array(z.string()).describe("Up to 5 specific listed items with the highest resale potential"),
});
export type EstateAnalysis = z.infer<typeof EstateAnalysisSchema>;

export class EstateAnalyzer {
  private readonly client: Anthropic | null;
  readonly model: string;

  constructor(private readonly log: Logger) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    this.client = apiKey ? new Anthropic({ apiKey }) : null;
    this.model = process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL;
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  async analyze(input: {
    title: string;
    description: string;
    imageUrls: string[];
    watchBrands: string[];
  }): Promise<EstateAnalysis | null> {
    if (!this.client) return null;
    const startedAt = Date.now();
    try {
      const response = await this.client.messages.parse({
        model: this.model,
        max_tokens: 2048,
        system:
          "You evaluate estate sale listings for a reseller who flips items on eBay. " +
          "Ground every claim in the listing text; do not invent items or brands. " +
          `Brands this reseller especially watches for: ${input.watchBrands.join(", ")}. ` +
          "Score 0-100 for how worth attending the sale is: heavily weight watched or other " +
          "high-resale brands, vintage audio/tools/cameras/instruments, and large well-photographed " +
          "sales; score low for generic household goods and clothing-only sales.",
        messages: [
          {
            role: "user",
            content:
              `Estate sale listing:\n\nTITLE: ${input.title}\n\n` +
              `DESCRIPTION:\n${input.description.slice(0, 6000)}\n\n` +
              `PHOTO URLS (count only, content not shown): ${input.imageUrls.length} photos\n\n` +
              "Extract the notable brands, item categories, standout items, and score the sale.",
          },
        ],
        output_config: { format: zodOutputFormat(EstateAnalysisSchema) },
      });

      if (response.stop_reason === "refusal" || !response.parsed_output) {
        this.log.warn(
          { event: "estate_ai_unparsed", stopReason: response.stop_reason },
          "estate analysis returned no parsable output",
        );
        return null;
      }
      this.log.info(
        {
          event: "estate_ai_analyzed",
          model: this.model,
          durationMs: Date.now() - startedAt,
          score: response.parsed_output.worthAttendingScore,
          brands: response.parsed_output.notableBrands.slice(0, 5),
        },
        "estate sale analyzed",
      );
      return response.parsed_output;
    } catch (err) {
      this.log.warn(
        { event: "estate_ai_failed", err: err instanceof Error ? err.message : String(err) },
        "estate analysis failed — storing lead without AI enrichment",
      );
      return null;
    }
  }
}

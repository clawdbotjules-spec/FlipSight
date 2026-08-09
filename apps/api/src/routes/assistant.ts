/**
 * AI Listing Assistant: photos + a few words → a comp-optimized eBay listing
 * draft (≤80-char title, item specifics, description) plus a suggested price
 * from the comp engine (falling back to the model's own estimate). Returns
 * structured JSON for one-click copy in the UI.
 *
 * This route intentionally runs a long external AI call (seconds) — it is a
 * user-invoked tool with its own tight rate limit, not part of the <100ms
 * feed path.
 */
import {
  compsCacheKey,
  fetchComps,
  ListingAssistant,
  type CompsResult,
  type EbayClient,
} from "@flipsight/clients";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { errors } from "../lib/errors.js";

const ListingRequest = z.object({
  /** A few words about the item ("dewalt drill, works, comes with battery"). */
  notes: z.string().min(3).max(2000),
  /** Public https image URLs (e.g. photos already uploaded somewhere). */
  imageUrls: z.array(z.string().url().startsWith("https://")).max(4).default([]),
  /** Or inline photos as base64. */
  imagesBase64: z
    .array(
      z.object({
        mediaType: z.enum(["image/jpeg", "image/png", "image/webp", "image/gif"]),
        data: z.string().min(1).max(7_000_000), // ~5MB binary as base64
      }),
    )
    .max(4)
    .default([]),
  /** Optionally pull photos from an existing Item. */
  itemId: z.string().max(64).optional(),
});

export interface AssistantDeps {
  ebay: EbayClient;
}

export default function makeAssistantRoutes(deps: AssistantDeps) {
  return async function assistantRoutes(app: FastifyInstance) {
    const r = app.withTypeProvider<ZodTypeProvider>();
    r.addHook("onRequest", app.authenticate);

    const assistant = new ListingAssistant(app.log);

    r.post(
      "/listing",
      {
        config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
        schema: { body: ListingRequest },
      },
      async (req) => {
        if (!assistant.isConfigured()) {
          throw errors.serviceUnavailable("ANTHROPIC_API_KEY is not configured — the listing assistant needs it");
        }

        const images = [
          ...req.body.imageUrls.map((url) => ({ url })),
          ...req.body.imagesBase64.map((b) => ({ base64: b })),
        ];
        if (req.body.itemId) {
          const item = await app.prisma.item.findUnique({ where: { id: req.body.itemId } });
          if (!item) throw errors.notFound("Item not found");
          for (const url of item.imageUrls.slice(0, 4 - images.length)) {
            if (url.startsWith("https://")) images.push({ url });
          }
        }
        if (images.length === 0) {
          throw errors.badRequest("Provide at least one photo (imageUrls, imagesBase64, or itemId with images)");
        }

        const draft = await assistant.draft({ notes: req.body.notes, images });
        if (!draft) {
          throw errors.badRequest("The model could not produce a listing draft from these inputs");
        }

        // Price it: real sold comps when eBay credentials exist, else the
        // model's own estimate.
        let pricing: {
          suggested: number;
          low: number;
          high: number;
          basis: "ebay_sold_comps" | "ai_estimate";
          compsCount?: number;
        };
        let comps: CompsResult | null = null;
        if (deps.ebay.isConfigured()) {
          try {
            comps = await fetchComps(
              { ebay: deps.ebay, keepa: null, redis: app.redis, log: app.log },
              {
                canonicalName: draft.searchQuery,
                searchQuery: draft.searchQuery,
                daysBack: 90,
                cacheTtlSec: 24 * 3600,
              },
            );
          } catch (err) {
            app.log.warn({ err: (err as Error).message }, "comps lookup failed for listing assistant");
          }
        }
        if (comps) {
          pricing = {
            suggested: comps.estimatedResale,
            low: comps.resaleLow,
            high: comps.resaleHigh,
            basis: "ebay_sold_comps",
            compsCount: comps.soldCount,
          };
        } else {
          const mid = Math.round(((draft.estimatedPriceRange.low + draft.estimatedPriceRange.high) / 2) * 100) / 100;
          pricing = {
            suggested: mid,
            low: draft.estimatedPriceRange.low,
            high: draft.estimatedPriceRange.high,
            basis: "ai_estimate",
          };
        }

        return {
          draft: {
            title: draft.title,
            titleLength: draft.title.length,
            itemSpecifics: draft.itemSpecifics,
            description: draft.description,
            condition: draft.condition,
            categorySuggestion: draft.categorySuggestion,
            keywords: draft.keywords,
          },
          pricing,
          meta: {
            model: assistant.model,
            searchQuery: draft.searchQuery,
            compsCacheKey: compsCacheKey(draft.searchQuery),
          },
        };
      },
    );
  };
}

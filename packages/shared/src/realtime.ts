import { z } from "zod";
import { ALERT_CHANNELS, DEAL_STATUSES, SOURCE_KEYS } from "./constants.js";

/**
 * Payload published on the `deals:new` Redis channel by anything that creates
 * a Deal (source workers, the seed script). The API's realtime layer parses
 * this, matches it against connected users' alert rules, and fans out over
 * WebSocket. All money values are plain numbers (USD).
 */
export const DealAlertPayloadSchema = z.object({
  /** Epoch millis when the producer published — lets consumers measure latency. */
  publishedAt: z.number(),
  deal: z.object({
    id: z.string(),
    status: z.enum(DEAL_STATUSES),
    buyPrice: z.number(),
    estFees: z.number(),
    estShipping: z.number(),
    netProfit: z.number(),
    roiPct: z.number(),
    score: z.number(),
    createdAt: z.string(),
    item: z.object({
      id: z.string(),
      title: z.string(),
      category: z.string().nullable(),
      condition: z.string().nullable(),
      imageUrls: z.array(z.string()),
      sourceUrl: z.string(),
      currentPrice: z.number(),
      location: z.string().nullable(),
      sourceKey: z.enum(SOURCE_KEYS),
      /** ISO auction end time — lets the UI show live countdowns. */
      endsAt: z.string().nullable().optional(),
      bidsCount: z.number().nullable().optional(),
    }),
    valuation: z.object({
      id: z.string(),
      estimatedResale: z.number(),
      resaleLow: z.number(),
      resaleHigh: z.number(),
      soldCompsCount: z.number(),
      sellThroughRate: z.number().nullable(),
      compSource: z.string(),
    }),
    /** Engine extras: risk flags, fee/shipping breakdown, identity method… */
    meta: z.record(z.string(), z.unknown()).optional(),
  }),
});

export type DealAlertPayload = z.infer<typeof DealAlertPayloadSchema>;

/** Payload published on `rules:changed` after any alert-rule mutation. */
export const RulesChangedPayloadSchema = z.object({
  userId: z.string(),
});
export type RulesChangedPayload = z.infer<typeof RulesChangedPayloadSchema>;

/** Messages the API pushes to WebSocket clients. */
export const WsServerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    userId: z.string(),
    serverTime: z.number(),
  }),
  z.object({
    type: z.literal("deal.new"),
    publishedAt: z.number(),
    matchedRuleIds: z.array(z.string()),
    deal: DealAlertPayloadSchema.shape.deal,
  }),
]);
export type WsServerMessage = z.infer<typeof WsServerMessageSchema>;

export const wsChannels = {
  channel: z.enum(ALERT_CHANNELS),
};

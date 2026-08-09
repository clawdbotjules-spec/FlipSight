/**
 * Redis pub/sub channel names — the contract between deal producers
 * (workers, seed scripts) and consumers (the API's WebSocket fan-out,
 * future notification workers).
 */
export const DEALS_NEW_CHANNEL = "deals:new";

/**
 * Published whenever a user's alert rules change so every API instance
 * can invalidate its in-memory rule cache.
 */
export const RULES_CHANGED_CHANNEL = "rules:changed";

/** Alert delivery channels supported by AlertRule.channels. */
export const ALERT_CHANNELS = ["websocket", "discord", "pushover"] as const;
export type AlertChannelName = (typeof ALERT_CHANNELS)[number];

/** Canonical source keys — must match the Prisma SourceKey enum. */
export const SOURCE_KEYS = [
  "ebay",
  "keepa_amazon",
  "shopgoodwill",
  "walmart_clearance",
  "target_clearance",
  "estatesales",
] as const;
export type SourceKeyName = (typeof SOURCE_KEYS)[number];

export const DEAL_STATUSES = [
  "new",
  "alerted",
  "claimed",
  "dismissed",
  "purchased",
  "sold",
] as const;
export type DealStatusName = (typeof DEAL_STATUSES)[number];

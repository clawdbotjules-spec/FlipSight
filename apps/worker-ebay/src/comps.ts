/**
 * Sold-comps fetcher used by the valuation engine: queries sold/completed
 * items for a title or UPC, computes median / p25 / p75, and derives
 * sell-through from sold count vs active count. Results are cached in Redis
 * to conserve API quota.
 */
import { createHash } from "node:crypto";
import { computeCompStats } from "@flipsight/shared";
import type { Logger } from "@flipsight/worker-core";
import type { Redis } from "ioredis";
import type { EbayClient } from "./ebay-client.js";

export interface CompsResult {
  median: number;
  p25: number;
  p75: number;
  soldCount: number;
  activeCount: number;
  /** soldCount / (soldCount + activeCount), 0..1. */
  sellThroughRate: number;
}

export interface CompsQuery {
  title?: string;
  upc?: string;
  categoryIds?: string[];
  daysBack: number;
  cacheTtlSec: number;
}

/** Normalize a listing title into a comps search query. */
export function compsQueryFromTitle(title: string): string {
  return title
    .replace(/[^\w\s.&/-]/g, " ")
    .replace(/\b(lot of|bundle|untested|for parts|read|as[- ]is|nib|nwt)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 10)
    .join(" ");
}

export async function fetchSoldComps(
  deps: { client: EbayClient; redis: Redis; log: Logger },
  query: CompsQuery,
): Promise<CompsResult | null> {
  const q = query.upc ?? (query.title ? compsQueryFromTitle(query.title) : null);
  if (!q || q.length < 3) return null;

  const cacheKey = `comps:ebay:${createHash("sha1")
    .update(JSON.stringify([q, query.categoryIds ?? [], query.daysBack]))
    .digest("hex")}`;

  const cached = await deps.redis.get(cacheKey);
  if (cached) {
    deps.log.debug({ event: "comps_cache_hit", q }, "sold comps served from cache");
    return JSON.parse(cached) as CompsResult;
  }

  const sold = await deps.client.searchSoldComps({
    ...(query.upc ? { gtin: query.upc } : { q }),
    categoryIds: query.categoryIds,
    daysBack: query.daysBack,
  });
  const stats = computeCompStats(sold.prices);
  if (!stats) return null;

  const activeCount = await deps.client.countActive(query.upc ? { gtin: query.upc } : { q });
  const soldCount = sold.total;
  const sellThroughRate = soldCount / Math.max(1, soldCount + activeCount);

  const result: CompsResult = {
    median: stats.median,
    p25: stats.p25,
    p75: stats.p75,
    soldCount,
    activeCount,
    sellThroughRate: Math.round(sellThroughRate * 1000) / 1000,
  };
  await deps.redis.set(cacheKey, JSON.stringify(result), "EX", query.cacheTtlSec);
  deps.log.info(
    { event: "comps_fetched", q, soldCount, activeCount, median: result.median },
    "sold comps computed",
  );
  return result;
}

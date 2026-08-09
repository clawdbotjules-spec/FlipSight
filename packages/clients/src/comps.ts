/**
 * Comps engine: eBay sold comps (last 90 days, IQR-trimmed) merged with
 * Keepa history when an ASIN exists. Results cached in Redis for 24h keyed
 * by the normalized/canonical product name.
 */
import { createHash } from "node:crypto";
import {
  computeCompStats,
  computeWindowStats,
  parseKeepaSeries,
  trimOutliersIQR,
  type LoggerLike,
} from "@flipsight/shared";
import type { Redis } from "ioredis";
import { EbayAccessError, type EbayClient } from "./ebay.js";
import type { KeepaClient } from "./keepa.js";

export interface CompsResult {
  estimatedResale: number;
  resaleLow: number;
  resaleHigh: number;
  soldCount: number;
  activeCount: number;
  /** soldCount / (soldCount + activeCount), 0..1; null when unknown. */
  sellThroughRate: number | null;
  compSource: "ebay_sold" | "keepa";
  /** Raw prices considered (post-trim) — persisted for audit. */
  sampleSize: number;
  trimmedOutliers: number;
}

export interface CompsQuery {
  /** Canonical product name — the cache key (spec: 24h keyed by this). */
  canonicalName: string;
  searchQuery: string;
  upc?: string | null;
  asin?: string | null;
  categoryIds?: string[];
  daysBack: number;
  cacheTtlSec: number;
}

/** Normalize a listing title into a comps search query (fallback identifier). */
export function compsQueryFromTitle(title: string): string {
  return title
    .replace(/[^\w\s.&/-]/g, " ")
    .replace(/\b(lot of|bundle|untested|for parts|read|as[- ]is|nib|nwt|oem|new|used)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 10)
    .join(" ");
}

export function compsCacheKey(canonicalName: string): string {
  const normalized = canonicalName.trim().toLowerCase().replace(/\s+/g, " ");
  return `comps:v2:${createHash("sha1").update(normalized).digest("hex")}`;
}

export async function fetchComps(
  deps: { ebay: EbayClient; keepa?: KeepaClient | null; redis: Redis; log: LoggerLike },
  query: CompsQuery,
): Promise<CompsResult | null> {
  const cacheKey = compsCacheKey(query.canonicalName);
  const cached = await deps.redis.get(cacheKey);
  if (cached) {
    deps.log.info({ event: "comps_cache_hit", canonicalName: query.canonicalName }, "comps served from cache");
    return JSON.parse(cached) as CompsResult;
  }

  const result =
    (await ebayComps(deps, query)) ?? (await keepaComps(deps, query));
  if (result) {
    await deps.redis.set(cacheKey, JSON.stringify(result), "EX", query.cacheTtlSec);
  }
  return result;
}

async function ebayComps(
  deps: { ebay: EbayClient; log: LoggerLike },
  query: CompsQuery,
): Promise<CompsResult | null> {
  if (!deps.ebay.isConfigured()) return null;
  try {
    const sold = await deps.ebay.searchSoldComps({
      ...(query.upc ? { gtin: query.upc } : { q: query.searchQuery }),
      categoryIds: query.categoryIds,
      daysBack: query.daysBack,
    });
    const trimmed = trimOutliersIQR(sold.prices);
    const stats = computeCompStats(trimmed);
    if (!stats) return null;

    const activeCount = await deps.ebay.countActive(query.upc ? { gtin: query.upc } : { q: query.searchQuery });
    const soldCount = sold.total;
    const result: CompsResult = {
      estimatedResale: stats.median,
      resaleLow: stats.p25,
      resaleHigh: stats.p75,
      soldCount,
      activeCount,
      sellThroughRate: Math.round((soldCount / Math.max(1, soldCount + activeCount)) * 1000) / 1000,
      compSource: "ebay_sold",
      sampleSize: trimmed.length,
      trimmedOutliers: sold.prices.length - trimmed.length,
    };
    deps.log.info(
      {
        event: "comps_fetched",
        source: "ebay_sold",
        canonicalName: query.canonicalName,
        soldCount,
        activeCount,
        median: result.estimatedResale,
        trimmedOutliers: result.trimmedOutliers,
      },
      "sold comps computed",
    );
    return result;
  } catch (err) {
    if (err instanceof EbayAccessError) {
      deps.log.info({ event: "comps_ebay_unavailable" }, "eBay sold comps unavailable");
      return null;
    }
    throw err;
  }
}

async function keepaComps(
  deps: { keepa?: KeepaClient | null; log: LoggerLike },
  query: CompsQuery,
): Promise<CompsResult | null> {
  if (!query.asin || !deps.keepa?.isConfigured()) return null;
  const [product] = await deps.keepa.products([query.asin]);
  if (!product) return null;
  const series = parseKeepaSeries(product.csv?.[0] ?? product.csv?.[1]);
  const stats = computeWindowStats(series, query.daysBack);
  if (stats.median == null || stats.count < 3) return null;

  const result: CompsResult = {
    estimatedResale: stats.median,
    resaleLow: Math.round(stats.median * 0.85 * 100) / 100,
    resaleHigh: Math.round((stats.avg ?? stats.median) * 1.1 * 100) / 100,
    soldCount: 0,
    activeCount: 0,
    sellThroughRate: null,
    compSource: "keepa",
    sampleSize: stats.count,
    trimmedOutliers: 0,
  };
  deps.log.info(
    { event: "comps_fetched", source: "keepa", asin: query.asin, median: stats.median, samples: stats.count },
    "keepa comps computed",
  );
  return result;
}

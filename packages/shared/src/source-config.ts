/**
 * Zod schemas for per-source worker configuration (stored in `Source.config`)
 * and saved-search parameters (stored in `SavedSearch.params`). Workers parse
 * with these schemas (defaults fill gaps), and the API validates UI edits with
 * the same schemas, so both sides always agree.
 */
import { z } from "zod";
import type { SourceKeyName } from "./constants.js";

// --- eBay --------------------------------------------------------------------

export const EbaySourceConfigSchema = z.object({
  marketplaceId: z.string().default("EBAY_US"),
  /** Browse API calls per second (token bucket). */
  requestsPerSec: z.number().positive().default(1.5),
  burst: z.number().positive().default(3),
  sweeps: z
    .object({
      /** Saved keyword-set sweeps — spec: every 2–5 minutes. */
      savedSearchEverySec: z.number().int().min(30).default(180),
      endingSoonEverySec: z.number().int().min(30).default(120),
      newlyListedEverySec: z.number().int().min(30).default(180),
    })
    .prefault({}),
  endingSoon: z
    .object({
      withinMinutes: z.number().int().min(5).max(240).default(30),
      /** Only alert on auctions with at most this many bids. */
      maxBids: z.number().int().min(0).default(0),
      categoryIds: z.array(z.string()).default([]),
      minPrice: z.number().min(0).default(10),
      maxPrice: z.number().positive().default(5000),
    })
    .prefault({}),
  newlyListed: z
    .object({
      categoryIds: z.array(z.string()).default([]),
    })
    .prefault({}),
  search: z
    .object({
      maxQueriesPerSweep: z.number().int().min(1).default(15),
      maxMisspellingsPerBrand: z.number().int().min(1).default(8),
      resultLimitPerQuery: z.number().int().min(1).max(200).default(50),
    })
    .prefault({}),
  valuation: z
    .object({
      minComps: z.number().int().min(1).default(3),
      minNetProfit: z.number().default(10),
      minRoiPct: z.number().default(20),
      compsCacheTtlSec: z.number().int().default(6 * 3600),
      estShippingDefault: z.number().default(12.99),
      compsDaysBack: z.number().int().min(7).max(90).default(90),
    })
    .prefault({}),
});
export type EbaySourceConfig = z.infer<typeof EbaySourceConfigSchema>;

export const EbaySearchParamsSchema = z.object({
  kind: z.literal("keywords").default("keywords"),
  /** Exact query strings to sweep. */
  keywords: z.array(z.string().min(1)).default([]),
  /** Brand terms expanded into misspelling variants programmatically. */
  brands: z.array(z.string().min(1)).default([]),
  categoryIds: z.array(z.string()).default([]),
  minPrice: z.number().min(0).optional(),
  maxPrice: z.number().positive().optional(),
  buyingOption: z.enum(["AUCTION", "FIXED_PRICE", "ANY"]).default("ANY"),
});
export type EbaySearchParams = z.infer<typeof EbaySearchParamsSchema>;

// --- Keepa / Amazon ----------------------------------------------------------

export const KeepaSourceConfigSchema = z.object({
  /** Keepa domain id (1 = amazon.com). */
  domain: z.number().int().default(1),
  /** Keepa token budget per minute (their API is token metered). */
  tokensPerMin: z.number().positive().default(18),
  sweeps: z
    .object({
      watchlistEverySec: z.number().int().min(60).default(600),
      bestsellersEverySec: z.number().int().min(300).default(3600),
    })
    .prefault({}),
  batchSize: z.number().int().min(1).max(100).default(20),
  /** Alert when current price drops more than this % below the 90-day average. */
  priceDropPctBelowAvg90: z.number().min(1).max(95).default(30),
  /** "Amazon pricing error" candidate: price below this % of the 90-day median. */
  pricingErrorPctOfMedian90: z.number().min(1).max(95).default(40),
  valuation: z
    .object({
      minNetProfit: z.number().default(10),
      minRoiPct: z.number().default(20),
      /** Haircut applied to median90 when estimating resale value. */
      resaleDiscountPct: z.number().min(0).max(50).default(5),
    })
    .prefault({}),
});
export type KeepaSourceConfig = z.infer<typeof KeepaSourceConfigSchema>;

export const KeepaSearchParamsSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("asin_watchlist"),
    asins: z.array(z.string().regex(/^[A-Z0-9]{10}$/i)).default([]),
  }),
  z.object({
    kind: z.literal("bestsellers"),
    categoryId: z.number().int(),
    rankFrom: z.number().int().min(1).default(1),
    rankTo: z.number().int().min(1).default(50),
  }),
]);
export type KeepaSearchParams = z.infer<typeof KeepaSearchParamsSchema>;

// --- ShopGoodwill ------------------------------------------------------------

export const GoodwillSourceConfigSchema = z.object({
  /** Spec: 1 request per 2–3 s. 0.4/s ≈ one request every 2.5 s. */
  requestsPerSec: z.number().positive().max(1).default(0.4),
  sweepEverySec: z.number().int().min(60).default(300),
  pageSize: z.number().int().min(10).max(100).default(40),
  maxPagesPerCategory: z.number().int().min(1).max(10).default(2),
  minPrice: z.number().min(0).default(5),
  /**
   * Keyless discovery: when enabled (the default), each sweep scans the global
   * ShopGoodwill catalog sorted ending-soonest instead of the DB-driven
   * category SavedSearches — no keyword lists to curate. The valuation engine
   * decides what's profitable. Turn off to use targeted category subscriptions.
   */
  discover: z
    .object({
      enabled: z.boolean().default(true),
      /** Pages of the ending-soonest global catalog to scan each sweep. */
      maxPagesPerSweep: z.number().int().min(1).max(40).default(10),
    })
    .prefault({}),
  /** Extra randomized delay between requests, on top of the token bucket. */
  jitterMs: z.object({ min: z.number().default(400), max: z.number().default(1400) }).prefault({}),
  /**
   * robots.txt handling per host. buyerapi.shopgoodwill.com serves a blanket
   * `Disallow: /` aimed at search-engine indexers, while being the public data
   * API behind shopgoodwill.com itself. Default "warn" fetches politely but
   * logs the conflict loudly; set to "enforce" to hard-disable those fetches.
   */
  robotsPolicy: z.record(z.string(), z.enum(["enforce", "warn", "off"])).default({
    "buyerapi.shopgoodwill.com": "warn",
  }),
});
export type GoodwillSourceConfig = z.infer<typeof GoodwillSourceConfigSchema>;

export const GoodwillSearchParamsSchema = z.object({
  kind: z.literal("category").default("category"),
  catId: z.number().int(),
  /** Canonical category label stored on items (e.g. "Electronics"). */
  label: z.string().min(1),
});
export type GoodwillSearchParams = z.infer<typeof GoodwillSearchParamsSchema>;

// --- Retail (Walmart / Target) ----------------------------------------------

export const RetailSourceConfigSchema = z.object({
  sweepEverySec: z.number().int().min(120).default(900),
  requestsPerSec: z.number().positive().default(0.5),
  /** Clearance = current price below this % of MSRP/list price. */
  clearanceThresholdPct: z.number().min(1).max(99).default(50),
  homeZip: z.string().regex(/^\d{5}$/).default("32114"),
  /** Store IDs near the home ZIP for per-store inventory checks. */
  storeIds: z.array(z.string()).default([]),
  categories: z
    .array(z.object({ id: z.string(), name: z.string() }))
    .default([]),
  /** Target's public web API key (redsky); overridable when they rotate it. */
  apiKey: z.string().optional(),
  minPrice: z.number().min(0).default(5),
  maxItemsPerSweep: z.number().int().min(1).default(200),
});
export type RetailSourceConfig = z.infer<typeof RetailSourceConfigSchema>;

// --- Estate sales ------------------------------------------------------------

export const EstateSourceConfigSchema = z.object({
  sweepEverySec: z.number().int().min(300).default(3600),
  requestsPerSec: z.number().positive().max(1).default(0.33),
  zip: z.string().regex(/^\d{5}$/).default("32114"),
  radiusMiles: z.number().int().min(5).max(250).default(50),
  /** estatesales.net region path segments for the area page. */
  region: z.object({ state: z.string().default("FL"), city: z.string().default("Daytona-Beach") }).prefault({}),
  /** Additional RSS feed URLs to poll (e.g. HiBid zip searches). */
  rssFeeds: z.array(z.string().url()).default([]),
  maxSalesPerSweep: z.number().int().min(1).max(50).default(10),
  ai: z
    .object({
      enabled: z.boolean().default(true),
      maxAnalysesPerSweep: z.number().int().min(0).default(5),
      /** Brands whose presence should boost the worth-attending score. */
      watchBrands: z
        .array(z.string())
        .default([
          "Snap-on",
          "Herman Miller",
          "McIntosh",
          "Marantz",
          "Pioneer",
          "Sansui",
          "Rolex",
          "Omega",
          "Milwaukee",
          "Festool",
          "Le Creuset",
          "Vitamix",
        ]),
    })
    .prefault({}),
});
export type EstateSourceConfig = z.infer<typeof EstateSourceConfigSchema>;

// --- Registry ----------------------------------------------------------------

export const SOURCE_CONFIG_SCHEMAS: Record<SourceKeyName, z.ZodTypeAny> = {
  ebay: EbaySourceConfigSchema,
  keepa_amazon: KeepaSourceConfigSchema,
  shopgoodwill: GoodwillSourceConfigSchema,
  walmart_clearance: RetailSourceConfigSchema,
  target_clearance: RetailSourceConfigSchema,
  estatesales: EstateSourceConfigSchema,
};

/** Saved-search `params` schemas per source (sources without searches omitted). */
export const SAVED_SEARCH_PARAMS_SCHEMAS: Partial<Record<SourceKeyName, z.ZodTypeAny>> = {
  ebay: EbaySearchParamsSchema,
  keepa_amazon: KeepaSearchParamsSchema,
  shopgoodwill: GoodwillSearchParamsSchema,
};

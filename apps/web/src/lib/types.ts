/**
 * Client-side mirrors of the API's JSON contracts. The server side is the
 * source of truth (zod-validated in `@flipsight/shared` + the API routes);
 * keep these in sync when those DTOs change. They are deliberately plain
 * interfaces so no server code is bundled into the browser.
 */

export type SourceKey =
  | "ebay"
  | "keepa_amazon"
  | "shopgoodwill"
  | "walmart_clearance"
  | "target_clearance"
  | "estatesales";

export type DealStatus = "new" | "alerted" | "claimed" | "dismissed" | "purchased" | "sold";

export interface DealItem {
  id: string;
  title: string;
  category: string | null;
  condition: string | null;
  imageUrls: string[];
  sourceUrl: string;
  currentPrice: number;
  location: string | null;
  sourceKey: SourceKey;
  endsAt?: string | null;
  bidsCount?: number | null;
}

export interface DealValuation {
  id: string;
  estimatedResale: number;
  resaleLow: number;
  resaleHigh: number;
  soldCompsCount: number;
  sellThroughRate: number | null;
  compSource: string;
}

export interface ScoreBreakdown {
  score: number;
  profitPts: number;
  roiPts: number;
  sellThroughPts: number;
  compConfidencePts: number;
  timePressurePts: number;
  riskPenalty: number;
}

export interface DealMeta {
  identity?: { canonicalName?: string; method?: string; aiConfidence?: number | null; demo?: boolean };
  fees?: { pct: number; fixed: number; matchedCategory: string | null };
  shipping?: { cost: number; rule: string };
  riskFlags?: string[];
  scoreBreakdown?: ScoreBreakdown;
  comps?: { source?: string; sampleSize?: number; trimmedOutliers?: number; activeCount?: number };
}

export interface Deal {
  id: string;
  status: DealStatus;
  buyPrice: number;
  estFees: number;
  estShipping: number;
  netProfit: number;
  roiPct: number;
  score: number;
  createdAt: string;
  item: DealItem;
  valuation: DealValuation;
  meta?: DealMeta;
}

export interface WsDealMessage {
  type: "deal.new";
  publishedAt: number;
  matchedRuleIds: string[];
  deal: Deal;
}

export interface PricePoint {
  capturedAt: string;
  price: number;
  stats: Record<string, unknown>;
}

export interface AlertRule {
  id: string;
  name: string;
  minProfit: number | null;
  minRoi: number | null;
  maxBuyPrice: number | null;
  categories: string[];
  keywords: string[];
  excludeKeywords: string[];
  localOnly: boolean;
  channels: string[];
  enabled: boolean;
}

export interface RulePreview {
  since: string;
  sampled: number;
  matched: number;
  examples: Array<{ id: string; title: string; netProfit: number; score: number }>;
}

export interface SourceInfo {
  key: SourceKey;
  name: string;
  enabled: boolean;
  config: Record<string, unknown>;
  savedSearches: number;
  itemsTotal: number;
  itemsLast24h: number;
  updatedAt: string;
}

export interface SavedSearch {
  id: string;
  sourceKey: SourceKey;
  name: string;
  enabled: boolean;
  params: Record<string, unknown>;
}

export interface LedgerAnalytics {
  realized: { today: number; week: number; month: number; allTime: number };
  cumulative: Array<{ day: string; profit: number; cumulative: number }>;
  roiBySource: Array<{ name: string; profit: number; roiPct: number; flips: number }>;
  roiByCategory: Array<{ name: string; profit: number; roiPct: number; flips: number }>;
  inventory: Array<{
    id: string;
    dealId: string;
    title: string;
    sourceKey: SourceKey;
    category: string | null;
    purchasePrice: number;
    purchasedAt: string;
    daysHeld: number;
    estimatedResale: number;
    imageUrl: string | null;
  }>;
  avgDaysToSell: number | null;
  soldCount: number;
  activeCount: number;
  activeCostBasis: number;
}

export interface WorkerStatus {
  name: string;
  queue: string;
  sources: string[];
  enabled: boolean;
  lastActivityAt: string | null;
  itemsLastHour: number;
  items24h: number;
  sparkline: number[];
  counts: { waiting: number; active: number; delayed: number; failed: number; completed: number } | null;
}

export interface SystemStatus {
  generatedAt: string;
  workers: WorkerStatus[];
  valuationsLastHour: number;
  dealsLast24h: number;
  alerts24h: Record<string, number>;
  deadLetter: {
    counts: { waiting: number; delayed: number; failed: number } | null;
    recent: Array<{ name: string; failedAt: string | null; data: Record<string, unknown> }>;
  };
}

export interface ListingDraftResponse {
  draft: {
    title: string;
    titleLength: number;
    itemSpecifics: Array<{ name: string; value: string }>;
    description: string;
    condition: string;
    categorySuggestion: string;
    keywords: string[];
  };
  pricing: { suggested: number; low: number; high: number; basis: string; compsCount?: number };
  meta: { model: string; searchQuery: string };
}

export const SOURCE_LABELS: Record<SourceKey, string> = {
  ebay: "eBay",
  keepa_amazon: "Amazon",
  shopgoodwill: "Goodwill",
  walmart_clearance: "Walmart",
  target_clearance: "Target",
  estatesales: "Estate",
};

export const SOURCE_COLORS: Record<SourceKey, string> = {
  ebay: "#22d3ee",
  keepa_amazon: "#fbbf24",
  shopgoodwill: "#a78bfa",
  walmart_clearance: "#60a5fa",
  target_clearance: "#fb7185",
  estatesales: "#34d399",
};

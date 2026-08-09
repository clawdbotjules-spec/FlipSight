/**
 * Deal economics — fee/shipping estimation and 0–100 deal scoring.
 * Pure functions shared by valuation workers and seed scripts so every
 * producer computes profit the same way.
 */

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/**
 * Estimated eBay selling fees for a given sale price: ~13.6% final value fee
 * plus the $0.30 per-order fee (spec defaults). The valuation engine uses the
 * per-category fee schedule from AppSetting "fees" (see settings-config.ts);
 * this flat helper backs seeds and sources without category context.
 */
export function estimateEbayFees(salePrice: number, opts: { pct?: number; fixed?: number } = {}): number {
  if (salePrice <= 0) return 0;
  return round2(salePrice * ((opts.pct ?? 13.6) / 100) + (opts.fixed ?? 0.3));
}

export interface DealEconomicsInput {
  buyPrice: number;
  estimatedResale: number;
  /** Estimated outbound shipping cost in USD. Defaults to a flat $12.99. */
  estShipping?: number;
  /** Override fee estimate; defaults to eBay fees on the estimated resale. */
  estFees?: number;
}

export interface DealEconomics {
  buyPrice: number;
  estFees: number;
  estShipping: number;
  netProfit: number;
  roiPct: number;
}

export function computeDealEconomics(input: DealEconomicsInput): DealEconomics {
  const buyPrice = round2(input.buyPrice);
  const estFees = round2(input.estFees ?? estimateEbayFees(input.estimatedResale));
  const estShipping = round2(input.estShipping ?? 12.99);
  const netProfit = round2(input.estimatedResale - buyPrice - estFees - estShipping);
  const roiPct = buyPrice > 0 ? round2((netProfit / buyPrice) * 100) : 0;
  return { buyPrice, estFees, estShipping, netProfit, roiPct };
}

export interface ScoreInput {
  netProfit: number;
  roiPct: number;
  /** 0..1 — fraction of active listings that sell. Null when unknown. */
  sellThroughRate?: number | null;
  /** Number of sold comps backing the valuation. Null when unknown. */
  soldCompsCount?: number | null;
}

/**
 * Score a deal 0–100. Weights: absolute profit 40, ROI 30, sell-through 20,
 * comp-count confidence 10. $100+ profit and 200%+ ROI max their buckets;
 * negative profit drags the score toward 0.
 */
export function scoreDeal(input: ScoreInput): number {
  const profitPts = Math.min(input.netProfit / 100, 1) * 40;
  const roiPts = Math.min(input.roiPct / 200, 1) * 30;
  const strPts = clamp(input.sellThroughRate ?? 0.5, 0, 1) * 20;
  const compPts = Math.min((input.soldCompsCount ?? 0) / 25, 1) * 10;
  return Math.round(clamp(profitPts + roiPts + strPts + compPts, 0, 100));
}

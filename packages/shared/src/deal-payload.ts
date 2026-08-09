/**
 * Builds the `deals:new` payload from plain values. Producers (workers, seed
 * scripts) convert their DB rows to these inputs so every publisher emits the
 * exact shape `DealAlertPayloadSchema` expects.
 */
import type { DealStatusName, SourceKeyName } from "./constants.js";
import type { DealAlertPayload } from "./realtime.js";

export interface DealPayloadInput {
  deal: {
    id: string;
    status: DealStatusName;
    buyPrice: number;
    estFees: number;
    estShipping: number;
    netProfit: number;
    roiPct: number;
    score: number;
    createdAt: Date;
  };
  item: {
    id: string;
    title: string;
    category: string | null;
    condition: string | null;
    imageUrls: string[];
    sourceUrl: string;
    currentPrice: number;
    location: string | null;
    sourceKey: SourceKeyName;
  };
  valuation: {
    id: string;
    estimatedResale: number;
    resaleLow: number;
    resaleHigh: number;
    soldCompsCount: number;
    sellThroughRate: number | null;
    compSource: string;
  };
  /** Optional engine extras (risk flags, fee/shipping breakdown, identity). */
  meta?: Record<string, unknown>;
}

export function buildDealAlertPayload(input: DealPayloadInput): DealAlertPayload {
  return {
    publishedAt: Date.now(),
    deal: {
      id: input.deal.id,
      status: input.deal.status,
      buyPrice: input.deal.buyPrice,
      estFees: input.deal.estFees,
      estShipping: input.deal.estShipping,
      netProfit: input.deal.netProfit,
      roiPct: input.deal.roiPct,
      score: input.deal.score,
      createdAt: input.deal.createdAt.toISOString(),
      item: { ...input.item },
      valuation: { ...input.valuation },
      ...(input.meta ? { meta: input.meta } : {}),
    },
  };
}

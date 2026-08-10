/**
 * DTO mappers — convert Prisma rows (Decimal money, Date timestamps) into the
 * plain-JSON shapes the API returns. Money is always a number in USD.
 */
import { dec, decN, type AlertRule, type Org, type Prisma, type User } from "@flipsight/db";

export type DealWithRelations = Prisma.DealGetPayload<{
  include: { item: { include: { source: true } }; valuation: true };
}>;

export type LedgerWithDeal = Prisma.FlipLedgerGetPayload<{
  include: { deal: { include: { item: true } } };
}>;

export function toUserDTO(user: User) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    orgId: user.orgId,
    createdAt: user.createdAt.toISOString(),
  };
}

export function toOrgDTO(org: Org) {
  return {
    id: org.id,
    name: org.name,
    createdAt: org.createdAt.toISOString(),
  };
}

export function toRuleDTO(rule: AlertRule) {
  return {
    id: rule.id,
    name: rule.name,
    minProfit: dec(rule.minProfit),
    minRoi: rule.minRoi,
    maxBuyPrice: dec(rule.maxBuyPrice),
    categories: rule.categories,
    keywords: rule.keywords,
    excludeKeywords: rule.excludeKeywords,
    localOnly: rule.localOnly,
    channels: rule.channels,
    enabled: rule.enabled,
    createdAt: rule.createdAt.toISOString(),
    updatedAt: rule.updatedAt.toISOString(),
  };
}

export function toDealDTO(deal: DealWithRelations) {
  return {
    id: deal.id,
    status: deal.status,
    buyPrice: decN(deal.buyPrice),
    estFees: decN(deal.estFees),
    estShipping: decN(deal.estShipping),
    netProfit: decN(deal.netProfit),
    roiPct: deal.roiPct,
    score: deal.score,
    userId: deal.userId,
    createdAt: deal.createdAt.toISOString(),
    updatedAt: deal.updatedAt.toISOString(),
    item: {
      id: deal.item.id,
      title: deal.item.title,
      category: deal.item.category,
      condition: deal.item.condition,
      upc: deal.item.upc,
      isbn: deal.item.isbn,
      asin: deal.item.asin,
      imageUrls: deal.item.imageUrls,
      sourceUrl: deal.item.sourceUrl,
      currentPrice: decN(deal.item.currentPrice),
      currency: deal.item.currency,
      location: deal.item.location,
      sourceKey: deal.item.source.key,
      endsAt: deal.item.endsAt ? deal.item.endsAt.toISOString() : null,
      bidsCount: deal.item.bidsCount,
      firstSeenAt: deal.item.firstSeenAt.toISOString(),
    },
    valuation: {
      id: deal.valuation.id,
      estimatedResale: decN(deal.valuation.estimatedResale),
      resaleLow: decN(deal.valuation.resaleLow),
      resaleHigh: decN(deal.valuation.resaleHigh),
      soldCompsCount: deal.valuation.soldCompsCount,
      sellThroughRate: deal.valuation.sellThroughRate,
      compSource: deal.valuation.compSource,
      computedAt: deal.valuation.computedAt.toISOString(),
    },
    // Engine breakdown (fees/shipping/score/risk flags) — null-ish for
    // pre-engine seed deals.
    meta: (deal.meta ?? {}) as Record<string, unknown>,
  };
}

export function toLedgerDTO(entry: LedgerWithDeal) {
  return {
    id: entry.id,
    dealId: entry.dealId,
    itemTitle: entry.deal.item.title,
    purchasePrice: decN(entry.purchasePrice),
    purchasedAt: entry.purchasedAt.toISOString(),
    salePrice: dec(entry.salePrice),
    fees: dec(entry.fees),
    shipping: dec(entry.shipping),
    soldAt: entry.soldAt ? entry.soldAt.toISOString() : null,
    realizedProfit: dec(entry.realizedProfit),
    createdAt: entry.createdAt.toISOString(),
    updatedAt: entry.updatedAt.toISOString(),
  };
}

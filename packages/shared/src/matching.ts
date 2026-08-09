/**
 * Alert-rule matching — the single source of truth for "does this deal match
 * this rule". Used by the API's WebSocket fan-out today and by the
 * discord/pushover notification workers in later phases, so both must agree.
 */

export interface RuleForMatch {
  enabled: boolean;
  /** Minimum net profit in USD, or null for no floor. */
  minProfit: number | null;
  /** Minimum ROI percent (e.g. 50 = 50%), or null for no floor. */
  minRoi: number | null;
  /** Maximum buy price in USD, or null for no cap. */
  maxBuyPrice: number | null;
  /** Case-insensitive category allow-list; empty = all categories. */
  categories: string[];
  /** Case-insensitive title keywords; empty = match all, else at least one must appear. */
  keywords: string[];
  /** Case-insensitive title keywords that disqualify a deal. */
  excludeKeywords: string[];
  /** When true, only match items that have a pickup location. */
  localOnly: boolean;
}

export interface DealForMatch {
  buyPrice: number;
  netProfit: number;
  roiPct: number;
  item: {
    title: string;
    category: string | null;
    location: string | null;
  };
}

export function dealMatchesRule(deal: DealForMatch, rule: RuleForMatch): boolean {
  if (!rule.enabled) return false;
  if (rule.minProfit != null && deal.netProfit < rule.minProfit) return false;
  if (rule.minRoi != null && deal.roiPct < rule.minRoi) return false;
  if (rule.maxBuyPrice != null && deal.buyPrice > rule.maxBuyPrice) return false;
  if (rule.localOnly && !deal.item.location) return false;

  if (rule.categories.length > 0) {
    const category = deal.item.category?.trim().toLowerCase();
    if (!category) return false;
    if (!rule.categories.some((c) => c.trim().toLowerCase() === category)) return false;
  }

  const title = deal.item.title.toLowerCase();
  if (rule.keywords.length > 0) {
    if (!rule.keywords.some((k) => title.includes(k.trim().toLowerCase()))) return false;
  }
  if (rule.excludeKeywords.some((k) => k.trim() !== "" && title.includes(k.trim().toLowerCase()))) {
    return false;
  }

  return true;
}

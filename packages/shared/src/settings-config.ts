/**
 * Zod schemas for app-level settings stored in the AppSetting table and
 * edited through `PUT /settings/:key`. The valuation worker parses with the
 * same schemas, so UI edits are always structurally valid.
 */
import { z } from "zod";

/** Marketplace fee schedule: ~13.6% + $0.30 by default, overridable per category. */
export const FeeScheduleSchema = z.object({
  default: z
    .object({
      pct: z.number().min(0).max(100).default(13.6),
      fixed: z.number().min(0).max(10).default(0.3),
    })
    .prefault({}),
  /** Category name (case-insensitive substring match) → fee override. */
  perCategory: z
    .record(z.string(), z.object({ pct: z.number().min(0).max(100), fixed: z.number().min(0).max(10) }))
    .default({}),
});
export type FeeSchedule = z.infer<typeof FeeScheduleSchema>;

/** Weight/category-based shipping estimate lookup table. */
export const ShippingTableSchema = z.object({
  defaultCost: z.number().min(0).default(12.99),
  /** Applied when the item has a known weight (raw.weightOz), first match wins. */
  weightTiers: z
    .array(z.object({ maxOz: z.number().positive(), cost: z.number().min(0) }))
    .default([]),
  /** Case-insensitive substring match on the item category, first match wins. */
  categoryRules: z
    .array(z.object({ match: z.string().min(1), cost: z.number().min(0) }))
    .default([]),
});
export type ShippingTable = z.infer<typeof ShippingTableSchema>;

/** Valuation engine configuration. */
export const ValuationConfigSchema = z.object({
  /** Create a Deal when score >= this. */
  scoreThreshold: z.number().min(0).max(100).default(55),
  minNetProfit: z.number().default(5),
  minComps: z.number().int().min(1).default(3),
  compsDaysBack: z.number().int().min(7).max(90).default(90),
  /** Spec: cache comps for 24h keyed by normalized product name. */
  compsCacheTtlSec: z.number().int().min(60).default(24 * 3600),
  /** Use the Anthropic API to normalize titles without UPC/ASIN/ISBN. */
  identifyWithAI: z.boolean().default(true),
  maxAiIdentificationsPerHour: z.number().int().min(0).default(60),
  /**
   * Dev convenience: items carrying raw.demoComps (from `npm run seed:item`)
   * are valued from those embedded prices when no eBay credentials exist.
   * Disable in production.
   */
  allowDemoComps: z.boolean().default(true),
  notifications: z
    .object({
      discordEnabled: z.boolean().default(true),
      pushoverEnabled: z.boolean().default(true),
    })
    .prefault({}),
});
export type ValuationConfig = z.infer<typeof ValuationConfigSchema>;

export const APP_SETTING_SCHEMAS = {
  fees: FeeScheduleSchema,
  shipping: ShippingTableSchema,
  valuation: ValuationConfigSchema,
} as const;
export type AppSettingKey = keyof typeof APP_SETTING_SCHEMAS;
export const APP_SETTING_KEYS = Object.keys(APP_SETTING_SCHEMAS) as AppSettingKey[];

// --- Resolution helpers (unit-tested) ---------------------------------------

export interface FeeResolution {
  pct: number;
  fixed: number;
  fees: number;
  matchedCategory: string | null;
}

/** Fees for selling at `salePrice` in `category` under `schedule`. */
export function resolveFees(salePrice: number, category: string | null, schedule: FeeSchedule): FeeResolution {
  let pct = schedule.default.pct;
  let fixed = schedule.default.fixed;
  let matchedCategory: string | null = null;
  if (category) {
    const lower = category.toLowerCase();
    for (const [name, override] of Object.entries(schedule.perCategory)) {
      if (lower.includes(name.toLowerCase())) {
        pct = override.pct;
        fixed = override.fixed;
        matchedCategory = name;
        break;
      }
    }
  }
  const fees = salePrice > 0 ? Math.round((salePrice * (pct / 100) + fixed) * 100) / 100 : 0;
  return { pct, fixed, fees, matchedCategory };
}

export interface ShippingResolution {
  cost: number;
  rule: string;
}

/** Shipping estimate: weight tier (when weight known) → category rule → default. */
export function resolveShipping(
  input: { category: string | null; weightOz?: number | null },
  table: ShippingTable,
): ShippingResolution {
  if (input.weightOz != null && input.weightOz > 0) {
    const tiers = [...table.weightTiers].sort((a, b) => a.maxOz - b.maxOz);
    for (const tier of tiers) {
      if (input.weightOz <= tier.maxOz) {
        return { cost: tier.cost, rule: `weight<=${tier.maxOz}oz` };
      }
    }
  }
  if (input.category) {
    const lower = input.category.toLowerCase();
    for (const rule of table.categoryRules) {
      if (lower.includes(rule.match.toLowerCase())) {
        return { cost: rule.cost, rule: `category:${rule.match}` };
      }
    }
  }
  return { cost: table.defaultCost, rule: "default" };
}

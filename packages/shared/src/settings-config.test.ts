import { describe, expect, it } from "vitest";
import {
  FeeScheduleSchema,
  resolveFees,
  resolveShipping,
  ShippingTableSchema,
} from "./settings-config.js";

const schedule = FeeScheduleSchema.parse({
  perCategory: {
    "Musical Instruments": { pct: 6.35, fixed: 0.3 },
    Shoes: { pct: 8, fixed: 0.3 },
  },
});

describe("resolveFees", () => {
  it("applies the default 13.6% + $0.30", () => {
    const fee = resolveFees(100, "Consumer Electronics", schedule);
    expect(fee.pct).toBe(13.6);
    expect(fee.fixed).toBe(0.3);
    expect(fee.fees).toBe(13.9);
    expect(fee.matchedCategory).toBeNull();
  });

  it("matches per-category overrides case-insensitively by substring", () => {
    const fee = resolveFees(200, "Vintage Musical Instruments > Guitars", schedule);
    expect(fee.pct).toBe(6.35);
    expect(fee.fees).toBe(13.0); // 200 * 0.0635 + 0.30
    expect(fee.matchedCategory).toBe("Musical Instruments");
  });

  it("handles null category and non-positive prices", () => {
    expect(resolveFees(150, null, schedule).fees).toBe(20.7); // 150*0.136+0.30
    expect(resolveFees(0, "Shoes", schedule).fees).toBe(0);
  });

  it("rounds to cents", () => {
    // 149.99 * 0.136 + 0.30 = 20.69864 → 20.7
    expect(resolveFees(149.99, null, schedule).fees).toBe(20.7);
  });
});

const table = ShippingTableSchema.parse({
  defaultCost: 12.99,
  weightTiers: [
    { maxOz: 8, cost: 4.99 },
    { maxOz: 16, cost: 6.99 },
    { maxOz: 80, cost: 12.99 },
  ],
  categoryRules: [
    { match: "Instruments", cost: 24.99 },
    { match: "Tools", cost: 16.99 },
  ],
});

describe("resolveShipping", () => {
  it("prefers weight tiers when weight is known (first fitting tier)", () => {
    expect(resolveShipping({ category: "Tools", weightOz: 6 }, table)).toEqual({
      cost: 4.99,
      rule: "weight<=8oz",
    });
    expect(resolveShipping({ category: null, weightOz: 12 }, table).cost).toBe(6.99);
  });

  it("falls through to category rules when weight is unknown or exceeds tiers", () => {
    expect(resolveShipping({ category: "Power Tools", weightOz: null }, table)).toEqual({
      cost: 16.99,
      rule: "category:Tools",
    });
    expect(resolveShipping({ category: "Musical Instruments", weightOz: 999 }, table).cost).toBe(24.99);
  });

  it("uses the default when nothing matches", () => {
    expect(resolveShipping({ category: "Kitchen" }, table)).toEqual({ cost: 12.99, rule: "default" });
  });
});

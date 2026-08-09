import { describe, expect, it } from "vitest";
import { detectRiskFlags, scoreDealV2, timePressurePoints } from "./scoring.js";
import { trimOutliersIQR } from "./stats.js";

const NOW = 1_700_000_000_000;
const minutes = (n: number) => new Date(NOW + n * 60_000);

describe("timePressurePoints", () => {
  it("gives no boost outside the final hour or after end", () => {
    expect(timePressurePoints(minutes(90), NOW)).toBe(0);
    expect(timePressurePoints(minutes(-5), NOW)).toBe(0);
    expect(timePressurePoints(null, NOW)).toBe(0);
  });

  it("scales up to +10 as the auction closes", () => {
    expect(timePressurePoints(minutes(5), NOW)).toBe(10);
    const at30 = timePressurePoints(minutes(30), NOW);
    expect(at30).toBeGreaterThan(4);
    expect(at30).toBeLessThan(8);
    expect(timePressurePoints(minutes(59), NOW)).toBeLessThan(1.5);
  });
});

describe("scoreDealV2", () => {
  const base = { netProfit: 60, roiPct: 100, sellThroughRate: 0.8, soldCompsCount: 25, now: NOW };

  it("produces a full breakdown that sums to the score", () => {
    const b = scoreDealV2(base);
    const sum = b.profitPts + b.roiPts + b.sellThroughPts + b.compConfidencePts + b.timePressurePts - b.riskPenalty;
    expect(b.score).toBe(Math.round(sum));
    expect(b.compConfidencePts).toBe(15); // 25 comps maxes confidence
  });

  it("boosts auctions ending soon", () => {
    const without = scoreDealV2(base).score;
    const withBoost = scoreDealV2({ ...base, endsAt: minutes(8) }).score;
    expect(withBoost - without).toBe(10);
  });

  it("penalizes risk flags at 6 points each, capped at 18", () => {
    const clean = scoreDealV2(base).score;
    expect(clean - scoreDealV2({ ...base, riskFlags: ["no_returns"] }).score).toBe(6);
    expect(clean - scoreDealV2({ ...base, riskFlags: ["a", "b", "c", "d", "e"] }).score).toBe(18);
  });

  it("clamps to 0..100", () => {
    expect(scoreDealV2({ netProfit: 10_000, roiPct: 10_000, sellThroughRate: 1, soldCompsCount: 500, endsAt: minutes(5), now: NOW }).score).toBeLessThanOrEqual(100);
    expect(scoreDealV2({ netProfit: -100, roiPct: -50, riskFlags: ["a", "b", "c"], now: NOW }).score).toBe(0);
  });
});

describe("detectRiskFlags", () => {
  it("flags vague titles", () => {
    expect(detectRiskFlags({ title: "vintage stuff box" })).toContain("vague_title");
    expect(detectRiskFlags({ title: "Bose QuietComfort 45 Wireless Headphones Black" })).toHaveLength(0);
  });

  it("flags as-is/untested and parts-only from title or condition", () => {
    expect(detectRiskFlags({ title: "Sony receiver UNTESTED as-is estate find" })).toContain("as_is_untested");
    expect(detectRiskFlags({ title: "Nikon D750 camera body", condition: "For parts or not working" })).toContain("parts_only");
  });

  it("flags no-returns and stock photos from raw hints", () => {
    const flags = detectRiskFlags({
      title: "Dyson V8 cordless vacuum cleaner tested",
      raw: { noReturns: true, stockPhoto: true },
    });
    expect(flags).toContain("no_returns");
    expect(flags).toContain("stock_photo");
  });
});

describe("trimOutliersIQR", () => {
  it("drops values outside the 1.5×IQR fence", () => {
    const prices = [139.99, 145, 149.95, 152.5, 155, 148, 160, 142.5, 151, 158, 144.99, 156.5, 499];
    const trimmed = trimOutliersIQR(prices);
    expect(trimmed).not.toContain(499);
    expect(trimmed).toHaveLength(prices.length - 1);
  });

  it("keeps small samples untouched", () => {
    expect(trimOutliersIQR([10, 500, 20])).toHaveLength(3);
  });
});

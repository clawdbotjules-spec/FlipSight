import { describe, expect, it } from "vitest";
import { computeDealEconomics, estimateEbayFees, scoreDeal } from "./economics.js";

describe("estimateEbayFees", () => {
  it("applies 13.6% + $0.30 by default", () => {
    expect(estimateEbayFees(100)).toBe(13.9);
    expect(estimateEbayFees(120)).toBe(16.62);
  });

  it("accepts overrides", () => {
    expect(estimateEbayFees(100, { pct: 6.35, fixed: 0.3 })).toBe(6.65);
  });

  it("returns 0 for non-positive prices", () => {
    expect(estimateEbayFees(0)).toBe(0);
    expect(estimateEbayFees(-5)).toBe(0);
  });
});

describe("computeDealEconomics", () => {
  it("computes net profit and ROI with defaults", () => {
    const econ = computeDealEconomics({ buyPrice: 45, estimatedResale: 120 });
    expect(econ.estFees).toBe(16.62);
    expect(econ.estShipping).toBe(12.99);
    expect(econ.netProfit).toBe(45.39);
    expect(econ.roiPct).toBe(100.87);
  });

  it("honors explicit fees and shipping", () => {
    const econ = computeDealEconomics({
      buyPrice: 10,
      estimatedResale: 50,
      estFees: 5,
      estShipping: 0,
    });
    expect(econ.netProfit).toBe(35);
    expect(econ.roiPct).toBe(350);
  });

  it("handles zero buy price without dividing by zero", () => {
    const econ = computeDealEconomics({ buyPrice: 0, estimatedResale: 20, estShipping: 0 });
    expect(econ.roiPct).toBe(0);
  });
});

describe("scoreDeal", () => {
  it("scores a strong deal high", () => {
    const score = scoreDeal({
      netProfit: 150,
      roiPct: 300,
      sellThroughRate: 0.9,
      soldCompsCount: 50,
    });
    expect(score).toBeGreaterThanOrEqual(90);
    expect(score).toBeLessThanOrEqual(100);
  });

  it("drags negative-profit deals toward zero", () => {
    const score = scoreDeal({ netProfit: -50, roiPct: -80, sellThroughRate: 0.5, soldCompsCount: 5 });
    expect(score).toBeLessThan(20);
  });

  it("stays within 0..100", () => {
    expect(scoreDeal({ netProfit: 10000, roiPct: 10000, sellThroughRate: 1, soldCompsCount: 1000 })).toBeLessThanOrEqual(100);
    expect(scoreDeal({ netProfit: -10000, roiPct: -100 })).toBeGreaterThanOrEqual(0);
  });
});

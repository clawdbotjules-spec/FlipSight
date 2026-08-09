import { describe, expect, it } from "vitest";
import { dealMatchesRule, type DealForMatch, type RuleForMatch } from "./matching.js";

const baseRule: RuleForMatch = {
  enabled: true,
  minProfit: null,
  minRoi: null,
  maxBuyPrice: null,
  categories: [],
  keywords: [],
  excludeKeywords: [],
  localOnly: false,
};

const baseDeal: DealForMatch = {
  buyPrice: 45,
  netProfit: 45.71,
  roiPct: 101.58,
  item: {
    title: "Milwaukee M18 FUEL Hammer Drill/Driver Kit",
    category: "Tools",
    location: null,
  },
};

describe("dealMatchesRule", () => {
  it("matches an unconstrained enabled rule", () => {
    expect(dealMatchesRule(baseDeal, baseRule)).toBe(true);
  });

  it("never matches a disabled rule", () => {
    expect(dealMatchesRule(baseDeal, { ...baseRule, enabled: false })).toBe(false);
  });

  it("enforces minProfit", () => {
    expect(dealMatchesRule(baseDeal, { ...baseRule, minProfit: 45.71 })).toBe(true);
    expect(dealMatchesRule(baseDeal, { ...baseRule, minProfit: 50 })).toBe(false);
  });

  it("enforces minRoi", () => {
    expect(dealMatchesRule(baseDeal, { ...baseRule, minRoi: 100 })).toBe(true);
    expect(dealMatchesRule(baseDeal, { ...baseRule, minRoi: 150 })).toBe(false);
  });

  it("enforces maxBuyPrice", () => {
    expect(dealMatchesRule(baseDeal, { ...baseRule, maxBuyPrice: 45 })).toBe(true);
    expect(dealMatchesRule(baseDeal, { ...baseRule, maxBuyPrice: 30 })).toBe(false);
  });

  it("matches categories case-insensitively, empty list matches all", () => {
    expect(dealMatchesRule(baseDeal, { ...baseRule, categories: ["tools", "Electronics"] })).toBe(true);
    expect(dealMatchesRule(baseDeal, { ...baseRule, categories: ["Electronics"] })).toBe(false);
  });

  it("rejects category filters when the item has no category", () => {
    const deal = { ...baseDeal, item: { ...baseDeal.item, category: null } };
    expect(dealMatchesRule(deal, { ...baseRule, categories: ["Tools"] })).toBe(false);
    expect(dealMatchesRule(deal, baseRule)).toBe(true);
  });

  it("requires at least one keyword when keywords are set", () => {
    expect(dealMatchesRule(baseDeal, { ...baseRule, keywords: ["milwaukee", "dewalt"] })).toBe(true);
    expect(dealMatchesRule(baseDeal, { ...baseRule, keywords: ["dewalt"] })).toBe(false);
  });

  it("rejects on exclude keywords", () => {
    expect(dealMatchesRule(baseDeal, { ...baseRule, excludeKeywords: ["hammer"] })).toBe(false);
    expect(dealMatchesRule(baseDeal, { ...baseRule, excludeKeywords: ["broken", "parts only"] })).toBe(true);
  });

  it("ignores empty exclude keywords", () => {
    expect(dealMatchesRule(baseDeal, { ...baseRule, excludeKeywords: ["  "] })).toBe(true);
  });

  it("enforces localOnly", () => {
    expect(dealMatchesRule(baseDeal, { ...baseRule, localOnly: true })).toBe(false);
    const localDeal = { ...baseDeal, item: { ...baseDeal.item, location: "Daytona Beach, FL" } };
    expect(dealMatchesRule(localDeal, { ...baseRule, localOnly: true })).toBe(true);
  });
});

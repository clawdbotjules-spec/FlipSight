import { describe, expect, it } from "vitest";
import {
  computeCompStats,
  computeWindowStats,
  keepaTimeToUnixMs,
  median,
  parseKeepaSeries,
  percentile,
} from "./stats.js";

describe("percentile / median", () => {
  it("computes interpolated percentiles", () => {
    const values = [10, 20, 30, 40, 50];
    expect(percentile(values, 50)).toBe(30);
    expect(percentile(values, 25)).toBe(20);
    expect(percentile(values, 75)).toBe(40);
    expect(percentile(values, 0)).toBe(10);
    expect(percentile(values, 100)).toBe(50);
  });

  it("handles even-length samples", () => {
    expect(median([10, 20])).toBe(15);
  });
});

describe("computeCompStats", () => {
  it("filters junk and rounds", () => {
    const stats = computeCompStats([100, 120, 80, 0, -5, Number.NaN, 95.555]);
    expect(stats).not.toBeNull();
    expect(stats!.count).toBe(4);
    expect(stats!.median).toBeCloseTo(97.78, 2);
  });

  it("returns null with no valid prices", () => {
    expect(computeCompStats([0, -1])).toBeNull();
  });
});

describe("keepa series", () => {
  it("converts keepa minutes to unix ms", () => {
    // keepaTime 0 == offset epoch
    expect(keepaTimeToUnixMs(0)).toBe(21_564_000 * 60_000);
  });

  it("parses csv pairs, skipping -1 gaps, cents to dollars", () => {
    const points = parseKeepaSeries([1000, 2599, 2000, -1, 3000, 1999]);
    expect(points).toHaveLength(2);
    expect(points[0]!.v).toBe(25.99);
    expect(points[1]!.v).toBe(19.99);
  });

  it("computes trailing-window stats", () => {
    const now = keepaTimeToUnixMs(100_000);
    const day = 24 * 3600 * 1000;
    const points = [
      { t: now - 100 * day, v: 200 }, // outside 90d window
      { t: now - 50 * day, v: 100 },
      { t: now - 10 * day, v: 60 },
      { t: now - day, v: 40 },
    ];
    const stats = computeWindowStats(points, 90, now);
    expect(stats.count).toBe(3);
    expect(stats.current).toBe(40);
    expect(stats.median).toBe(60);
    expect(stats.avg).toBeCloseTo(66.67, 1);
    expect(stats.min).toBe(40);
  });
});

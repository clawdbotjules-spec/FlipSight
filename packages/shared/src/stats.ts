/**
 * Small numeric helpers shared by the comps fetcher (eBay sold prices) and
 * the Keepa price-history analysis.
 */

/** Linear-interpolated percentile (p in 0..100) of an unsorted sample. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0]!;
  const rank = (Math.min(100, Math.max(0, p)) / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (rank - lo);
}

export function median(values: number[]): number {
  return percentile(values, 50);
}

export interface CompStats {
  median: number;
  p25: number;
  p75: number;
  count: number;
}

export function computeCompStats(prices: number[]): CompStats | null {
  const valid = prices.filter((p) => Number.isFinite(p) && p > 0);
  if (valid.length === 0) return null;
  return {
    median: round2(median(valid)),
    p25: round2(percentile(valid, 25)),
    p75: round2(percentile(valid, 75)),
    count: valid.length,
  };
}

// --- Keepa time-series helpers ------------------------------------------------

/** Keepa timestamps are minutes since epoch offset by 21564000. */
export const KEEPA_TIME_OFFSET_MINUTES = 21_564_000;

export function keepaTimeToUnixMs(keepaMinutes: number): number {
  return (keepaMinutes + KEEPA_TIME_OFFSET_MINUTES) * 60_000;
}

export interface PricePoint {
  /** Unix millis. */
  t: number;
  /** Price in dollars. */
  v: number;
}

/**
 * Parse one Keepa csv series ([keepaTime, value, keepaTime, value, ...],
 * values in cents, -1 = no data) into price points in dollars.
 */
export function parseKeepaSeries(csv: number[] | null | undefined): PricePoint[] {
  if (!csv || csv.length < 2) return [];
  const points: PricePoint[] = [];
  for (let i = 0; i + 1 < csv.length; i += 2) {
    const value = csv[i + 1]!;
    if (value == null || value < 0) continue;
    points.push({ t: keepaTimeToUnixMs(csv[i]!), v: value / 100 });
  }
  return points;
}

export interface WindowStats {
  current: number | null;
  avg: number | null;
  median: number | null;
  min: number | null;
  count: number;
}

/** Stats over the trailing `windowDays` of a price series. */
export function computeWindowStats(
  points: PricePoint[],
  windowDays: number,
  now: number = Date.now(),
): WindowStats {
  const cutoff = now - windowDays * 24 * 3600 * 1000;
  const inWindow = points.filter((p) => p.t >= cutoff).map((p) => p.v);
  const current = points.length > 0 ? points[points.length - 1]!.v : null;
  if (inWindow.length === 0) {
    return { current, avg: null, median: null, min: null, count: 0 };
  }
  const avg = inWindow.reduce((sum, v) => sum + v, 0) / inWindow.length;
  return {
    current,
    avg: round2(avg),
    median: round2(median(inWindow)),
    min: round2(Math.min(...inWindow)),
    count: inWindow.length,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

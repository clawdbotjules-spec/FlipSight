/**
 * Deal scoring v2 (0–100) and risk-flag detection. Weights:
 *   absolute profit 35 · ROI 25 · sell-through 15 · comp confidence 15
 *   + time pressure up to +10 (auction ending soon)
 *   − risk flags 6 each (capped at −18)
 */
import { clamp } from "./economics.js";

export const RISK_FLAGS = ["vague_title", "as_is_untested", "no_returns", "stock_photo", "parts_only"] as const;
export type RiskFlag = (typeof RISK_FLAGS)[number];

export interface RiskFlagInput {
  title: string;
  condition?: string | null;
  /** Raw source payload — recognized hints: noReturns, stockPhoto, imageCount. */
  raw?: Record<string, unknown> | null;
}

export function detectRiskFlags(input: RiskFlagInput): RiskFlag[] {
  const flags = new Set<RiskFlag>();
  const title = input.title.toLowerCase();
  const condition = (input.condition ?? "").toLowerCase();
  const text = `${title} ${condition}`;

  const meaningfulWords = input.title.trim().split(/\s+/).filter((w) => w.length > 2);
  if (meaningfulWords.length < 4) flags.add("vague_title");

  if (/\bas[- ]is\b|\buntested\b|\bnot tested\b|\bunknown if works\b/.test(text)) flags.add("as_is_untested");
  if (/\bfor parts\b|\bparts only\b|\bnot working\b|\bbroken\b/.test(text)) flags.add("parts_only");
  if (/\bno returns?\b/.test(text) || input.raw?.noReturns === true) flags.add("no_returns");
  if (input.raw?.stockPhoto === true || /\bstock (photo|image)\b/.test(text)) flags.add("stock_photo");

  return [...flags];
}

export interface ScoreInputV2 {
  netProfit: number;
  roiPct: number;
  /** 0..1 — fraction of listings that convert to sales. Null when unknown. */
  sellThroughRate?: number | null;
  soldCompsCount?: number | null;
  /** Auction end time — boosts score as the clock runs out. */
  endsAt?: Date | null;
  riskFlags?: readonly string[];
  /** Injectable clock for tests. */
  now?: number;
}

export interface ScoreBreakdown {
  score: number;
  profitPts: number;
  roiPts: number;
  sellThroughPts: number;
  compConfidencePts: number;
  timePressurePts: number;
  riskPenalty: number;
}

/** Time-pressure bonus: 0 outside 60 min, scaling to +10 at ≤10 min remaining. */
export function timePressurePoints(endsAt: Date | null | undefined, now = Date.now()): number {
  if (!endsAt) return 0;
  const minutesLeft = (endsAt.getTime() - now) / 60_000;
  if (minutesLeft <= 0 || minutesLeft > 60) return 0;
  if (minutesLeft <= 10) return 10;
  return Math.round(((60 - minutesLeft) / 50) * 10 * 10) / 10;
}

export function scoreDealV2(input: ScoreInputV2): ScoreBreakdown {
  const profitPts = Math.min(input.netProfit / 100, 1) * 35;
  const roiPts = Math.min(input.roiPct / 200, 1) * 25;
  const sellThroughPts = clamp(input.sellThroughRate ?? 0.5, 0, 1) * 15;
  const compConfidencePts = Math.min((input.soldCompsCount ?? 0) / 25, 1) * 15;
  const timePressurePts = timePressurePoints(input.endsAt, input.now);
  const riskPenalty = Math.min((input.riskFlags?.length ?? 0) * 6, 18);

  const score = Math.round(
    clamp(profitPts + roiPts + sellThroughPts + compConfidencePts + timePressurePts - riskPenalty, 0, 100),
  );
  return {
    score,
    profitPts: round1(profitPts),
    roiPts: round1(roiPts),
    sellThroughPts: round1(sellThroughPts),
    compConfidencePts: round1(compConfidencePts),
    timePressurePts: round1(timePressurePts),
    riskPenalty,
  };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

"use client";

/**
 * Deal Detail drawer — slides over the feed. Loads the enriched detail
 * payload (deal + price history + raw comps) and renders the full story:
 * economics breakdown, score anatomy, comp distribution, price history, and
 * the engine's reasoning. Recharts lives only in this lazy chunk.
 */
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "motion/react";
import { useQuery } from "@tanstack/react-query";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api } from "@/lib/api";
import { usd, pct, relTime } from "@/lib/format";
import type { Deal, PricePoint } from "@/lib/types";
import { Countdown, RiskChip, SourceBadge } from "./bits";
import { ScoreRing } from "./score-ring";
import { CheckIcon, ExternalIcon, PenIcon, XIcon } from "./icons";

interface DetailResponse {
  deal: Deal;
  priceHistory: PricePoint[];
  rawComps: number[] | null;
}

const TOOLTIP_STYLE = {
  background: "#0e141f",
  border: "1px solid rgba(148,163,184,0.2)",
  borderRadius: 8,
  fontSize: 12,
  color: "#e6edf3",
} as const;

function histogram(values: number[], bins = 8) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const width = (max - min) / bins || 1;
  const buckets = Array.from({ length: bins }, (_, i) => ({
    from: min + i * width,
    to: min + (i + 1) * width,
    label: `$${Math.round(min + (i + 0.5) * width)}`,
    count: 0,
  }));
  for (const v of values) {
    const idx = Math.min(bins - 1, Math.floor((v - min) / width));
    buckets[idx].count += 1;
  }
  return buckets;
}

function Row({ label, children, sub }: { label: string; children: React.ReactNode; sub?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <div>
        <span className="text-[12px] text-muted">{label}</span>
        {sub && <span className="ml-2 text-[10px] text-faint">{sub}</span>}
      </div>
      <span className="num text-[13px] text-ink">{children}</span>
    </div>
  );
}

const SCORE_PARTS = [
  { key: "profitPts", label: "Absolute profit", max: 35, color: "var(--color-profit)" },
  { key: "roiPts", label: "ROI", max: 25, color: "var(--color-acc)" },
  { key: "sellThroughPts", label: "Sell-through", max: 15, color: "var(--color-acc2)" },
  { key: "compConfidencePts", label: "Comp confidence", max: 15, color: "var(--color-acc2)" },
  { key: "timePressurePts", label: "Time pressure", max: 10, color: "var(--color-warn)" },
] as const;

export default function DealDrawer({
  dealId,
  onClose,
  onClaim,
  onDismiss,
}: {
  dealId: string;
  onClose: () => void;
  onClaim: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  const detail = useQuery({
    queryKey: ["deal", dealId],
    queryFn: () => api<DetailResponse>(`/deals/${dealId}`),
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const deal = detail.data?.deal;
  const meta = deal?.meta ?? {};
  const comps = useMemo(
    () => (detail.data?.rawComps && detail.data.rawComps.length >= 4 ? histogram(detail.data.rawComps) : null),
    [detail.data?.rawComps],
  );
  const history = detail.data?.priceHistory ?? [];
  const [imgFailed, setImgFailed] = useState(false);

  const reasoning = useMemo(() => {
    if (!deal) return [];
    const lines: string[] = [];
    const id = meta.identity;
    if (id?.method) {
      lines.push(
        id.method === "ai"
          ? `Product identified by Claude title normalization${id.aiConfidence != null ? ` (${Math.round(id.aiConfidence * 100)}% confidence)` : ""}: “${id.canonicalName}”.`
          : id.method === "heuristic"
            ? "Identified heuristically from the listing title (no product code present)."
            : `Identified by ${id.method?.toUpperCase()} product code.`,
      );
    }
    const c = meta.comps;
    if (c?.sampleSize) {
      lines.push(
        `Priced from ${c.sampleSize} sold comps${c.trimmedOutliers ? ` after IQR-trimming ${c.trimmedOutliers} outlier${c.trimmedOutliers > 1 ? "s" : ""}` : ""} (${c.source ?? deal.valuation.compSource}).`,
      );
    }
    if (deal.valuation.sellThroughRate != null) {
      lines.push(`Sell-through ${(deal.valuation.sellThroughRate * 100).toFixed(0)}% — demand relative to supply.`);
    }
    const sb = meta.scoreBreakdown;
    if (sb?.timePressurePts) lines.push(`Auction ends soon → +${sb.timePressurePts} time-pressure boost.`);
    for (const flag of meta.riskFlags ?? []) {
      lines.push(`Risk: ${flag.replaceAll("_", " ")} (−6 score).`);
    }
    if (id?.demo) lines.push("Valued from embedded demo comps (seed item) — not live market data.");
    return lines;
  }, [deal, meta]);

  return (
    <AnimatePresence>
      <motion.div
        key="backdrop"
        className="fixed inset-0 z-40 bg-black/55 backdrop-blur-[2px]"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
      />
      <motion.aside
        key="panel"
        role="dialog"
        aria-label="Deal detail"
        className="fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col border-l border-line bg-panel/95 shadow-2xl backdrop-blur-2xl"
        initial={{ x: "100%" }}
        animate={{ x: 0 }}
        exit={{ x: "100%" }}
        transition={{ type: "spring", stiffness: 380, damping: 40 }}
      >
        <header className="flex items-center justify-between border-b border-line px-4 py-3">
          <span className="text-[11px] tracking-[0.2em] text-faint uppercase">deal detail</span>
          <button onClick={onClose} className="btn btn-ghost px-2 py-1" aria-label="Close">
            <XIcon width={15} height={15} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {detail.isLoading && <div className="glass glass-flat h-40 animate-pulse" />}
          {detail.isError && <p className="text-sm text-loss">{(detail.error as Error).message}</p>}

          {deal && (
            <div className="space-y-5">
              {/* Identity */}
              <div>
                {deal.item.imageUrls[0] && !imgFailed && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={deal.item.imageUrls[0]}
                    alt=""
                    onError={() => setImgFailed(true)}
                    className="mb-3 h-44 w-full rounded-lg border border-line object-cover"
                  />
                )}
                <h2 className="text-[15px] leading-snug font-semibold">{deal.item.title}</h2>
                <div className="mt-1.5 flex flex-wrap items-center gap-2">
                  <SourceBadge sourceKey={deal.item.sourceKey} />
                  {deal.item.category && <span className="chip">{deal.item.category}</span>}
                  {deal.item.condition && <span className="chip">{deal.item.condition}</span>}
                  <Countdown endsAt={deal.item.endsAt} />
                  <span className="chip capitalize">{deal.status}</span>
                </div>
              </div>

              {/* Verdict strip */}
              <div className="glass flex items-center gap-4 p-3.5">
                <ScoreRing score={deal.score} size={62} />
                <div className="flex-1">
                  <div
                    className="num text-xl font-semibold text-profit"
                    style={{ textShadow: "0 0 18px rgba(52,211,153,0.4)" }}
                  >
                    {usd(deal.netProfit, { sign: true })}
                  </div>
                  <div className="text-[11px] text-muted">
                    net after fees & shipping · <span className="num text-acc2">{pct(deal.roiPct)} ROI</span>
                  </div>
                </div>
                <a href={deal.item.sourceUrl} target="_blank" rel="noreferrer noopener" className="btn btn-acc">
                  <ExternalIcon width={13} height={13} /> Listing
                </a>
              </div>

              {/* Economics */}
              <section className="glass glass-flat p-3.5">
                <h3 className="label">Economics</h3>
                <div className="divide-y divide-line">
                  <Row label="Buy price">{usd(deal.buyPrice)}</Row>
                  <Row
                    label="Est. resale"
                    sub={`p25 ${usd(deal.valuation.resaleLow)} · p75 ${usd(deal.valuation.resaleHigh)} · ${deal.valuation.soldCompsCount} comps`}
                  >
                    {usd(deal.valuation.estimatedResale)}
                  </Row>
                  <Row
                    label="Marketplace fees"
                    sub={
                      meta.fees
                        ? `${meta.fees.pct}% + $${meta.fees.fixed}${meta.fees.matchedCategory ? ` · ${meta.fees.matchedCategory}` : " · default"}`
                        : undefined
                    }
                  >
                    −{usd(deal.estFees)}
                  </Row>
                  <Row label="Shipping" sub={meta.shipping?.rule}>
                    −{usd(deal.estShipping)}
                  </Row>
                  <div className="flex items-baseline justify-between pt-2">
                    <span className="text-[12px] font-medium text-ink">Net profit</span>
                    <span className="num text-[15px] font-semibold text-profit">{usd(deal.netProfit, { sign: true })}</span>
                  </div>
                </div>
              </section>

              {/* Score anatomy */}
              {meta.scoreBreakdown && (
                <section className="glass glass-flat p-3.5">
                  <h3 className="label">Score anatomy — {deal.score}/100</h3>
                  <div className="space-y-2">
                    {SCORE_PARTS.map((part) => {
                      const value = meta.scoreBreakdown?.[part.key] ?? 0;
                      return (
                        <div key={part.key} className="flex items-center gap-2">
                          <span className="w-32 shrink-0 text-[11px] text-muted">{part.label}</span>
                          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-raise">
                            <div
                              className="h-full rounded-full"
                              style={{
                                width: `${Math.min(100, (value / part.max) * 100)}%`,
                                background: part.color,
                                boxShadow: `0 0 8px ${part.color}`,
                              }}
                            />
                          </div>
                          <span className="num w-12 shrink-0 text-right text-[11px] text-ink">
                            {value.toFixed(1)}/{part.max}
                          </span>
                        </div>
                      );
                    })}
                    {meta.scoreBreakdown.riskPenalty > 0 && (
                      <div className="flex items-center gap-2">
                        <span className="w-32 shrink-0 text-[11px] text-warn">Risk penalty</span>
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-raise">
                          <div
                            className="h-full rounded-full bg-loss"
                            style={{ width: `${(meta.scoreBreakdown.riskPenalty / 18) * 100}%` }}
                          />
                        </div>
                        <span className="num w-12 shrink-0 text-right text-[11px] text-loss">
                          −{meta.scoreBreakdown.riskPenalty}
                        </span>
                      </div>
                    )}
                  </div>
                  {(meta.riskFlags?.length ?? 0) > 0 && (
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {meta.riskFlags!.map((f) => (
                        <RiskChip key={f} flag={f} />
                      ))}
                    </div>
                  )}
                </section>
              )}

              {/* Comp distribution */}
              {comps && (
                <section className="glass glass-flat p-3.5">
                  <h3 className="label">Sold-comp distribution</h3>
                  <div className="h-40">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={comps} margin={{ top: 4, right: 4, bottom: 0, left: -26 }}>
                        <CartesianGrid stroke="rgba(148,163,184,0.08)" vertical={false} />
                        <XAxis dataKey="label" tick={{ fontSize: 10, fill: "#566173" }} tickLine={false} axisLine={false} />
                        <YAxis tick={{ fontSize: 10, fill: "#566173" }} tickLine={false} axisLine={false} allowDecimals={false} />
                        <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: "rgba(148,163,184,0.06)" }} />
                        <Bar dataKey="count" fill="rgba(34,211,238,0.55)" radius={[3, 3, 0, 0]} />
                        <ReferenceLine
                          x={comps.reduce((best, b) => (deal.valuation.estimatedResale >= b.from && deal.valuation.estimatedResale <= b.to ? b.label : best), comps[0].label)}
                          stroke="#34d399"
                          strokeDasharray="4 3"
                          label={{ value: "median", fill: "#34d399", fontSize: 10, position: "top" }}
                        />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  <p className="mt-1 text-[10px] text-faint">
                    buy {usd(deal.buyPrice)} → median {usd(deal.valuation.estimatedResale)} ·{" "}
                    {meta.comps?.trimmedOutliers ? `${meta.comps.trimmedOutliers} outlier(s) trimmed` : "no outliers trimmed"}
                  </p>
                </section>
              )}

              {/* Price history */}
              {history.length >= 2 && (
                <section className="glass glass-flat p-3.5">
                  <h3 className="label">Price history</h3>
                  <div className="h-40">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart
                        data={history.map((p) => ({ ...p, t: new Date(p.capturedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" }) }))}
                        margin={{ top: 4, right: 4, bottom: 0, left: -18 }}
                      >
                        <CartesianGrid stroke="rgba(148,163,184,0.08)" vertical={false} />
                        <XAxis dataKey="t" tick={{ fontSize: 10, fill: "#566173" }} tickLine={false} axisLine={false} />
                        <YAxis tick={{ fontSize: 10, fill: "#566173" }} tickLine={false} axisLine={false} domain={["auto", "auto"]} />
                        <Tooltip contentStyle={TOOLTIP_STYLE} />
                        <Line type="monotone" dataKey="price" stroke="#a78bfa" strokeWidth={1.8} dot={false} />
                        <ReferenceLine y={deal.buyPrice} stroke="#22d3ee" strokeDasharray="4 3" label={{ value: "buy", fill: "#22d3ee", fontSize: 10 }} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </section>
              )}

              {/* Engine reasoning */}
              {reasoning.length > 0 && (
                <section className="glass glass-flat p-3.5">
                  <h3 className="label">Engine reasoning</h3>
                  <ul className="space-y-1.5">
                    {reasoning.map((line, i) => (
                      <li key={i} className="flex gap-2 text-[12px] leading-relaxed text-muted">
                        <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-acc/60" />
                        {line}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 text-[10px] text-faint">valued {relTime(deal.valuation.id ? deal.createdAt : deal.createdAt)}</p>
                </section>
              )}
            </div>
          )}
        </div>

        {deal && (
          <footer className="flex items-center gap-2 border-t border-line px-4 py-3">
            <button
              className="btn btn-acc flex-1"
              disabled={deal.status !== "new" && deal.status !== "alerted"}
              onClick={() => onClaim(deal.id)}
            >
              <CheckIcon width={14} height={14} /> {deal.status === "claimed" ? "Claimed" : "Claim"}
            </button>
            <button className="btn flex-1 hover:text-loss" onClick={() => { onDismiss(deal.id); onClose(); }}>
              <XIcon width={14} height={14} /> Dismiss
            </button>
            <Link
              href={`/assistant?itemId=${deal.item.id}&title=${encodeURIComponent(deal.item.title)}`}
              className="btn flex-1"
            >
              <PenIcon width={14} height={14} /> Draft listing
            </Link>
          </footer>
        )}
      </motion.aside>
    </AnimatePresence>
  );
}

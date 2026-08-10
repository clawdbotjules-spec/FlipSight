"use client";

/**
 * One row of the live feed. Kept cheap on purpose — it renders inside a
 * virtualized list and hundreds may mount/unmount while scrolling. The
 * entrance glow only fires for deals that arrived over the WebSocket.
 */
import { memo, useState } from "react";
import Link from "next/link";
import { usd, pct } from "@/lib/format";
import type { Deal } from "@/lib/types";
import { Countdown, RiskChip, SourceBadge } from "./bits";
import { ScoreRing } from "./score-ring";
import { CheckIcon, ExternalIcon, PenIcon, XIcon } from "./icons";

function Thumb({ url, title }: { url: string | null; title: string }) {
  const [failed, setFailed] = useState(false);
  if (!url || failed) {
    return (
      <div className="grid h-16 w-16 shrink-0 place-items-center rounded-lg border border-line bg-gradient-to-br from-raise to-panel text-lg text-faint select-none">
        {title.slice(0, 1).toUpperCase()}
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt=""
      width={64}
      height={64}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      className="h-16 w-16 shrink-0 rounded-lg border border-line object-cover"
    />
  );
}

function PriceArrow() {
  return (
    <svg width="26" height="10" viewBox="0 0 26 10" fill="none" className="mx-1 shrink-0 opacity-80">
      <defs>
        <linearGradient id="pa" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#566173" />
          <stop offset="1" stopColor="#34d399" />
        </linearGradient>
      </defs>
      <path d="M1 5h21m0 0-4-3.5M22 5l-4 3.5" stroke="url(#pa)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

interface DealCardProps {
  deal: Deal;
  fresh: boolean;
  onOpen: (id: string) => void;
  onClaim: (id: string) => void;
  onDismiss: (id: string) => void;
  busy?: boolean;
}

export const DealCard = memo(function DealCard({ deal, fresh, onOpen, onClaim, onDismiss, busy }: DealCardProps) {
  const { item, valuation } = deal;
  const riskFlags = deal.meta?.riskFlags ?? [];
  const claimed = deal.status === "claimed";

  return (
    <article
      data-deal={deal.id}
      className={`glass group cursor-pointer p-3 transition-colors hover:border-acc/30 sm:p-3.5 ${fresh ? "deal-glow" : ""}`}
      onClick={() => onOpen(deal.id)}
      role="button"
      aria-label={item.title}
    >
      <div className="flex items-start gap-3">
        <Thumb url={item.imageUrls[0] ?? null} title={item.title} />

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <h2 className="min-w-0 truncate text-[13.5px] leading-snug font-medium text-ink" title={item.title}>
              {item.title}
            </h2>
            <div className="hidden sm:block">
              <ScoreRing score={deal.score} size={46} animate={fresh} />
            </div>
          </div>

          <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <SourceBadge sourceKey={item.sourceKey} />
            {item.category && <span className="text-[11px] text-faint">{item.category}</span>}
            {item.condition && <span className="hidden text-[11px] text-faint md:inline">{item.condition}</span>}
            {item.location && <span className="text-[11px] text-acc2">📍 {item.location}</span>}
            <Countdown endsAt={item.endsAt} />
            {item.bidsCount != null && item.endsAt && (
              <span className="num text-[11px] text-faint">{item.bidsCount} bids</span>
            )}
            {riskFlags.slice(0, 2).map((f) => (
              <RiskChip key={f} flag={f} />
            ))}
          </div>

          <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <div className="flex items-center">
              <span className="num text-[13px] text-muted">{usd(deal.buyPrice)}</span>
              <PriceArrow />
              <span className="num text-[13px] text-ink" title={`${valuation.soldCompsCount} comps`}>
                {usd(valuation.estimatedResale)}
              </span>
              <span className="mx-3 hidden h-4 w-px bg-line sm:block" />
              <span
                className="num ml-2 text-[15px] font-semibold text-profit sm:ml-0"
                style={{ textShadow: "0 0 14px rgba(52,211,153,0.35)" }}
              >
                {usd(deal.netProfit, { sign: true })}
              </span>
              <span className="num ml-2 text-[12px] text-acc2">{pct(deal.roiPct)} ROI</span>
              <span className="num ml-2 text-[11px] text-faint sm:hidden">score {deal.score}</span>
            </div>

            <div
              className="flex items-center gap-1 transition-opacity md:opacity-50 md:group-hover:opacity-100"
              onClick={(e) => e.stopPropagation()}
            >
              <a
                href={item.sourceUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="btn btn-ghost px-2 py-1"
                title="Open listing"
              >
                <ExternalIcon width={14} height={14} />
              </a>
              <Link
                href={`/assistant?itemId=${item.id}&title=${encodeURIComponent(item.title)}`}
                className="btn btn-ghost px-2 py-1"
                title="Draft my listing"
              >
                <PenIcon width={14} height={14} />
              </Link>
              <button
                className={`btn px-2 py-1 ${claimed ? "text-profit" : "btn-ghost"}`}
                title={claimed ? "Claimed" : "Claim"}
                disabled={busy || claimed || deal.status === "dismissed"}
                onClick={() => onClaim(deal.id)}
              >
                <CheckIcon width={14} height={14} />
              </button>
              <button
                className="btn btn-ghost px-2 py-1 hover:text-loss"
                title="Dismiss"
                disabled={busy}
                onClick={() => onDismiss(deal.id)}
              >
                <XIcon width={14} height={14} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </article>
  );
});

"use client";

/** Small shared UI atoms: countdown chip, sparkline, ticking counter, badges. */
import { countdown, msLeft } from "@/lib/format";
import { useNow } from "@/lib/use-now";
import { SOURCE_COLORS, SOURCE_LABELS, type SourceKey } from "@/lib/types";
import { ClockIcon } from "./icons";

export function SourceBadge({ sourceKey }: { sourceKey: SourceKey }) {
  const color = SOURCE_COLORS[sourceKey] ?? "#8b98a9";
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold tracking-wide uppercase"
      style={{ color, borderColor: `${color}44`, background: `${color}14` }}
    >
      <span className="h-1 w-1 rounded-full" style={{ background: color }} />
      {SOURCE_LABELS[sourceKey] ?? sourceKey}
    </span>
  );
}

/** Live auction countdown — amber under 1 h, red under 10 min. */
export function Countdown({ endsAt }: { endsAt: string | null | undefined }) {
  const now = useNow();
  const ms = msLeft(endsAt, now);
  if (ms == null) return null;
  const urgent = ms > 0 && ms <= 10 * 60_000;
  const soon = ms > 0 && ms <= 60 * 60_000;
  return (
    <span
      className={`num inline-flex items-center gap-1 text-[11px] ${
        ms <= 0 ? "text-faint" : urgent ? "text-loss" : soon ? "text-warn" : "text-muted"
      }`}
    >
      <ClockIcon width={12} height={12} />
      {countdown(ms)}
    </span>
  );
}

/** Inline SVG sparkline; no chart library involved. */
export function Sparkline({
  data,
  width = 120,
  height = 28,
  color = "var(--color-acc)",
}: {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
}) {
  if (data.length < 2) return <svg width={width} height={height} />;
  const max = Math.max(...data, 1);
  const step = width / (data.length - 1);
  const pts = data.map((v, i) => `${(i * step).toFixed(1)},${(height - 2 - (v / max) * (height - 6)).toFixed(1)}`);
  const last = data[data.length - 1];
  const lastY = height - 2 - (last / max) * (height - 6);
  return (
    <svg width={width} height={height} className="overflow-visible">
      <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" opacity="0.9" />
      <polygon
        points={`0,${height} ${pts.join(" ")} ${width},${height}`}
        fill={color}
        opacity="0.08"
        stroke="none"
      />
      <circle cx={width} cy={lastY} r="2" fill={color} />
    </svg>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="glass glass-flat grid place-items-center px-6 py-16 text-center">
      <div>
        <p className="text-sm text-muted">{title}</p>
        {hint && <p className="mt-1 text-xs text-faint">{hint}</p>}
      </div>
    </div>
  );
}

export function RiskChip({ flag }: { flag: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded border border-warn/30 bg-warn/10 px-1.5 py-0.5 text-[10px] font-medium text-warn">
      {flag.replaceAll("_", " ")}
    </span>
  );
}

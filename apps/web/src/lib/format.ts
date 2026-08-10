/** Formatting helpers — money/percent/relative time, tuned for mono numerals. */

export function usd(n: number | null | undefined, opts: { sign?: boolean } = {}): string {
  if (n == null) return "—";
  const sign = opts.sign && n > 0 ? "+" : "";
  const abs = Math.abs(n);
  const formatted =
    abs >= 10_000
      ? `$${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`
      : n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
  return `${sign}${formatted}`;
}

export function pct(n: number | null | undefined, digits = 0): string {
  if (n == null) return "—";
  return `${n.toFixed(digits)}%`;
}

export function relTime(iso: string | null | undefined): string {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** ms until an ISO time; negative when past. */
export function msLeft(iso: string | null | undefined, now = Date.now()): number | null {
  if (!iso) return null;
  return new Date(iso).getTime() - now;
}

export function countdown(ms: number): string {
  if (ms <= 0) return "ended";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h >= 48) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m.toString().padStart(2, "0")}m`;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

export function clampText(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1).trimEnd() + "…" : text;
}

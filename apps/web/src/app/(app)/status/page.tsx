"use client";

/**
 * System Status: per-worker activity with 24h ingest sparklines, BullMQ queue
 * depths, engine throughput, alert delivery counts, and the dead-letter queue.
 * Polls every 5 s (the API caches the aggregate, so this stays cheap).
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { relTime } from "@/lib/format";
import type { SystemStatus, WorkerStatus } from "@/lib/types";
import { EmptyState, Sparkline } from "@/components/bits";

function healthOf(w: WorkerStatus): { color: string; label: string } {
  if (!w.enabled) return { color: "var(--color-faint)", label: "disabled" };
  const failed = w.counts?.failed ?? 0;
  if (failed > 0) return { color: "var(--color-warn)", label: `${failed} failed` };
  if (w.counts == null) return { color: "var(--color-loss)", label: "unreachable" };
  return { color: "var(--color-profit)", label: "nominal" };
}

function WorkerCard({ w }: { w: WorkerStatus }) {
  const health = healthOf(w);
  return (
    <div className="glass p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="pulse-dot h-2 w-2 rounded-full" style={{ background: health.color }} />
          <span className="num text-[13px] font-medium">{w.name}</span>
        </div>
        <span className="text-[10px] text-faint">{health.label}</span>
      </div>

      <div className="mt-3 flex items-end justify-between gap-3">
        <div>
          <p className="num text-lg leading-none font-semibold text-acc">{w.itemsLastHour}</p>
          <p className="mt-1 text-[10px] text-faint">items/hour</p>
        </div>
        <Sparkline data={w.sparkline} width={130} height={30} />
      </div>

      <div className="mt-3 grid grid-cols-4 gap-1.5 text-center">
        {(
          [
            ["waiting", w.counts?.waiting],
            ["active", w.counts?.active],
            ["delayed", w.counts?.delayed],
            ["failed", w.counts?.failed],
          ] as const
        ).map(([label, value]) => (
          <div key={label} className="rounded border border-line bg-raise/50 px-1 py-1.5">
            <p className={`num text-[12px] leading-none ${label === "failed" && (value ?? 0) > 0 ? "text-loss" : "text-ink"}`}>
              {value ?? "—"}
            </p>
            <p className="mt-0.5 text-[9px] text-faint">{label}</p>
          </div>
        ))}
      </div>

      <p className="mt-2.5 flex justify-between text-[10px] text-faint">
        <span>last sweep {relTime(w.lastActivityAt)}</span>
        <span className="num">{w.items24h} items/24h</span>
      </p>
    </div>
  );
}

export default function StatusPage() {
  const query = useQuery({
    queryKey: ["system-status"],
    queryFn: () => api<{ status: SystemStatus }>("/status/system"),
    refetchInterval: 5_000,
  });

  if (query.isLoading) {
    return (
      <div className="mx-auto grid max-w-5xl gap-3 md:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="glass glass-flat h-40 animate-pulse" />
        ))}
      </div>
    );
  }
  const s = query.data?.status;
  if (!s) return <EmptyState title="Could not load system status" hint={(query.error as Error | null)?.message} />;

  const dlqDepth = (s.deadLetter.counts?.waiting ?? 0) + (s.deadLetter.counts?.delayed ?? 0);
  const alertTotal = Object.values(s.alerts24h).reduce((a, b) => a + b, 0);

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <div className="glass p-4">
          <p className="label">Valuations / hour</p>
          <p className="num text-xl font-semibold text-acc">{s.valuationsLastHour}</p>
        </div>
        <div className="glass p-4">
          <p className="label">Deals / 24h</p>
          <p className="num text-xl font-semibold text-profit">{s.dealsLast24h}</p>
        </div>
        <div className="glass p-4">
          <p className="label">Alerts / 24h</p>
          <p className="num text-xl font-semibold text-acc2">{alertTotal}</p>
          <p className="num mt-1 text-[10px] text-faint">
            {Object.entries(s.alerts24h)
              .map(([ch, n]) => `${ch} ${n}`)
              .join(" · ") || "none"}
          </p>
        </div>
        <div className="glass p-4">
          <p className="label">Dead letter</p>
          <p className={`num text-xl font-semibold ${dlqDepth > 0 ? "text-warn" : "text-muted"}`}>{dlqDepth}</p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {s.workers.map((w) => (
          <WorkerCard key={w.name} w={w} />
        ))}
      </div>

      <div className="glass glass-flat overflow-x-auto p-4">
        <p className="label">Dead-letter queue — most recent</p>
        {s.deadLetter.recent.length === 0 ? (
          <p className="py-6 text-center text-xs text-faint">empty — every job is completing within its retries</p>
        ) : (
          <table className="w-full min-w-[520px] text-left text-[12px]">
            <thead>
              <tr className="text-[10px] tracking-wider text-faint uppercase">
                <th className="pb-2 font-medium">Job</th>
                <th className="pb-2 font-medium">Reason</th>
                <th className="pb-2 text-right font-medium">When</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {s.deadLetter.recent.map((entry, i) => (
                <tr key={i}>
                  <td className="num py-2 pr-3 text-ink">{entry.name}</td>
                  <td className="max-w-72 truncate py-2 pr-3 text-loss" title={String(entry.data.reason ?? entry.data.err ?? "")}>
                    {String(entry.data.reason ?? entry.data.err ?? "unknown")}
                  </td>
                  <td className="num py-2 text-right text-faint">{entry.failedAt ? relTime(entry.failedAt) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <p className="num text-right text-[10px] text-faint">snapshot {relTime(s.generatedAt)}</p>
    </div>
  );
}

"use client";

/**
 * P&L Dashboard: realized profit by period, cumulative curve, ROI by source
 * and category, and the active inventory with days held.
 */
import { useQuery } from "@tanstack/react-query";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api } from "@/lib/api";
import { usd } from "@/lib/format";
import { SOURCE_COLORS, SOURCE_LABELS, type LedgerAnalytics, type SourceKey } from "@/lib/types";
import { EmptyState, SourceBadge } from "@/components/bits";
import { TickingMoney } from "@/components/ticking";

const TOOLTIP_STYLE = {
  background: "#0e141f",
  border: "1px solid rgba(148,163,184,0.2)",
  borderRadius: 8,
  fontSize: 12,
  color: "#e6edf3",
} as const;

function StatCard({ label, value, sub }: { label: string; value: number; sub?: string }) {
  return (
    <div className="glass p-4">
      <p className="label">{label}</p>
      <TickingMoney
        value={value}
        sign
        className={`text-xl font-semibold ${value > 0 ? "text-profit" : value < 0 ? "text-loss" : "text-muted"}`}
      />
      {sub && <p className="mt-1 text-[11px] text-faint">{sub}</p>}
    </div>
  );
}

function RoiBars({ title, data }: { title: string; data: LedgerAnalytics["roiBySource"] }) {
  return (
    <div className="glass glass-flat p-4">
      <p className="label">{title}</p>
      {data.length === 0 ? (
        <p className="py-8 text-center text-xs text-faint">no sold flips yet</p>
      ) : (
        <div className="h-44">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: -22 }}>
              <CartesianGrid stroke="rgba(148,163,184,0.08)" vertical={false} />
              <XAxis dataKey="name" tick={{ fontSize: 10, fill: "#566173" }} tickLine={false} axisLine={false} />
              <YAxis tick={{ fontSize: 10, fill: "#566173" }} tickLine={false} axisLine={false} unit="%" />
              <Tooltip
                contentStyle={TOOLTIP_STYLE}
                cursor={{ fill: "rgba(148,163,184,0.06)" }}
                formatter={(value?: unknown, name?: unknown) =>
                  name === "roiPct" ? [`${Number(value ?? 0).toFixed(1)}%`, "ROI"] : [String(value ?? ""), String(name ?? "")]
                }
              />
              <Bar dataKey="roiPct" radius={[3, 3, 0, 0]}>
                {data.map((row) => (
                  <Cell
                    key={row.name}
                    fill={SOURCE_COLORS[row.name as SourceKey] ?? "rgba(167,139,250,0.65)"}
                    fillOpacity={0.7}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

export default function PnlPage() {
  const query = useQuery({
    queryKey: ["ledger-analytics"],
    queryFn: () => api<{ analytics: LedgerAnalytics }>("/ledger/analytics"),
    refetchInterval: 30_000,
  });

  if (query.isLoading) {
    return (
      <div className="mx-auto grid max-w-5xl gap-3 md:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="glass glass-flat h-24 animate-pulse" />
        ))}
      </div>
    );
  }
  const a = query.data?.analytics;
  if (!a) return <EmptyState title="Could not load P&L" hint={(query.error as Error | null)?.message} />;

  const labeled = a.roiBySource.map((r) => ({ ...r, name: SOURCE_LABELS[r.name as SourceKey] ?? r.name }));

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Realized today" value={a.realized.today} />
        <StatCard label="Last 7 days" value={a.realized.week} />
        <StatCard label="Last 30 days" value={a.realized.month} />
        <StatCard label="All time" value={a.realized.allTime} sub={`${a.soldCount} flips sold`} />
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <div className="glass glass-flat p-4 lg:col-span-2">
          <p className="label">Cumulative realized profit — 90 days</p>
          {a.cumulative.length === 0 ? (
            <p className="py-14 text-center text-xs text-faint">
              record sales in the ledger to grow this curve
            </p>
          ) : (
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={a.cumulative} margin={{ top: 8, right: 4, bottom: 0, left: -14 }}>
                  <defs>
                    <linearGradient id="profitFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#22d3ee" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="#22d3ee" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="rgba(148,163,184,0.08)" vertical={false} />
                  <XAxis
                    dataKey="day"
                    tick={{ fontSize: 10, fill: "#566173" }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(d: string) => d.slice(5)}
                  />
                  <YAxis tick={{ fontSize: 10, fill: "#566173" }} tickLine={false} axisLine={false} />
                  <Tooltip
                    contentStyle={TOOLTIP_STYLE}
                    formatter={(value?: unknown, name?: unknown) => [
                      usd(Number(value ?? 0)),
                      name === "cumulative" ? "Cumulative" : "That day",
                    ]}
                  />
                  <Area type="monotone" dataKey="cumulative" stroke="#22d3ee" strokeWidth={2} fill="url(#profitFill)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        <div className="space-y-3">
          <div className="glass p-4">
            <p className="label">Avg days to sell</p>
            <p className="num text-xl font-semibold text-acc">
              {a.avgDaysToSell != null ? a.avgDaysToSell.toFixed(1) : "—"}
            </p>
          </div>
          <div className="glass p-4">
            <p className="label">Active inventory</p>
            <p className="num text-xl font-semibold">{a.activeCount}</p>
            <p className="mt-1 text-[11px] text-faint">
              cost basis <span className="num text-muted">{usd(a.activeCostBasis)}</span>
            </p>
          </div>
          <div className="glass p-4">
            <p className="label">Flips completed</p>
            <p className="num text-xl font-semibold text-acc2">{a.soldCount}</p>
          </div>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <RoiBars title="ROI by source" data={labeled} />
        <RoiBars title="ROI by category" data={a.roiByCategory} />
      </div>

      <div className="glass glass-flat overflow-x-auto p-4">
        <p className="label">Active inventory</p>
        {a.inventory.length === 0 ? (
          <p className="py-8 text-center text-xs text-faint">
            nothing held — claim a deal, then record the purchase in the ledger
          </p>
        ) : (
          <table className="w-full min-w-[560px] text-left text-[12px]">
            <thead>
              <tr className="text-[10px] tracking-wider text-faint uppercase">
                <th className="pb-2 font-medium">Item</th>
                <th className="pb-2 font-medium">Source</th>
                <th className="pb-2 text-right font-medium">Paid</th>
                <th className="pb-2 text-right font-medium">Est. resale</th>
                <th className="pb-2 text-right font-medium">Days held</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {a.inventory.map((row) => (
                <tr key={row.id}>
                  <td className="max-w-64 truncate py-2 pr-3 text-ink" title={row.title}>
                    {row.title}
                  </td>
                  <td className="py-2 pr-3">
                    <SourceBadge sourceKey={row.sourceKey} />
                  </td>
                  <td className="num py-2 text-right text-muted">{usd(row.purchasePrice)}</td>
                  <td className="num py-2 text-right text-ink">{usd(row.estimatedResale)}</td>
                  <td
                    className={`num py-2 text-right ${row.daysHeld > 30 ? "text-warn" : "text-muted"}`}
                    title={row.daysHeld > 30 ? "held over 30 days" : undefined}
                  >
                    {row.daysHeld}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

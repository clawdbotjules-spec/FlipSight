"use client";

/** Sticky feed filter bar: search, source, category, min score, local-only. */
import { SOURCE_LABELS, type SourceKey } from "@/lib/types";

export interface FeedFilters {
  q: string;
  source: SourceKey | "";
  category: string;
  minScore: number;
  localOnly: boolean;
}

export const DEFAULT_FILTERS: FeedFilters = { q: "", source: "", category: "", minScore: 0, localOnly: false };

export function FilterBar({
  filters,
  onChange,
}: {
  filters: FeedFilters;
  onChange: (next: FeedFilters) => void;
}) {
  const set = <K extends keyof FeedFilters>(key: K, value: FeedFilters[K]) =>
    onChange({ ...filters, [key]: value });

  return (
    <div className="glass glass-flat sticky top-13 z-10 mb-3 flex flex-wrap items-center gap-2 p-2.5">
      <input
        className="field h-8 w-full min-w-40 flex-1 text-[13px] sm:w-auto"
        placeholder="Search titles…"
        value={filters.q}
        onChange={(e) => set("q", e.target.value)}
        aria-label="Search deals"
      />
      <select
        className="field h-8 w-auto cursor-pointer text-[13px]"
        value={filters.source}
        onChange={(e) => set("source", e.target.value as FeedFilters["source"])}
        aria-label="Source"
      >
        <option value="">All sources</option>
        {Object.entries(SOURCE_LABELS).map(([key, label]) => (
          <option key={key} value={key}>
            {label}
          </option>
        ))}
      </select>
      <input
        className="field h-8 w-28 text-[13px]"
        placeholder="Category"
        value={filters.category}
        onChange={(e) => set("category", e.target.value)}
        aria-label="Category filter"
      />
      <label className="flex items-center gap-2 text-[12px] text-muted">
        <span className="num w-7 text-right text-acc">{filters.minScore || "any"}</span>
        <input
          type="range"
          min={0}
          max={95}
          step={5}
          value={filters.minScore}
          onChange={(e) => set("minScore", Number(e.target.value))}
          className="h-1 w-24 cursor-pointer accent-(--color-acc)"
          aria-label="Minimum score"
        />
        <span className="hidden lg:inline">min score</span>
      </label>
      <button
        type="button"
        className="flex cursor-pointer items-center gap-2 text-[12px] text-muted"
        onClick={() => set("localOnly", !filters.localOnly)}
      >
        <span className="switch" data-on={filters.localOnly} />
        local only
      </button>
    </div>
  );
}

/** Client-side mirror of the server filters, applied to WebSocket arrivals. */
export function dealMatchesFilters(
  deal: { score: number; item: { title: string; category: string | null; location: string | null; sourceKey: string } },
  f: FeedFilters,
): boolean {
  if (f.minScore > 0 && deal.score < f.minScore) return false;
  if (f.source && deal.item.sourceKey !== f.source) return false;
  if (f.localOnly && !deal.item.location) return false;
  if (f.category && !(deal.item.category ?? "").toLowerCase().includes(f.category.toLowerCase())) return false;
  if (f.q && !deal.item.title.toLowerCase().includes(f.q.toLowerCase())) return false;
  return true;
}

"use client";

/**
 * Sources & Rules: toggle feeds on/off, edit what each worker searches
 * (keyword sets, brand/misspelling seeds, watchlists, config JSON), and
 * manage alert rules with a live "would have matched N deals in the last
 * 24 h" preview powered by the exact server-side matcher.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { usd } from "@/lib/format";
import type { AlertRule, RulePreview, SavedSearch, SourceInfo } from "@/lib/types";
import { EmptyState, SourceBadge } from "@/components/bits";
import { CheckIcon, XIcon } from "@/components/icons";

/* ----------------------------- Sources column ----------------------------- */

function csv(value: unknown): string {
  return Array.isArray(value) ? value.join(", ") : "";
}
function uncsv(text: string): string[] {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function SearchEditor({ search }: { search: SavedSearch }) {
  const queryClient = useQueryClient();
  const params = search.params as {
    kind?: string;
    keywords?: string[];
    brands?: string[];
    asins?: string[];
    label?: string;
    catId?: number;
  };
  const [keywords, setKeywords] = useState(csv(params.keywords));
  const [brands, setBrands] = useState(csv(params.brands));
  const [asins, setAsins] = useState(csv(params.asins));
  const [saved, setSaved] = useState(false);

  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<{ search: SavedSearch }>(`/searches/${search.id}`, { method: "PATCH", body }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["searches"] });
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    },
  });

  const save = () => {
    const next: Record<string, unknown> = { ...params };
    if (params.keywords) next.keywords = uncsv(keywords);
    if (params.brands) next.brands = uncsv(brands);
    if (params.asins) next.asins = uncsv(asins);
    patch.mutate({ params: next });
  };

  const dirty =
    keywords !== csv(params.keywords) || brands !== csv(params.brands) || asins !== csv(params.asins);

  return (
    <div className="rounded-md border border-line bg-raise/40 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-[12px] font-medium text-ink">{search.name}</span>
        <button
          type="button"
          className="switch shrink-0"
          data-on={search.enabled}
          title={search.enabled ? "Disable search" : "Enable search"}
          onClick={() => patch.mutate({ enabled: !search.enabled })}
        />
      </div>
      {params.kind === "category" && (
        <p className="mt-1 text-[10px] text-faint">
          category #{params.catId} {params.label && `· ${params.label}`}
        </p>
      )}
      <div className="mt-2 space-y-2">
        {params.keywords && (
          <div>
            <label className="label">Keywords</label>
            <input className="field py-1.5 text-[12px]" value={keywords} onChange={(e) => setKeywords(e.target.value)} />
          </div>
        )}
        {params.brands && (
          <div>
            <label className="label">Brand seeds (misspellings auto-generated)</label>
            <input className="field py-1.5 text-[12px]" value={brands} onChange={(e) => setBrands(e.target.value)} />
          </div>
        )}
        {params.asins && (
          <div>
            <label className="label">ASIN watchlist</label>
            <input className="field py-1.5 text-[12px]" value={asins} onChange={(e) => setAsins(e.target.value)} />
          </div>
        )}
      </div>
      {(dirty || saved) && (
        <button className="btn btn-acc mt-2 px-2.5 py-1 text-[11px]" onClick={save} disabled={patch.isPending || saved}>
          {saved ? "Saved ✓" : patch.isPending ? "Saving…" : "Save search"}
        </button>
      )}
      {patch.isError && <p className="mt-1 text-[10px] text-loss">{(patch.error as Error).message}</p>}
    </div>
  );
}

function SourceCard({ source, searches }: { source: SourceInfo; searches: SavedSearch[] }) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [configText, setConfigText] = useState(() => JSON.stringify(source.config, null, 2));
  const [configError, setConfigError] = useState<string | null>(null);
  // Keyless discovery = scanning the whole catalog, so the keyword/category
  // lists below are inactive; surface that instead of a misleading count.
  const discovering = Boolean((source.config?.discover as { enabled?: boolean } | undefined)?.enabled);

  const patch = useMutation({
    mutationFn: (body: { enabled?: boolean; config?: Record<string, unknown> }) =>
      api<{ source: SourceInfo }>(`/sources/${source.key}`, { method: "PATCH", body }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["sources"] }),
  });

  const saveConfig = () => {
    setConfigError(null);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(configText) as Record<string, unknown>;
    } catch {
      setConfigError("Not valid JSON");
      return;
    }
    patch.mutate(
      { config: parsed },
      { onError: (err) => setConfigError((err as Error).message) },
    );
  };

  return (
    <div className="glass p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <SourceBadge sourceKey={source.key} />
          <div>
            <p className="flex items-center gap-1.5 text-[13px] font-medium">
              {source.name}
              {discovering && (
                <span
                  className="rounded-full border border-acc/40 bg-acc/10 px-1.5 py-0.5 text-[9px] font-semibold tracking-wide text-acc uppercase"
                  title="Scanning the whole catalog automatically — no keyword lists needed"
                >
                  discovery
                </span>
              )}
            </p>
            <p className="num text-[10px] text-faint">
              {source.itemsLast24h} items/24h · {source.itemsTotal} total ·{" "}
              {discovering ? "no lists needed" : `${source.savedSearches} searches`}
            </p>
          </div>
        </div>
        <button
          type="button"
          className="switch"
          data-on={source.enabled}
          title={source.enabled ? "Disable source" : "Enable source"}
          onClick={() => patch.mutate({ enabled: !source.enabled })}
        />
      </div>

      <button
        className="mt-2 cursor-pointer text-[11px] text-acc/80 hover:text-acc"
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? "▾ hide configuration" : "▸ searches & config"}
      </button>

      {expanded && (
        <div className="mt-3 space-y-2">
          {searches.map((s) => (
            <SearchEditor key={s.id} search={s} />
          ))}
          <div>
            <label className="label">Worker config (zod-validated on save)</label>
            <textarea
              className="field num min-h-28 text-[11px] leading-relaxed"
              value={configText}
              spellCheck={false}
              onChange={(e) => setConfigText(e.target.value)}
            />
            {configError && <p className="mt-1 text-[10px] text-loss">{configError}</p>}
            <button className="btn btn-acc mt-1.5 px-2.5 py-1 text-[11px]" onClick={saveConfig} disabled={patch.isPending}>
              {patch.isPending ? "Saving…" : "Save config"}
            </button>
            <span className="ml-2 text-[10px] text-faint">workers pick changes up next sweep — no restart</span>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------ Rules column ------------------------------ */

const CHANNELS = ["websocket", "discord", "pushover"] as const;

interface RuleDraft {
  name: string;
  minProfit: string;
  minRoi: string;
  maxBuyPrice: string;
  categories: string;
  keywords: string;
  excludeKeywords: string;
  localOnly: boolean;
  channels: string[];
  enabled: boolean;
}

function toDraft(rule: AlertRule | null): RuleDraft {
  return {
    name: rule?.name ?? "New rule",
    minProfit: rule?.minProfit != null ? String(rule.minProfit) : "",
    minRoi: rule?.minRoi != null ? String(rule.minRoi) : "",
    maxBuyPrice: rule?.maxBuyPrice != null ? String(rule.maxBuyPrice) : "",
    categories: rule?.categories.join(", ") ?? "",
    keywords: rule?.keywords.join(", ") ?? "",
    excludeKeywords: rule?.excludeKeywords.join(", ") ?? "",
    localOnly: rule?.localOnly ?? false,
    channels: rule?.channels ?? ["websocket"],
    enabled: rule?.enabled ?? true,
  };
}

function draftToBody(d: RuleDraft) {
  return {
    name: d.name || "Untitled rule",
    minProfit: d.minProfit === "" ? null : Number(d.minProfit),
    minRoi: d.minRoi === "" ? null : Number(d.minRoi),
    maxBuyPrice: d.maxBuyPrice === "" ? null : Number(d.maxBuyPrice),
    categories: uncsv(d.categories),
    keywords: uncsv(d.keywords),
    excludeKeywords: uncsv(d.excludeKeywords),
    localOnly: d.localOnly,
    channels: d.channels.length > 0 ? d.channels : ["websocket"],
    enabled: d.enabled,
  };
}

function RuleEditor({
  rule,
  onDone,
}: {
  rule: AlertRule | null; // null = creating
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<RuleDraft>(() => toDraft(rule));
  const set = <K extends keyof RuleDraft>(key: K, value: RuleDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  // Live preview, debounced against the matcher endpoint.
  const [preview, setPreview] = useState<RulePreview | null>(null);
  useEffect(() => {
    const t = setTimeout(() => {
      api<RulePreview>("/rules/preview", { method: "POST", body: draftToBody(draft) })
        .then(setPreview)
        .catch(() => setPreview(null));
    }, 350);
    return () => clearTimeout(t);
  }, [draft]);

  const save = useMutation({
    mutationFn: () =>
      rule
        ? api<{ rule: AlertRule }>(`/rules/${rule.id}`, { method: "PATCH", body: draftToBody(draft) })
        : api<{ rule: AlertRule }>("/rules", { method: "POST", body: draftToBody(draft) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["rules"] });
      onDone();
    },
  });

  return (
    <div className="space-y-3 rounded-md border border-acc/25 bg-raise/40 p-3">
      <input className="field text-[13px] font-medium" value={draft.name} onChange={(e) => set("name", e.target.value)} />
      <div className="grid grid-cols-3 gap-2">
        {(
          [
            ["minProfit", "Min profit $"],
            ["minRoi", "Min ROI %"],
            ["maxBuyPrice", "Max buy $"],
          ] as const
        ).map(([key, label]) => (
          <div key={key}>
            <label className="label">{label}</label>
            <input
              className="field num py-1.5 text-[12px]"
              inputMode="decimal"
              placeholder="—"
              value={draft[key]}
              onChange={(e) => set(key, e.target.value.replace(/[^0-9.]/g, ""))}
            />
          </div>
        ))}
      </div>
      {(
        [
          ["categories", "Categories (exact, comma-sep)"],
          ["keywords", "Title keywords (any)"],
          ["excludeKeywords", "Exclude keywords"],
        ] as const
      ).map(([key, label]) => (
        <div key={key}>
          <label className="label">{label}</label>
          <input className="field py-1.5 text-[12px]" value={draft[key]} onChange={(e) => set(key, e.target.value)} />
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-4">
        <button type="button" className="flex cursor-pointer items-center gap-2 text-[12px] text-muted" onClick={() => set("localOnly", !draft.localOnly)}>
          <span className="switch" data-on={draft.localOnly} /> local only
        </button>
        <button type="button" className="flex cursor-pointer items-center gap-2 text-[12px] text-muted" onClick={() => set("enabled", !draft.enabled)}>
          <span className="switch" data-on={draft.enabled} /> enabled
        </button>
        <div className="flex items-center gap-2">
          {CHANNELS.map((ch) => (
            <button
              key={ch}
              type="button"
              className={`chip cursor-pointer ${draft.channels.includes(ch) ? "border-acc/50 bg-acc/10 text-acc" : ""}`}
              onClick={() =>
                set(
                  "channels",
                  draft.channels.includes(ch) ? draft.channels.filter((c) => c !== ch) : [...draft.channels, ch],
                )
              }
            >
              {ch}
            </button>
          ))}
        </div>
      </div>

      <div className="rounded border border-acc2/25 bg-acc2/5 px-2.5 py-2 text-[11px]">
        {preview ? (
          <>
            <span className="text-acc2">
              would have matched <span className="num font-semibold">{preview.matched}</span> of {preview.sampled} deals
              in the last 24h
            </span>
            {preview.examples.length > 0 && (
              <ul className="mt-1 space-y-0.5 text-faint">
                {preview.examples.slice(0, 3).map((ex) => (
                  <li key={ex.id} className="truncate">
                    · {ex.title} <span className="num text-profit">{usd(ex.netProfit, { sign: true })}</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <span className="text-faint">computing preview…</span>
        )}
      </div>

      {save.isError && <p className="text-[11px] text-loss">{(save.error as Error).message}</p>}
      <div className="flex gap-2">
        <button className="btn btn-acc flex-1" onClick={() => save.mutate()} disabled={save.isPending}>
          <CheckIcon width={13} height={13} /> {save.isPending ? "Saving…" : rule ? "Save rule" : "Create rule"}
        </button>
        <button className="btn" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function RuleRow({ rule }: { rule: AlertRule }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<{ rule: AlertRule }>(`/rules/${rule.id}`, { method: "PATCH", body }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["rules"] }),
  });
  const remove = useMutation({
    mutationFn: () => api(`/rules/${rule.id}`, { method: "DELETE" }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["rules"] }),
  });

  if (editing) return <RuleEditor rule={rule} onDone={() => setEditing(false)} />;

  const clauses = [
    rule.minProfit != null && `profit ≥ ${usd(rule.minProfit)}`,
    rule.minRoi != null && `ROI ≥ ${rule.minRoi}%`,
    rule.maxBuyPrice != null && `buy ≤ ${usd(rule.maxBuyPrice)}`,
    rule.categories.length > 0 && `cat: ${rule.categories.join("/")}`,
    rule.keywords.length > 0 && `kw: ${rule.keywords.join(", ")}`,
    rule.localOnly && "local only",
  ].filter(Boolean);

  return (
    <div className={`glass p-3.5 ${rule.enabled ? "" : "opacity-55"}`}>
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-[13px] font-medium">{rule.name}</p>
        <div className="flex items-center gap-2">
          <button type="button" className="switch" data-on={rule.enabled} onClick={() => patch.mutate({ enabled: !rule.enabled })} />
          <button className="btn btn-ghost px-2 py-1 text-[11px]" onClick={() => setEditing(true)}>
            edit
          </button>
          <button
            className="btn btn-ghost px-2 py-1 hover:text-loss"
            title="Delete rule"
            onClick={() => remove.mutate()}
            disabled={remove.isPending}
          >
            <XIcon width={12} height={12} />
          </button>
        </div>
      </div>
      <p className="num mt-1 text-[11px] text-muted">{clauses.length > 0 ? clauses.join(" · ") : "matches everything"}</p>
      <div className="mt-1.5 flex gap-1.5">
        {rule.channels.map((ch) => (
          <span key={ch} className="chip">
            {ch}
          </span>
        ))}
      </div>
    </div>
  );
}

/* --------------------------------- Page ---------------------------------- */

export default function SourcesPage() {
  const sources = useQuery({
    queryKey: ["sources"],
    queryFn: () => api<{ sources: SourceInfo[] }>("/sources"),
  });
  const searches = useQuery({
    queryKey: ["searches"],
    queryFn: () => api<{ searches: SavedSearch[] }>("/searches"),
  });
  const rules = useQuery({ queryKey: ["rules"], queryFn: () => api<{ rules: AlertRule[] }>("/rules") });
  const [creating, setCreating] = useState(false);

  const searchesBySource = useMemo(() => {
    const map = new Map<string, SavedSearch[]>();
    for (const s of searches.data?.searches ?? []) {
      map.set(s.sourceKey, [...(map.get(s.sourceKey) ?? []), s]);
    }
    return map;
  }, [searches.data]);

  return (
    <div className="mx-auto grid max-w-6xl items-start gap-5 lg:grid-cols-2">
      <section>
        <h2 className="label mb-2">Sources</h2>
        <div className="space-y-3">
          {sources.isLoading &&
            Array.from({ length: 3 }, (_, i) => <div key={i} className="glass glass-flat h-20 animate-pulse" />)}
          {sources.data?.sources.map((s) => (
            <SourceCard key={s.key} source={s} searches={searchesBySource.get(s.key) ?? []} />
          ))}
          {sources.isError && <EmptyState title="Failed to load sources" />}
        </div>
      </section>

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="label mb-0">Alert rules</h2>
          <button className="btn btn-acc px-2.5 py-1 text-[12px]" onClick={() => setCreating(true)}>
            + New rule
          </button>
        </div>
        <div className="space-y-3">
          {creating && <RuleEditor rule={null} onDone={() => setCreating(false)} />}
          {rules.isLoading &&
            Array.from({ length: 2 }, (_, i) => <div key={i} className="glass glass-flat h-20 animate-pulse" />)}
          {rules.data?.rules.map((r) => (
            <RuleRow key={r.id} rule={r} />
          ))}
          {rules.data?.rules.length === 0 && !creating && (
            <EmptyState title="No alert rules yet" hint="Create one — deals matching it push to your channels instantly." />
          )}
        </div>
      </section>
    </div>
  );
}

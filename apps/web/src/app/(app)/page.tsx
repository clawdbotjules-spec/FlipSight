"use client";

/**
 * Live Deal Feed — the home screen. Server pages stream in through
 * useInfiniteQuery; realtime deals arrive over the WebSocket and are prepended
 * into the same cache (single source of truth). The list is window-virtualized
 * so thousands of rows scroll at 60 fps, and fresh arrivals get one glow pulse.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useInfiniteQuery, useMutation, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { api } from "@/lib/api";
import type { Deal, WsDealMessage } from "@/lib/types";
import { useWs } from "@/components/ws";
import { DealCard } from "@/components/deal-card";
import { DEFAULT_FILTERS, FilterBar, dealMatchesFilters, type FeedFilters } from "@/components/filter-bar";
import { EmptyState } from "@/components/bits";

const DealDrawer = dynamic(() => import("@/components/deal-drawer"), { ssr: false });

interface DealsPage {
  deals: Deal[];
  nextCursor: string | null;
}

const PAGE_SIZE = 50;

function feedQueryKey(filters: FeedFilters) {
  return ["deals", filters] as const;
}

function filtersEqual(a: FeedFilters, b: FeedFilters): boolean {
  return (
    a.q === b.q &&
    a.source === b.source &&
    a.category === b.category &&
    a.minScore === b.minScore &&
    a.localOnly === b.localOnly
  );
}

function buildQuery(filters: FeedFilters, cursor?: string): string {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (cursor) params.set("cursor", cursor);
  if (filters.q.trim()) params.set("q", filters.q.trim());
  if (filters.source) params.set("source", filters.source);
  if (filters.category.trim()) params.set("category", filters.category.trim());
  if (filters.minScore > 0) params.set("minScore", String(filters.minScore));
  if (filters.localOnly) params.set("localOnly", "true");
  return `/deals?${params.toString()}`;
}

export default function FeedPage() {
  const queryClient = useQueryClient();
  const { subscribe } = useWs();
  const [filters, setFilters] = useState<FeedFilters>(DEFAULT_FILTERS);
  const [debounced, setDebounced] = useState<FeedFilters>(DEFAULT_FILTERS);
  const [openId, setOpenId] = useState<string | null>(null);
  const [freshIds, setFreshIds] = useState<Set<string>>(new Set());
  const filtersRef = useRef(debounced);
  filtersRef.current = debounced;

  // Debounce text inputs so typing doesn't refetch per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(filters), 250);
    return () => clearTimeout(t);
  }, [filters]);

  const query = useInfiniteQuery({
    queryKey: feedQueryKey(debounced),
    queryFn: ({ pageParam }) => {
      // Adopt the request the inline <head> script fired at HTML-parse time
      // (only valid for the default first page — see layout.tsx).
      if (!pageParam && filtersEqual(debounced, DEFAULT_FILTERS)) {
        const preload = (window as { __dealsPreload?: Promise<DealsPage> }).__dealsPreload;
        if (preload) {
          delete (window as { __dealsPreload?: Promise<DealsPage> }).__dealsPreload;
          return preload.catch(() => api<DealsPage>(buildQuery(debounced, pageParam)));
        }
      }
      return api<DealsPage>(buildQuery(debounced, pageParam));
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 30_000,
  });

  const deals = useMemo(() => {
    const seen = new Set<string>();
    const list: Deal[] = [];
    for (const page of query.data?.pages ?? []) {
      for (const deal of page.deals) {
        if (!seen.has(deal.id)) {
          seen.add(deal.id);
          list.push(deal);
        }
      }
    }
    return list;
  }, [query.data]);

  // Realtime: prepend matching deals into the first cached page + glow.
  useEffect(
    () =>
      subscribe((msg: WsDealMessage) => {
        const deal = msg.deal;
        if (!dealMatchesFilters(deal, filtersRef.current)) return;
        queryClient.setQueryData<InfiniteData<DealsPage, string | undefined>>(
          feedQueryKey(filtersRef.current),
          (data) => {
            if (!data || data.pages.length === 0) return data;
            const exists = data.pages.some((p) => p.deals.some((d) => d.id === deal.id));
            if (exists) return data;
            const [first, ...rest] = data.pages;
            return { ...data, pages: [{ ...first, deals: [deal, ...first.deals] }, ...rest] };
          },
        );
        setFreshIds((prev) => new Set(prev).add(deal.id));
        setTimeout(() => {
          setFreshIds((prev) => {
            const next = new Set(prev);
            next.delete(deal.id);
            return next;
          });
        }, 2400);
      }),
    [subscribe, queryClient],
  );

  const patchDealInCache = useCallback(
    (updated: Deal) => {
      queryClient.setQueriesData<InfiniteData<DealsPage, string | undefined>>(
        { queryKey: ["deals"] },
        (data) =>
          data && {
            ...data,
            pages: data.pages.map((p) => ({
              ...p,
              deals: p.deals.map((d) => (d.id === updated.id ? { ...d, ...updated } : d)),
            })),
          },
      );
    },
    [queryClient],
  );

  const claim = useMutation({
    mutationFn: (id: string) => api<{ deal: Deal }>(`/deals/${id}/claim`, { method: "POST" }),
    onSuccess: (res) => patchDealInCache(res.deal),
  });
  const dismiss = useMutation({
    mutationFn: (id: string) => api<{ deal: Deal }>(`/deals/${id}/dismiss`, { method: "POST" }),
    onSuccess: (res) => patchDealInCache(res.deal),
  });

  // Window virtualization — the page itself scrolls, rows are absolute.
  // The list div doesn't exist until data arrives (skeleton renders first),
  // so measure its offset via callback ref, whenever it actually mounts.
  const listRef = useRef<HTMLDivElement | null>(null);
  const [listOffset, setListOffset] = useState(0);
  const attachList = useCallback((el: HTMLDivElement | null) => {
    listRef.current = el;
    if (el) setListOffset(el.offsetTop);
  }, []);
  const virtualizer = useWindowVirtualizer({
    count: deals.length,
    estimateSize: () => 145,
    overscan: 4,
    scrollMargin: listOffset,
    getItemKey: (i) => deals[i]?.id ?? i,
  });

  // Infinite scroll: fetch the next page as the tail approaches.
  const virtualItems = virtualizer.getVirtualItems();
  useEffect(() => {
    const last = virtualItems[virtualItems.length - 1];
    if (!last) return;
    if (last.index >= deals.length - 8 && query.hasNextPage && !query.isFetchingNextPage) {
      void query.fetchNextPage();
    }
  }, [virtualItems, deals.length, query]);

  return (
    <div className="mx-auto max-w-4xl">
      <header className="mb-3 flex items-end justify-between gap-3 px-0.5">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Live Deal Feed</h1>
          <p className="text-[12px] text-muted">
            Underpriced listings surface here the moment the valuation engine scores them — eBay · Amazon ·
            ShopGoodwill · Walmart · Target · EstateSales, matched against your alert rules in real time.
          </p>
        </div>
      </header>
      <FilterBar filters={filters} onChange={setFilters} />

      {query.isLoading && (
        <div className="space-y-3">
          <div className="glass glass-flat flex h-[106px] items-center justify-center px-6">
            <p className="pulse-dot text-center text-[13px] text-faint">
              connecting to the deal stream…
            </p>
          </div>
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="glass glass-flat h-[106px] animate-pulse" style={{ animationDelay: `${i * 80}ms` }} />
          ))}
        </div>
      )}

      {query.isError && (
        <EmptyState title="Failed to load the feed" hint={(query.error as Error).message} />
      )}

      {query.isSuccess && deals.length === 0 && (
        <EmptyState
          title="No deals match the current filters"
          hint="Workers publish here in real time — try `npm run seed:item` or loosen the filters."
        />
      )}

      {deals.length > 0 && (
        <div ref={attachList} className="relative" style={{ height: virtualizer.getTotalSize() }}>
          {virtualItems.map((row) => {
            const deal = deals[row.index];
            if (!deal) return null;
            return (
              <div
                key={row.key}
                ref={virtualizer.measureElement}
                data-index={row.index}
                className="absolute inset-x-0 pb-3"
                style={{ transform: `translateY(${row.start - virtualizer.options.scrollMargin}px)` }}
              >
                <DealCard
                  deal={deal}
                  fresh={freshIds.has(deal.id)}
                  onOpen={setOpenId}
                  onClaim={(id) => claim.mutate(id)}
                  onDismiss={(id) => dismiss.mutate(id)}
                  busy={claim.isPending || dismiss.isPending}
                />
              </div>
            );
          })}
        </div>
      )}

      {query.isFetchingNextPage && (
        <p className="num py-3 text-center text-[11px] text-faint">loading more…</p>
      )}

      {openId && (
        <DealDrawer
          dealId={openId}
          onClose={() => setOpenId(null)}
          onClaim={(id) => claim.mutate(id)}
          onDismiss={(id) => dismiss.mutate(id)}
        />
      )}
    </div>
  );
}

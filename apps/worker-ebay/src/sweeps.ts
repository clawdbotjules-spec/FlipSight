/**
 * The three eBay sweep processors:
 *  - saved-search: DB-driven keyword sets + programmatic brand misspellings
 *  - ending-soon: auctions closing within N minutes with zero/low bids
 *  - newly-listed: fresh BIN listings in configured categories
 */
import {
  EbaySearchParamsSchema,
  EbaySourceConfigSchema,
  buildSearchQueries,
  type EbaySourceConfig,
} from "@flipsight/shared";
import { summaryLocation, summaryPrice, type EbayClient, type EbayItemSummary } from "@flipsight/clients";
import { enqueueValuate, upsertItem, VALUATE_QUEUE, type WorkerApp } from "@flipsight/worker-core";

interface SweepTotals {
  found: number;
  created: number;
  updated: number;
  valuateEnqueued: number;
}

async function ingestSummaries(
  app: WorkerApp,
  sourceId: string,
  summaries: EbayItemSummary[],
  totals: SweepTotals,
  minPrice = 0,
): Promise<void> {
  const valuateQueue = app.queue(VALUATE_QUEUE);
  for (const summary of summaries) {
    const price = summaryPrice(summary);
    if (price === null || price < minPrice) continue;
    totals.found += 1;
    const { item, created, priceChanged } = await upsertItem(app.prisma, {
      sourceId,
      externalId: summary.itemId,
      title: summary.title,
      sourceUrl: summary.itemWebUrl,
      currentPrice: price,
      condition: summary.condition ?? null,
      category: summary.categories?.[0]?.categoryName ?? null,
      imageUrls: [
        ...(summary.image?.imageUrl ? [summary.image.imageUrl] : []),
        ...(summary.additionalImages?.map((i) => i.imageUrl) ?? []),
      ].slice(0, 6),
      location: summaryLocation(summary),
      endsAt: summary.itemEndDate ? new Date(summary.itemEndDate) : null,
      bidsCount: summary.bidCount ?? null,
      raw: summary,
    });
    if (created) totals.created += 1;
    else totals.updated += 1;
    if (created || priceChanged) {
      await enqueueValuate(valuateQueue, { itemId: item.id, reason: created ? "new_item" : "price_change" });
      totals.valuateEnqueued += 1;
    }
  }
}

function priceFilter(min?: number, max?: number): string[] {
  if (min == null && max == null) return [];
  return [`price:[${min ?? ""}..${max ?? ""}]`, "priceCurrency:USD"];
}

/** Saved-search sweep — rotates through keyword + misspelling queries. */
export function makeSavedSearchSweep(app: WorkerApp, client: EbayClient) {
  return async () => {
    const cfg = await app.getSourceConfig(EbaySourceConfigSchema, "ebay");
    if (!warmupOk(app, client)) return { skipped: "no_credentials" };
    const source = await app.getSource("ebay");
    const searches = await app.loadSavedSearches("ebay");
    const checkpoints = app.checkpoints("ebay");
    const totals: SweepTotals = { found: 0, created: 0, updated: 0, valuateEnqueued: 0 };
    const startedAt = Date.now();
    let queriesRun = 0;

    for (const search of searches) {
      if (app.isClosing) break; // SIGTERM: yield between searches
      const parsed = EbaySearchParamsSchema.safeParse(search.params);
      if (!parsed.success || parsed.data.kind !== "keywords") continue;
      const params = parsed.data;

      const queries = buildSearchQueries({
        keywords: params.keywords,
        brands: params.brands,
        maxMisspellingsPerBrand: cfg.search.maxMisspellingsPerBrand,
      });
      if (queries.length === 0) continue;

      // Rotate through the query list across sweeps so long lists all get
      // coverage without exceeding the per-sweep budget.
      const rotationKey = `search-rotation:${search.id}`;
      const offset = (await checkpoints.get<number>(rotationKey)) ?? 0;
      const budget = Math.max(1, Math.floor(cfg.search.maxQueriesPerSweep / Math.max(1, searches.length)));
      const slice: string[] = [];
      for (let i = 0; i < Math.min(budget, queries.length); i++) {
        slice.push(queries[(offset + i) % queries.length]!);
      }
      await checkpoints.set(rotationKey, (offset + slice.length) % queries.length);

      for (const q of slice) {
        if (app.isClosing) break; // SIGTERM: finish current query only
        const filters = [
          ...priceFilter(params.minPrice, params.maxPrice),
          ...(params.buyingOption !== "ANY" ? [`buyingOptions:{${params.buyingOption}}`] : []),
        ];
        const { items } = await client.searchItems({
          q,
          categoryIds: params.categoryIds,
          filters,
          limit: cfg.search.resultLimitPerQuery,
        });
        queriesRun += 1;
        await ingestSummaries(app, source.id, items, totals);
      }
    }

    app.setHealth({ lastSavedSearchSweepAt: new Date().toISOString() });
    app.log.info(
      { event: "sweep_completed", sweep: "saved-search", queriesRun, ...totals, durationMs: Date.now() - startedAt },
      "saved-search sweep done",
    );
    return { queriesRun, ...totals };
  };
}

/** Auctions ending within the configured window with zero/low bids. */
export function makeEndingSoonSweep(app: WorkerApp, client: EbayClient) {
  return async () => {
    const cfg = await app.getSourceConfig(EbaySourceConfigSchema, "ebay");
    if (!warmupOk(app, client)) return { skipped: "no_credentials" };
    const source = await app.getSource("ebay");
    const totals: SweepTotals = { found: 0, created: 0, updated: 0, valuateEnqueued: 0 };
    const startedAt = Date.now();

    const endBefore = new Date(Date.now() + cfg.endingSoon.withinMinutes * 60_000).toISOString();
    const { items } = await client.searchItems({
      categoryIds: cfg.endingSoon.categoryIds,
      filters: [
        "buyingOptions:{AUCTION}",
        `itemEndDate:[..${endBefore}]`,
        ...priceFilter(cfg.endingSoon.minPrice, cfg.endingSoon.maxPrice),
      ],
      limit: 100,
    });
    const lowBid = items.filter((i) => (i.bidCount ?? 0) <= cfg.endingSoon.maxBids);
    await ingestSummaries(app, source.id, lowBid, totals, cfg.endingSoon.minPrice);

    app.setHealth({ lastEndingSoonSweepAt: new Date().toISOString() });
    app.log.info(
      {
        event: "sweep_completed",
        sweep: "ending-soon",
        withinMinutes: cfg.endingSoon.withinMinutes,
        candidates: items.length,
        lowBid: lowBid.length,
        ...totals,
        durationMs: Date.now() - startedAt,
      },
      "ending-soon sweep done",
    );
    return totals;
  };
}

/** Newly listed fixed-price items in configured categories. */
export function makeNewlyListedSweep(app: WorkerApp, client: EbayClient) {
  return async () => {
    const cfg = await app.getSourceConfig(EbaySourceConfigSchema, "ebay");
    if (!warmupOk(app, client)) return { skipped: "no_credentials" };
    if (cfg.newlyListed.categoryIds.length === 0) return { skipped: "no_categories_configured" };
    const source = await app.getSource("ebay");
    const checkpoints = app.checkpoints("ebay");
    const totals: SweepTotals = { found: 0, created: 0, updated: 0, valuateEnqueued: 0 };
    const startedAt = Date.now();

    const checkpointKey = "newly-listed:last-creation-date";
    const lastSeen = (await checkpoints.get<string>(checkpointKey)) ?? new Date(Date.now() - 3600_000).toISOString();
    let maxSeen = lastSeen;

    const { items } = await client.searchItems({
      categoryIds: cfg.newlyListed.categoryIds,
      filters: ["buyingOptions:{FIXED_PRICE}"],
      sort: "newlyListed",
      limit: 100,
    });
    const fresh = items.filter((i) => (i.itemCreationDate ?? "") > lastSeen);
    for (const item of fresh) {
      if ((item.itemCreationDate ?? "") > maxSeen) maxSeen = item.itemCreationDate!;
    }
    await ingestSummaries(app, source.id, fresh, totals);
    await checkpoints.set(checkpointKey, maxSeen);

    app.setHealth({ lastNewlyListedSweepAt: new Date().toISOString() });
    app.log.info(
      { event: "sweep_completed", sweep: "newly-listed", fresh: fresh.length, ...totals, durationMs: Date.now() - startedAt },
      "newly-listed sweep done",
    );
    return totals;
  };
}

let warnedNoCreds = false;
function warmupOk(app: WorkerApp, client: EbayClient): boolean {
  if (client.isConfigured()) return true;
  if (!warnedNoCreds) {
    warnedNoCreds = true;
    app.log.warn(
      { event: "ebay_credentials_missing" },
      "EBAY_CLIENT_ID / EBAY_CLIENT_SECRET not set — eBay sweeps idle until configured",
    );
  }
  return false;
}

export type { EbaySourceConfig };

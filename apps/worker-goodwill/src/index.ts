/**
 * worker-goodwill — polls ShopGoodwill's public listings for the configured
 * categories (DB-driven SavedSearch rows), extracts title / current bid /
 * ends-at / images, upserts Items, and enqueues valuate jobs.
 *
 * Politeness: token bucket at ~1 request / 2.5s plus randomized jitter,
 * per-host robots.txt checking through the shared guard, and content-hash
 * caching so unchanged pages are skipped without re-processing.
 */
import {
  GoodwillSearchParamsSchema,
  GoodwillSourceConfigSchema,
  type GoodwillSourceConfig,
} from "@flipsight/shared";
import {
  contentHash,
  DEFAULT_USER_AGENT,
  enqueueValuate,
  HttpClient,
  politeDelay,
  RobotsGuard,
  TokenBucket,
  upsertItem,
  VALUATE_QUEUE,
  WorkerApp,
} from "@flipsight/worker-core";
import { itemUrl, pacificToUtc, searchCategory } from "./client.js";

const QUEUE = "goodwill";

const app = await WorkerApp.create({ name: "worker-goodwill", sourceKey: "shopgoodwill" });
const bootCfg = await app.getSourceConfig(GoodwillSourceConfigSchema);

const bucket = new TokenBucket({
  name: "shopgoodwill",
  ratePerSec: bootCfg.requestsPerSec,
  burst: 1,
  log: app.log,
});
const robots = new RobotsGuard({
  userAgent: DEFAULT_USER_AGENT,
  agentToken: "flipsightbot",
  log: app.log,
  policies: bootCfg.robotsPolicy,
  defaultPolicy: "enforce",
});
const http = new HttpClient({
  name: "goodwill",
  log: app.log,
  bucket,
  robots,
  checkpoints: app.checkpoints(),
});

interface SweepTotals {
  pages: number;
  unchangedPages: number;
  found: number;
  created: number;
  updated: number;
  valuateEnqueued: number;
}

/**
 * Scan one page list (a category or the global catalog), upsert every item at
 * or above minPrice, and enqueue a valuate job for new/repriced ones. The
 * content-hash cache skips pages that haven't changed since last sweep so we
 * never re-process (or re-value) unchanged listings.
 */
async function scanPages(
  opts: {
    catId: number | null;
    label: string | null;
    maxPages: number;
    hashScope: string;
  },
  cfg: GoodwillSourceConfig,
  totals: SweepTotals,
): Promise<void> {
  const source = await app.getSource();
  const checkpoints = app.checkpoints();
  const valuateQueue = app.queue(VALUATE_QUEUE);

  for (let page = 1; page <= opts.maxPages; page++) {
    if (app.isClosing) break; // SIGTERM: finish current page only
    await politeDelay(cfg.jitterMs.min, cfg.jitterMs.max);
    const { items } = await searchCategory(http, { catId: opts.catId, page, pageSize: cfg.pageSize });
    totals.pages += 1;
    if (items.length === 0) break;

    const hashKey = `page-hash:${opts.hashScope}:${page}`;
    const hash = contentHash(items.map((i) => [i.itemId, i.currentPrice, i.numBids]));
    const previous = await checkpoints.get<string>(hashKey);
    if (previous === hash) {
      totals.unchangedPages += 1;
      app.log.debug({ event: "page_unchanged", scope: opts.hashScope, page }, "page unchanged — skipping");
      continue;
    }

    for (const listing of items) {
      const price = listing.currentPrice > 0 ? listing.currentPrice : listing.minimumBid;
      if (!Number.isFinite(price) || price < cfg.minPrice) continue;
      totals.found += 1;
      const { item, created, priceChanged } = await upsertItem(app.prisma, {
        sourceId: source.id,
        externalId: String(listing.itemId),
        title: listing.title,
        sourceUrl: itemUrl(listing.itemId),
        currentPrice: price,
        // In discovery mode we don't know a curated label — carry the source's
        // own category name so the UI/comps still have context.
        category: opts.label ?? listing.categoryName ?? null,
        condition: null,
        imageUrls: listing.imageURL ? [listing.imageURL.replace(/\\/g, "/")] : [],
        endsAt: pacificToUtc(listing.endTime),
        bidsCount: listing.numBids,
        raw: { ...listing, sourceCategory: listing.categoryName },
      });
      if (created) totals.created += 1;
      else totals.updated += 1;
      if (created || priceChanged) {
        await enqueueValuate(valuateQueue, { itemId: item.id, reason: created ? "new_item" : "price_change" });
        totals.valuateEnqueued += 1;
      }
    }
    await checkpoints.set(hashKey, hash);
  }
}

app.process(QUEUE, async () => {
  const cfg = await app.getSourceConfig(GoodwillSourceConfigSchema);
  const startedAt = Date.now();
  const totals: SweepTotals = { pages: 0, unchangedPages: 0, found: 0, created: 0, updated: 0, valuateEnqueued: 0 };

  if (cfg.discover.enabled) {
    // Keyless firehose: the whole ShopGoodwill catalog, ending-soonest first,
    // so mispriced auctions get valued while there's still time to bid. No
    // saved searches or keyword lists required.
    await scanPages(
      { catId: null, label: null, maxPages: cfg.discover.maxPagesPerSweep, hashScope: "discover" },
      cfg,
      totals,
    );
    app.setHealth({ lastSweepAt: new Date().toISOString(), mode: "discover", lastSweep: totals });
    app.log.info(
      { event: "sweep_completed", sweep: "discover", ...totals, durationMs: Date.now() - startedAt },
      "goodwill discovery sweep done",
    );
    return totals;
  }

  // Targeted mode: DB-driven category subscriptions (set discover.enabled=false).
  const searches = await app.loadSavedSearches();
  for (const search of searches) {
    if (app.isClosing) break; // SIGTERM: stop between categories, keep partial totals
    const parsed = GoodwillSearchParamsSchema.safeParse(search.params);
    if (!parsed.success) {
      app.log.warn({ searchId: search.id, issues: parsed.error.issues.slice(0, 3) }, "invalid goodwill search params");
      continue;
    }
    const { catId, label } = parsed.data;
    await scanPages({ catId, label, maxPages: cfg.maxPagesPerCategory, hashScope: String(catId) }, cfg, totals);
  }

  app.setHealth({ lastSweepAt: new Date().toISOString(), mode: "categories", lastSweep: totals });
  app.log.info(
    { event: "sweep_completed", sweep: "categories", searches: searches.length, ...totals, durationMs: Date.now() - startedAt },
    "goodwill sweep done",
  );
  return totals;
});

await app.scheduleEvery(QUEUE, "goodwill:categories", bootCfg.sweepEverySec * 1000, "sweep:categories");
app.log.info({ sweepEverySec: bootCfg.sweepEverySec, requestsPerSec: bootCfg.requestsPerSec }, "worker-goodwill ready");

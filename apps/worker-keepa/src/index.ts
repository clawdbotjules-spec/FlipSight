/**
 * worker-keepa — tracks a DB-driven ASIN watchlist plus best-seller ranges,
 * stores price-history snapshots, detects price drops > X% below the 90-day
 * average, and flags "Amazon pricing error" candidates (price < 40% of the
 * 90-day median). Confirmed anomalies get a keepa-sourced Valuation + Deal
 * immediately and are also handed to the valuate queue for eBay cross-check.
 */
import { decN } from "@flipsight/db";
import {
  KeepaSearchParamsSchema,
  KeepaSourceConfigSchema,
  buildDealAlertPayload,
  computeDealEconomics,
  computeWindowStats,
  parseKeepaSeries,
  scoreDeal,
} from "@flipsight/shared";
import {
  enqueueValuate,
  TokenBucket,
  upsertItem,
  VALUATE_QUEUE,
  WorkerApp,
} from "@flipsight/worker-core";
import { amazonUrl, keepaImageUrls, KeepaClient, type KeepaProduct } from "./keepa-client.js";

const QUEUE = "keepa";

const app = await WorkerApp.create({ name: "worker-keepa", sourceKey: "keepa_amazon" });
const bootCfg = await app.getSourceConfig(KeepaSourceConfigSchema);

const bucket = new TokenBucket({
  name: "keepa-tokens",
  ratePerSec: bootCfg.tokensPerMin / 60,
  burst: Math.max(bootCfg.batchSize, 5),
  log: app.log,
});
const client = new KeepaClient({
  apiKey: process.env.KEEPA_API_KEY,
  domain: bootCfg.domain,
  bucket,
  log: app.log,
});

let warnedNoKey = false;
function configured(): boolean {
  if (client.isConfigured()) return true;
  if (!warnedNoKey) {
    warnedNoKey = true;
    app.log.warn({ event: "keepa_credentials_missing" }, "KEEPA_API_KEY not set — keepa sweeps idle until configured");
  }
  return false;
}

interface ProcessTotals {
  products: number;
  snapshots: number;
  priceDrops: number;
  pricingErrors: number;
  dealsCreated: number;
  valuateEnqueued: number;
}

async function processProducts(products: KeepaProduct[], totals: ProcessTotals): Promise<void> {
  const cfg = await app.getSourceConfig(KeepaSourceConfigSchema);
  const source = await app.getSource();
  const valuateQueue = app.queue(VALUATE_QUEUE);

  for (const product of products) {
    totals.products += 1;
    const amazonSeries = parseKeepaSeries(product.csv?.[0]);
    const newSeries = parseKeepaSeries(product.csv?.[1]);
    const series = amazonSeries.length >= 2 ? amazonSeries : newSeries;
    if (series.length === 0) continue;

    const stats = computeWindowStats(series, 90);
    const current = stats.current;
    if (current == null || current <= 0) continue;

    const dropPct =
      stats.avg != null && stats.avg > 0 ? Math.round(((stats.avg - current) / stats.avg) * 1000) / 10 : 0;
    const pctOfMedian =
      stats.median != null && stats.median > 0 ? Math.round((current / stats.median) * 1000) / 10 : 100;
    const isPriceDrop = dropPct >= cfg.priceDropPctBelowAvg90;
    const isPricingError = pctOfMedian <= cfg.pricingErrorPctOfMedian90;

    const { item, created, priceChanged } = await upsertItem(app.prisma, {
      sourceId: source.id,
      externalId: product.asin,
      title: product.title ?? product.asin,
      sourceUrl: amazonUrl(product.asin),
      currentPrice: current,
      asin: product.asin,
      upc: product.upcList?.[0] ?? null,
      category: product.categoryTree?.at(-1)?.name ?? null,
      imageUrls: keepaImageUrls(product.imagesCSV),
      raw: {
        brand: product.brand ?? null,
        stats: { avg90: stats.avg, median90: stats.median, min90: stats.min, samples: stats.count },
        flags: { priceDrop: isPriceDrop, pricingError: isPricingError, dropPct, pctOfMedian },
      },
    });

    await app.prisma.priceSnapshot.create({
      data: {
        itemId: item.id,
        price: current,
        stats: { avg90: stats.avg, median90: stats.median, min90: stats.min, dropPct, pctOfMedian },
      },
    });
    totals.snapshots += 1;

    if (isPriceDrop) totals.priceDrops += 1;
    if (isPricingError) totals.pricingErrors += 1;

    if (isPriceDrop || isPricingError) {
      app.log.info(
        {
          event: isPricingError ? "pricing_error_candidate" : "price_drop_detected",
          asin: product.asin,
          title: (product.title ?? "").slice(0, 60),
          current,
          avg90: stats.avg,
          median90: stats.median,
          dropPct,
          pctOfMedian,
        },
        isPricingError ? "Amazon pricing error candidate" : "price drop below 90-day average",
      );

      const dealCreated = await maybeCreateKeepaDeal(item.id, product, current, stats.median ?? stats.avg ?? 0);
      if (dealCreated) totals.dealsCreated += 1;

      await enqueueValuate(valuateQueue, {
        itemId: item.id,
        reason: isPricingError ? "amazon_pricing_error" : "amazon_price_drop",
      });
      totals.valuateEnqueued += 1;
    } else if (created || priceChanged) {
      await enqueueValuate(valuateQueue, { itemId: item.id, reason: created ? "new_item" : "price_change" });
      totals.valuateEnqueued += 1;
    }
  }
}

/** Deal from Keepa's own history: buy at current, resale ≈ discounted median90. */
async function maybeCreateKeepaDeal(
  itemId: string,
  product: KeepaProduct,
  current: number,
  median90: number,
): Promise<boolean> {
  const cfg = await app.getSourceConfig(KeepaSourceConfigSchema);
  if (median90 <= 0) return false;

  const estimatedResale = Math.round(median90 * (1 - cfg.valuation.resaleDiscountPct / 100) * 100) / 100;
  const econ = computeDealEconomics({ buyPrice: current, estimatedResale });
  if (econ.netProfit < cfg.valuation.minNetProfit || econ.roiPct < cfg.valuation.minRoiPct) return false;

  const openDeal = await app.prisma.deal.findFirst({
    where: { itemId, status: { in: ["new", "alerted", "claimed"] } },
  });
  if (openDeal && Math.abs(decN(openDeal.buyPrice) - current) < 0.01) return false;

  const item = await app.prisma.item.findUniqueOrThrow({ where: { id: itemId }, include: { source: true } });
  const valuation = await app.prisma.valuation.create({
    data: {
      itemId,
      estimatedResale,
      resaleLow: Math.min(estimatedResale, median90 * 0.85),
      resaleHigh: median90,
      soldCompsCount: 0,
      sellThroughRate: null,
      compSource: "keepa",
    },
  });
  const score = scoreDeal({ netProfit: econ.netProfit, roiPct: econ.roiPct, sellThroughRate: null, soldCompsCount: 0 });
  const deal = await app.prisma.deal.create({
    data: {
      itemId,
      valuationId: valuation.id,
      buyPrice: econ.buyPrice,
      estFees: econ.estFees,
      estShipping: econ.estShipping,
      netProfit: econ.netProfit,
      roiPct: econ.roiPct,
      score,
    },
  });

  await app.publishDealPayload(
    buildDealAlertPayload({
      deal: {
        id: deal.id,
        status: deal.status,
        buyPrice: econ.buyPrice,
        estFees: econ.estFees,
        estShipping: econ.estShipping,
        netProfit: econ.netProfit,
        roiPct: econ.roiPct,
        score,
        createdAt: deal.createdAt,
      },
      item: {
        id: item.id,
        title: item.title,
        category: item.category,
        condition: item.condition,
        imageUrls: item.imageUrls,
        sourceUrl: item.sourceUrl,
        currentPrice: current,
        location: item.location,
        sourceKey: "keepa_amazon",
      },
      valuation: {
        id: valuation.id,
        estimatedResale,
        resaleLow: decN(valuation.resaleLow),
        resaleHigh: decN(valuation.resaleHigh),
        soldCompsCount: 0,
        sellThroughRate: null,
        compSource: "keepa",
      },
    }),
  );
  app.log.info(
    { event: "deal_created", dealId: deal.id, asin: product.asin, netProfit: econ.netProfit, score },
    "keepa deal created and published",
  );
  return true;
}

app.process(QUEUE, async (job) => {
  if (!configured()) return { skipped: "no_credentials" };
  const cfg = await app.getSourceConfig(KeepaSourceConfigSchema);
  const searches = await app.loadSavedSearches();
  const totals: ProcessTotals = {
    products: 0,
    snapshots: 0,
    priceDrops: 0,
    pricingErrors: 0,
    dealsCreated: 0,
    valuateEnqueued: 0,
  };
  const startedAt = Date.now();

  if (job.name === "sweep:watchlist") {
    const asins = new Set<string>();
    for (const search of searches) {
      const parsed = KeepaSearchParamsSchema.safeParse(search.params);
      if (parsed.success && parsed.data.kind === "asin_watchlist") {
        for (const asin of parsed.data.asins) asins.add(asin.toUpperCase());
      }
    }
    const list = [...asins];
    for (let i = 0; i < list.length; i += cfg.batchSize) {
      const products = await client.products(list.slice(i, i + cfg.batchSize));
      await processProducts(products, totals);
    }
  } else if (job.name === "sweep:bestsellers") {
    for (const search of searches) {
      const parsed = KeepaSearchParamsSchema.safeParse(search.params);
      if (!parsed.success || parsed.data.kind !== "bestsellers") continue;
      const { categoryId, rankFrom, rankTo } = parsed.data;
      const asins = (await client.bestSellers(categoryId)).slice(rankFrom - 1, rankTo);
      for (let i = 0; i < asins.length; i += cfg.batchSize) {
        const products = await client.products(asins.slice(i, i + cfg.batchSize));
        await processProducts(products, totals);
      }
    }
  } else {
    throw new Error(`unknown job ${job.name}`);
  }

  app.setHealth({ lastSweepAt: new Date().toISOString(), tokensLeft: client.tokensLeft, lastSweep: totals });
  app.log.info(
    { event: "sweep_completed", sweep: job.name, ...totals, tokensLeft: client.tokensLeft, durationMs: Date.now() - startedAt },
    "keepa sweep done",
  );
  return totals;
});

await app.scheduleEvery(QUEUE, "keepa:watchlist", bootCfg.sweeps.watchlistEverySec * 1000, "sweep:watchlist");
await app.scheduleEvery(QUEUE, "keepa:bestsellers", bootCfg.sweeps.bestsellersEverySec * 1000, "sweep:bestsellers");
app.setHealth({ keepaConfigured: client.isConfigured() });
app.log.info({ configured: client.isConfigured(), sweeps: bootCfg.sweeps }, "worker-keepa ready");

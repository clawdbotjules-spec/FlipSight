/**
 * The valuation pipeline, one job per new/updated Item:
 *   identify → comp (IQR-trimmed eBay sold + Keepa) → economics (per-category
 *   fees + shipping table) → score v2 (time pressure, risk flags) → Deal →
 *   publish deals:new → Discord/Pushover AlertEvents.
 */
import { decN, type Prisma } from "@flipsight/db";
import {
  buildDealAlertPayload,
  detectRiskFlags,
  FeeScheduleSchema,
  resolveFees,
  resolveShipping,
  scoreDealV2,
  ShippingTableSchema,
  ValuationConfigSchema,
  computeCompStats,
  trimOutliersIQR,
  type SourceKeyName,
  type ValuationConfig,
} from "@flipsight/shared";
import { fetchComps, type CompsResult, type EbayClient, type KeepaClient, type ProductIdentifier } from "@flipsight/clients";
import { getAppSetting, type Job, type WorkerApp, type ValuateJobData } from "@flipsight/worker-core";
import type { DealNotifier } from "./notify.js";

export interface ValuatorDeps {
  app: WorkerApp;
  ebay: EbayClient;
  keepa: KeepaClient;
  identifier: ProductIdentifier;
  notifier: DealNotifier;
}

export function makeValuateProcessor(deps: ValuatorDeps) {
  const { app } = deps;

  return async (job: Job<ValuateJobData>) => {
    const { itemId, reason } = job.data;
    const log = app.log.child({ itemId, reason });
    const cfg = await getAppSetting(app.prisma, "valuation", ValuationConfigSchema);

    const item = await app.prisma.item.findUnique({ where: { id: itemId }, include: { source: true } });
    if (!item) return { outcome: "skipped_missing_item" };
    if (item.category === "estate_lead") return { outcome: "skipped_estate_lead" };
    const buyPrice = decN(item.currentPrice);
    if (buyPrice <= 0) return { outcome: "skipped_no_price" };

    // 1. Identify the product (UPC/ASIN/ISBN → AI title normalization → heuristic).
    const identity = await deps.identifier.identify(
      {
        title: item.title,
        upc: item.upc,
        asin: item.asin,
        isbn: item.isbn,
        category: item.category,
        condition: item.condition,
        currentPrice: buyPrice,
      },
      { useAI: cfg.identifyWithAI, maxAiPerHour: cfg.maxAiIdentificationsPerHour },
    );

    // 2. Comp it (24h cache keyed by canonical name; IQR-trimmed).
    let comps: CompsResult | null = null;
    const raw = (item.raw ?? {}) as Record<string, unknown>;
    comps = demoComps(raw, cfg, log);
    if (!comps) {
      comps = await fetchComps(
        { ebay: deps.ebay, keepa: deps.keepa, redis: app.redis, log },
        {
          canonicalName: identity.canonicalName,
          searchQuery: identity.searchQuery,
          upc: item.upc,
          asin: item.asin,
          daysBack: cfg.compsDaysBack,
          cacheTtlSec: cfg.compsCacheTtlSec,
        },
      );
    }
    if (!comps) {
      log.info({ event: "valuate_no_data", identity: identity.canonicalName }, "no comp data available");
      return { outcome: "insufficient_data", identity: identity.canonicalName };
    }
    if (comps.compSource === "ebay_sold" && comps.soldCount < cfg.minComps) {
      log.info({ event: "valuate_thin_comps", soldCount: comps.soldCount }, "not enough sold comps");
      return { outcome: "insufficient_comps", soldCount: comps.soldCount };
    }

    // 3. Economics: per-category fees + shipping lookup table.
    const feeSchedule = await getAppSetting(app.prisma, "fees", FeeScheduleSchema);
    const shippingTable = await getAppSetting(app.prisma, "shipping", ShippingTableSchema);
    const category = identity.category ?? item.category;
    const fee = resolveFees(comps.estimatedResale, category, feeSchedule);
    const weightOz = typeof raw.weightOz === "number" ? raw.weightOz : null;
    const shipping = resolveShipping({ category, weightOz }, shippingTable);
    const netProfit = round2(comps.estimatedResale - buyPrice - fee.fees - shipping.cost);
    const roiPct = buyPrice > 0 ? round2((netProfit / buyPrice) * 100) : 0;

    // 4. Score with time pressure + risk flags.
    const riskFlags = detectRiskFlags({ title: item.title, condition: item.condition, raw });
    const breakdown = scoreDealV2({
      netProfit,
      roiPct,
      sellThroughRate: comps.sellThroughRate,
      soldCompsCount: comps.soldCount,
      endsAt: item.endsAt,
      riskFlags,
    });

    // 5. Persist the Valuation regardless of deal outcome.
    const valuation = await app.prisma.valuation.create({
      data: {
        itemId: item.id,
        estimatedResale: comps.estimatedResale,
        resaleLow: comps.resaleLow,
        resaleHigh: comps.resaleHigh,
        soldCompsCount: comps.soldCount,
        sellThroughRate: comps.sellThroughRate,
        compSource: comps.compSource,
      },
    });

    const summary = {
      identity: identity.canonicalName,
      method: identity.method,
      netProfit,
      roiPct,
      score: breakdown.score,
      riskFlags,
    };

    if (netProfit < cfg.minNetProfit || breakdown.score < cfg.scoreThreshold) {
      log.info({ event: "valuate_below_threshold", ...summary }, "valued but below deal thresholds");
      return { outcome: "not_a_deal", ...summary };
    }

    // Skip when an open deal already exists for this item at the same price.
    const openDeal = await app.prisma.deal.findFirst({
      where: { itemId: item.id, status: { in: ["new", "alerted", "claimed"] } },
    });
    if (openDeal && Math.abs(decN(openDeal.buyPrice) - buyPrice) < 0.01) {
      return { outcome: "duplicate_open_deal", dealId: openDeal.id };
    }

    const meta = {
      identity: {
        canonicalName: identity.canonicalName,
        method: identity.method,
        aiConfidence: identity.aiConfidence,
        demo: Boolean(raw.demoComps),
      },
      fees: { pct: fee.pct, fixed: fee.fixed, matchedCategory: fee.matchedCategory },
      shipping: { cost: shipping.cost, rule: shipping.rule },
      riskFlags,
      scoreBreakdown: breakdown,
      comps: {
        source: comps.compSource,
        sampleSize: comps.sampleSize,
        trimmedOutliers: comps.trimmedOutliers,
        activeCount: comps.activeCount,
      },
    };

    // 6. Create the Deal and publish.
    const deal = await app.prisma.deal.create({
      data: {
        itemId: item.id,
        valuationId: valuation.id,
        buyPrice,
        estFees: fee.fees,
        estShipping: shipping.cost,
        netProfit,
        roiPct,
        score: breakdown.score,
        meta: meta as unknown as Prisma.InputJsonValue,
      },
    });

    const payload = buildDealAlertPayload({
      deal: {
        id: deal.id,
        status: deal.status,
        buyPrice,
        estFees: fee.fees,
        estShipping: shipping.cost,
        netProfit,
        roiPct,
        score: breakdown.score,
        createdAt: deal.createdAt,
      },
      item: {
        id: item.id,
        title: item.title,
        category: item.category,
        condition: item.condition,
        imageUrls: item.imageUrls,
        sourceUrl: item.sourceUrl,
        currentPrice: buyPrice,
        location: item.location,
        sourceKey: item.source.key as SourceKeyName,
        endsAt: item.endsAt,
        bidsCount: item.bidsCount,
      },
      valuation: {
        id: valuation.id,
        estimatedResale: comps.estimatedResale,
        resaleLow: comps.resaleLow,
        resaleHigh: comps.resaleHigh,
        soldCompsCount: comps.soldCount,
        sellThroughRate: comps.sellThroughRate,
        compSource: comps.compSource,
      },
      meta,
    });
    const wsSubscribers = await app.publishDealPayload(payload);

    // 7. Discord / Pushover delivery + AlertEvents for every matching rule.
    const notify = await deps.notifier.notifyDeal(payload, {
      discordEnabled: cfg.notifications.discordEnabled,
      pushoverEnabled: cfg.notifications.pushoverEnabled,
    });

    log.info(
      {
        event: "deal_created",
        dealId: deal.id,
        ...summary,
        fees: fee.fees,
        shipping: shipping.cost,
        wsSubscribers,
        notify,
      },
      "deal created, published, and alerts delivered",
    );
    return { outcome: "deal_created", dealId: deal.id, ...summary };
  };
}

/**
 * Dev/demo path: items seeded with raw.demoComps (see `npm run seed:item`)
 * are valued from embedded sold prices so the full pipeline can be exercised
 * without eBay credentials. Clearly logged; disable via valuation config.
 */
function demoComps(
  raw: Record<string, unknown>,
  cfg: ValuationConfig,
  log: { warn: (o: object, m?: string) => void },
): CompsResult | null {
  const demo = raw.demoComps as { soldPrices?: number[]; activeCount?: number } | undefined;
  if (!cfg.allowDemoComps || !demo?.soldPrices || demo.soldPrices.length === 0) return null;
  const trimmed = trimOutliersIQR(demo.soldPrices);
  const stats = computeCompStats(trimmed);
  if (!stats) return null;
  const soldCount = demo.soldPrices.length;
  const activeCount = demo.activeCount ?? soldCount;
  log.warn(
    { event: "demo_comps_used", soldCount, median: stats.median },
    "valuing from embedded demo comps (seed item) — not real market data",
  );
  return {
    estimatedResale: stats.median,
    resaleLow: stats.p25,
    resaleHigh: stats.p75,
    soldCount,
    activeCount,
    sellThroughRate: Math.round((soldCount / Math.max(1, soldCount + activeCount)) * 1000) / 1000,
    compSource: "ebay_sold",
    sampleSize: trimmed.length,
    trimmedOutliers: demo.soldPrices.length - trimmed.length,
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

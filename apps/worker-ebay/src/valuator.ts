/**
 * The `valuate` queue consumer. Every source worker enqueues here after
 * writing Items; this processor prices each item against real eBay sold
 * comps, records a Valuation, and — when profit clears the configured
 * thresholds — creates a Deal and publishes it on `deals:new`.
 */
import { decN } from "@flipsight/db";
import {
  EbaySourceConfigSchema,
  buildDealAlertPayload,
  computeDealEconomics,
  scoreDeal,
  type SourceKeyName,
} from "@flipsight/shared";
import type { Job, WorkerApp, ValuateJobData } from "@flipsight/worker-core";
import { EbayAccessError, type EbayClient } from "./ebay-client.js";
import { fetchSoldComps } from "./comps.js";

export function makeValuateProcessor(app: WorkerApp, client: EbayClient) {
  return async (job: Job<ValuateJobData>) => {
    const { itemId, reason } = job.data;
    const log = app.log.child({ itemId, reason });
    const cfg = await app.getSourceConfig(EbaySourceConfigSchema, "ebay");

    const item = await app.prisma.item.findUnique({
      where: { id: itemId },
      include: { source: true },
    });
    if (!item) return { outcome: "skipped_missing_item" };
    if (item.category === "estate_lead") return { outcome: "skipped_estate_lead" };
    const buyPrice = decN(item.currentPrice);
    if (buyPrice <= 0) return { outcome: "skipped_no_price" };

    if (!client.isConfigured()) {
      log.info(
        { event: "valuate_skipped", cause: "no_ebay_credentials" },
        "valuation skipped — set EBAY_CLIENT_ID / EBAY_CLIENT_SECRET to enable sold comps",
      );
      return { outcome: "skipped_no_credentials" };
    }

    let comps;
    try {
      comps = await fetchSoldComps(
        { client, redis: app.redis, log },
        {
          ...(item.upc ? { upc: item.upc } : { title: item.title }),
          daysBack: cfg.valuation.compsDaysBack,
          cacheTtlSec: cfg.valuation.compsCacheTtlSec,
        },
      );
    } catch (err) {
      if (err instanceof EbayAccessError) {
        log.info({ event: "valuate_skipped", cause: "insights_unavailable" }, "sold comps API unavailable");
        return { outcome: "skipped_insights_unavailable" };
      }
      throw err; // transient — let BullMQ retry with backoff
    }

    if (!comps || comps.soldCount < cfg.valuation.minComps) {
      log.info(
        { event: "valuate_no_comps", soldCount: comps?.soldCount ?? 0, minComps: cfg.valuation.minComps },
        "insufficient sold comps",
      );
      return { outcome: "insufficient_comps" };
    }

    const valuation = await app.prisma.valuation.create({
      data: {
        itemId: item.id,
        estimatedResale: comps.median,
        resaleLow: comps.p25,
        resaleHigh: comps.p75,
        soldCompsCount: comps.soldCount,
        sellThroughRate: comps.sellThroughRate,
        compSource: "ebay_sold",
      },
    });

    const econ = computeDealEconomics({
      buyPrice,
      estimatedResale: comps.median,
      estShipping: cfg.valuation.estShippingDefault,
    });
    const score = scoreDeal({
      netProfit: econ.netProfit,
      roiPct: econ.roiPct,
      sellThroughRate: comps.sellThroughRate,
      soldCompsCount: comps.soldCount,
    });

    if (econ.netProfit < cfg.valuation.minNetProfit || econ.roiPct < cfg.valuation.minRoiPct) {
      log.info(
        { event: "valuate_below_threshold", netProfit: econ.netProfit, roiPct: econ.roiPct },
        "valued but not a deal",
      );
      return { outcome: "not_a_deal", netProfit: econ.netProfit };
    }

    // Skip if there's already an open deal for this item at the same price.
    const openDeal = await app.prisma.deal.findFirst({
      where: { itemId: item.id, status: { in: ["new", "alerted", "claimed"] } },
    });
    if (openDeal && Math.abs(decN(openDeal.buyPrice) - buyPrice) < 0.01) {
      return { outcome: "duplicate_open_deal", dealId: openDeal.id };
    }

    const deal = await app.prisma.deal.create({
      data: {
        itemId: item.id,
        valuationId: valuation.id,
        buyPrice: econ.buyPrice,
        estFees: econ.estFees,
        estShipping: econ.estShipping,
        netProfit: econ.netProfit,
        roiPct: econ.roiPct,
        score,
      },
    });

    const payload = buildDealAlertPayload({
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
        currentPrice: buyPrice,
        location: item.location,
        sourceKey: item.source.key as SourceKeyName,
      },
      valuation: {
        id: valuation.id,
        estimatedResale: comps.median,
        resaleLow: comps.p25,
        resaleHigh: comps.p75,
        soldCompsCount: comps.soldCount,
        sellThroughRate: comps.sellThroughRate,
        compSource: "ebay_sold",
      },
    });
    const receivers = await app.publishDealPayload(payload);

    log.info(
      {
        event: "deal_created",
        dealId: deal.id,
        netProfit: econ.netProfit,
        roiPct: econ.roiPct,
        score,
        subscribers: receivers,
      },
      "deal created and published",
    );
    return { outcome: "deal_created", dealId: deal.id };
  };
}

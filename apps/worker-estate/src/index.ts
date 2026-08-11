/**
 * worker-estate — polls EstateSales.net (and configured RSS feeds like HiBid)
 * for sales around the home ZIP, runs new sales through the Anthropic API to
 * extract brands / categories / a worth-attending score, and stores each sale
 * as an Item with category `estate_lead`.
 */
import { EstateSourceConfigSchema } from "@flipsight/shared";
import {
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
import { EstateAnalyzer } from "./ai.js";
import { fetchEstateSalesLeads, fetchRssLeads, fetchSaleDetail, type SaleLead } from "./feeds.js";

const QUEUE = "estate";

const app = await WorkerApp.create({ name: "worker-estate", sourceKey: "estatesales" });
const bootCfg = await app.getSourceConfig(EstateSourceConfigSchema);

const bucket = new TokenBucket({ name: "estate-feeds", ratePerSec: bootCfg.requestsPerSec, burst: 1, log: app.log });
const robots = new RobotsGuard({
  userAgent: DEFAULT_USER_AGENT,
  agentToken: "flipsightbot",
  log: app.log,
  defaultPolicy: "enforce",
});
const http = new HttpClient({
  name: "estate",
  log: app.log,
  bucket,
  robots,
  checkpoints: app.checkpoints(),
});
const analyzer = new EstateAnalyzer(app.log);

if (!analyzer.isConfigured()) {
  app.log.warn(
    { event: "anthropic_credentials_missing" },
    "ANTHROPIC_API_KEY not set — estate leads will be stored without AI analysis",
  );
}

app.process(QUEUE, async () => {
  const cfg = await app.getSourceConfig(EstateSourceConfigSchema);
  const zip = process.env.HOME_ZIP && /^\d{5}$/.test(process.env.HOME_ZIP) ? process.env.HOME_ZIP : cfg.zip;
  const source = await app.getSource();
  const valuateQueue = app.queue(VALUATE_QUEUE);
  const startedAt = Date.now();
  const totals = { leads: 0, newLeads: 0, analyzed: 0, stored: 0, feedErrors: 0 };

  // 1. Collect leads from all feeds.
  const leads: SaleLead[] = [];
  try {
    leads.push(...(await fetchEstateSalesLeads(http, { state: cfg.region.state, city: cfg.region.city, zip })));
  } catch (err) {
    totals.feedErrors += 1;
    app.log.warn({ event: "feed_failed", feed: "estatesales.net", err: (err as Error).message }, "feed fetch failed");
  }
  for (const feedUrl of cfg.rssFeeds) {
    try {
      leads.push(...(await fetchRssLeads(http, feedUrl)));
    } catch (err) {
      totals.feedErrors += 1;
      app.log.warn({ event: "feed_failed", feed: feedUrl, err: (err as Error).message }, "rss feed fetch failed");
    }
  }
  totals.leads = leads.length;

  // 2. Keep only sales we haven't stored yet.
  const existing = await app.prisma.item.findMany({
    where: { sourceId: source.id, externalId: { in: leads.map((l) => l.externalId) } },
    select: { externalId: true },
  });
  const known = new Set(existing.map((e) => e.externalId));
  const fresh = leads.filter((l) => !known.has(l.externalId)).slice(0, cfg.maxSalesPerSweep);
  totals.newLeads = fresh.length;

  // 3. Fetch details politely, analyze with the Anthropic API, store as Items.
  let analysesLeft = cfg.ai.enabled && analyzer.isConfigured() ? cfg.ai.maxAnalysesPerSweep : 0;
  for (const lead of fresh) {
    if (app.isClosing) break; // SIGTERM: stop between leads (AI calls are slow)
    await politeDelay(500, 1500);
    let detail;
    try {
      detail = await fetchSaleDetail(http, lead.url);
    } catch (err) {
      app.log.warn({ event: "sale_detail_failed", url: lead.url, err: (err as Error).message }, "detail fetch failed");
      continue;
    }

    let analysis = null;
    if (analysesLeft > 0) {
      analysesLeft -= 1;
      analysis = await analyzer.analyze({
        title: detail.title,
        description: detail.description,
        imageUrls: detail.imageUrls,
        watchBrands: cfg.ai.watchBrands,
      });
      if (analysis) totals.analyzed += 1;
    }

    const { item } = await upsertItem(app.prisma, {
      sourceId: source.id,
      externalId: lead.externalId,
      title: detail.title.slice(0, 250),
      sourceUrl: lead.url,
      currentPrice: 0,
      category: "estate_lead",
      imageUrls: detail.imageUrls,
      location: `${cfg.region.city.replace(/-/g, " ")}, ${cfg.region.state} ${zip}`,
      raw: {
        feedSource: lead.source,
        descriptionExcerpt: detail.description.slice(0, 2000),
        ai: analysis,
        aiModel: analysis ? analyzer.model : null,
        radiusMiles: cfg.radiusMiles,
      },
    });
    totals.stored += 1;
    await enqueueValuate(valuateQueue, { itemId: item.id, reason: "estate_lead" });

    if (analysis && analysis.worthAttendingScore >= 70) {
      app.log.info(
        {
          event: "estate_lead_hot",
          url: lead.url,
          score: analysis.worthAttendingScore,
          brands: analysis.notableBrands,
          reasoning: analysis.reasoning,
        },
        "high-value estate sale lead",
      );
    }
  }

  app.setHealth({ lastSweepAt: new Date().toISOString(), lastSweep: totals, aiConfigured: analyzer.isConfigured() });
  app.log.info(
    { event: "sweep_completed", sweep: "feeds", ...totals, durationMs: Date.now() - startedAt },
    "estate sweep done",
  );
  return totals;
});

await app.scheduleEvery(QUEUE, "estate:feeds", bootCfg.sweepEverySec * 1000, "sweep:feeds");
app.setHealth({ aiConfigured: analyzer.isConfigured(), aiModel: analyzer.model });
app.log.info(
  { sweepEverySec: bootCfg.sweepEverySec, ai: analyzer.isConfigured(), model: analyzer.model },
  "worker-estate ready",
);

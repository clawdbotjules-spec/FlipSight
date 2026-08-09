/**
 * worker-retail — retailer clearance monitor. Each retailer is a plugin
 * (sources/retail/<name>.ts); sweeps run per plugin, detect items priced
 * below the clearance threshold (default: < 50% of MSRP), check per-store
 * availability for the configured stores near the home ZIP, upsert Items
 * under the retailer's Source row, and enqueue valuate jobs.
 */
import { RetailSourceConfigSchema } from "@flipsight/shared";
import {
  enqueueValuate,
  HttpClient,
  TokenBucket,
  upsertItem,
  VALUATE_QUEUE,
  WorkerApp,
} from "@flipsight/worker-core";
import { RETAIL_PLUGINS, type RetailContext, type RetailPlugin } from "./sources/retail/index.js";

const QUEUE = "retail";

// This worker serves two Source rows (walmart_clearance, target_clearance);
// config is read from each plugin's own row.
const app = await WorkerApp.create({ name: "worker-retail", sourceKey: "target_clearance" });
const bootCfg = await app.getSourceConfig(RetailSourceConfigSchema, "target_clearance");

const bucket = new TokenBucket({ name: "retail", ratePerSec: bootCfg.requestsPerSec, burst: 2, log: app.log });
const disabledLogged = new Set<string>();

async function contextFor(plugin: RetailPlugin): Promise<RetailContext> {
  const config = await app.getSourceConfig(RetailSourceConfigSchema, plugin.sourceKey);
  if (process.env.HOME_ZIP && /^\d{5}$/.test(process.env.HOME_ZIP)) {
    config.homeZip = process.env.HOME_ZIP;
  }
  return {
    http: new HttpClient({
      name: plugin.key,
      log: app.log,
      bucket,
      checkpoints: app.checkpoints(plugin.sourceKey),
    }),
    log: app.log.child({ plugin: plugin.key }),
    config,
    checkpoints: app.checkpoints(plugin.sourceKey),
    env: process.env,
  };
}

async function sweepPlugin(plugin: RetailPlugin) {
  const ctx = await contextFor(plugin);
  const configured = plugin.configured(ctx);
  if (configured !== true) {
    if (!disabledLogged.has(plugin.key)) {
      disabledLogged.add(plugin.key);
      ctx.log.warn({ event: "retail_plugin_disabled", reason: configured }, "retail plugin disabled");
    }
    return { skipped: configured };
  }

  const source = await app.getSource(plugin.sourceKey);
  const valuateQueue = app.queue(VALUATE_QUEUE);
  const startedAt = Date.now();
  const totals = { fetched: 0, clearance: 0, created: 0, updated: 0, valuateEnqueued: 0 };

  const products = (await plugin.fetchClearance(ctx)).slice(0, ctx.config.maxItemsPerSweep);
  totals.fetched = products.length;

  const clearance = products.filter((p) => {
    if (p.price < ctx.config.minPrice) return false;
    if (p.msrp == null || p.msrp <= 0) return false;
    return p.price <= p.msrp * (ctx.config.clearanceThresholdPct / 100);
  });
  totals.clearance = clearance.length;

  // Per-store inventory for the configured stores near the home ZIP.
  let availability: Record<string, { storeId: string; available: boolean; quantity: number | null }[]> = {};
  if (plugin.checkStoreInventory && ctx.config.storeIds.length > 0 && clearance.length > 0) {
    availability = await plugin.checkStoreInventory(
      ctx,
      clearance.slice(0, 25).map((p) => p.externalId),
      ctx.config.storeIds,
    );
  }

  for (const product of clearance) {
    const discountPct = product.msrp ? Math.round((1 - product.price / product.msrp) * 100) : null;
    const { item, created, priceChanged } = await upsertItem(app.prisma, {
      sourceId: source.id,
      externalId: product.externalId,
      title: product.title,
      sourceUrl: product.url,
      currentPrice: product.price,
      category: product.category,
      imageUrls: product.imageUrls,
      upc: product.upc,
      raw: {
        retailer: plugin.key,
        msrp: product.msrp,
        discountPct,
        brand: product.brand,
        storeAvailability: availability[product.externalId] ?? [],
        homeZip: ctx.config.homeZip,
        product: product.raw,
      },
    });
    if (created) totals.created += 1;
    else totals.updated += 1;
    if (created || priceChanged) {
      await enqueueValuate(valuateQueue, { itemId: item.id, reason: "retail_clearance" });
      totals.valuateEnqueued += 1;
      app.log.info(
        {
          event: "clearance_detected",
          retailer: plugin.key,
          title: product.title.slice(0, 60),
          price: product.price,
          msrp: product.msrp,
          discountPct,
        },
        "clearance item below threshold",
      );
    }
  }

  app.setHealth({ [`lastSweep_${plugin.key}`]: new Date().toISOString() });
  app.log.info(
    { event: "sweep_completed", sweep: plugin.key, ...totals, durationMs: Date.now() - startedAt },
    "retail sweep done",
  );
  return totals;
}

app.process(QUEUE, async (job) => {
  const plugin = RETAIL_PLUGINS.find((p) => `sweep:${p.key}` === job.name);
  if (!plugin) throw new Error(`unknown job ${job.name}`);
  return sweepPlugin(plugin);
});

for (const plugin of RETAIL_PLUGINS) {
  await app.scheduleEvery(QUEUE, `retail:${plugin.key}`, bootCfg.sweepEverySec * 1000, `sweep:${plugin.key}`);
}
app.log.info(
  { plugins: RETAIL_PLUGINS.map((p) => p.key), sweepEverySec: bootCfg.sweepEverySec },
  "worker-retail ready",
);

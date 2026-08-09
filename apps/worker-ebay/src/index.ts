/**
 * worker-ebay — isolated BullMQ worker process for the eBay source.
 * Also hosts the global `valuate` queue consumer (it owns the sold-comps
 * fetcher every valuation depends on).
 */
import { EbaySourceConfigSchema } from "@flipsight/shared";
import { TokenBucket, VALUATE_QUEUE, WorkerApp } from "@flipsight/worker-core";
import { EbayClient } from "./ebay-client.js";
import { makeEndingSoonSweep, makeNewlyListedSweep, makeSavedSearchSweep } from "./sweeps.js";
import { makeValuateProcessor } from "./valuator.js";

const QUEUE = "ebay";

const app = await WorkerApp.create({ name: "worker-ebay", sourceKey: "ebay" });
const cfg = await app.getSourceConfig(EbaySourceConfigSchema);

const bucket = new TokenBucket({
  name: "ebay-api",
  ratePerSec: cfg.requestsPerSec,
  burst: cfg.burst,
  log: app.log,
});
const client = new EbayClient({
  clientId: process.env.EBAY_CLIENT_ID,
  clientSecret: process.env.EBAY_CLIENT_SECRET,
  marketplaceId: cfg.marketplaceId,
  bucket,
  log: app.log,
});

const savedSearchSweep = makeSavedSearchSweep(app, client);
const endingSoonSweep = makeEndingSoonSweep(app, client);
const newlyListedSweep = makeNewlyListedSweep(app, client);

app.process(QUEUE, async (job) => {
  switch (job.name) {
    case "sweep:saved-searches":
      return savedSearchSweep();
    case "sweep:ending-soon":
      return endingSoonSweep();
    case "sweep:newly-listed":
      return newlyListedSweep();
    default:
      throw new Error(`unknown job ${job.name}`);
  }
});

app.process(VALUATE_QUEUE, makeValuateProcessor(app, client), { concurrency: 2 });

await app.scheduleEvery(QUEUE, "ebay:saved-searches", cfg.sweeps.savedSearchEverySec * 1000, "sweep:saved-searches");
await app.scheduleEvery(QUEUE, "ebay:ending-soon", cfg.sweeps.endingSoonEverySec * 1000, "sweep:ending-soon");
await app.scheduleEvery(QUEUE, "ebay:newly-listed", cfg.sweeps.newlyListedEverySec * 1000, "sweep:newly-listed");

app.setHealth({ ebayConfigured: client.isConfigured() });
app.log.info(
  { configured: client.isConfigured(), sweeps: cfg.sweeps },
  "worker-ebay ready (sweeps scheduled, valuate consumer online)",
);

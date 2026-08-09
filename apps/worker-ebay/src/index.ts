/**
 * worker-ebay — isolated BullMQ worker process for the eBay source: saved
 * keyword-set sweeps (with programmatic brand misspellings), auctions ending
 * soon with zero/low bids, and newly-listed BIN items. Valuation happens in
 * the dedicated worker-valuate service, which consumes the jobs this worker
 * enqueues.
 */
import { EbayClient } from "@flipsight/clients";
import { EbaySourceConfigSchema } from "@flipsight/shared";
import { TokenBucket, WorkerApp } from "@flipsight/worker-core";
import { makeEndingSoonSweep, makeNewlyListedSweep, makeSavedSearchSweep } from "./sweeps.js";

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

await app.scheduleEvery(QUEUE, "ebay:saved-searches", cfg.sweeps.savedSearchEverySec * 1000, "sweep:saved-searches");
await app.scheduleEvery(QUEUE, "ebay:ending-soon", cfg.sweeps.endingSoonEverySec * 1000, "sweep:ending-soon");
await app.scheduleEvery(QUEUE, "ebay:newly-listed", cfg.sweeps.newlyListedEverySec * 1000, "sweep:newly-listed");

app.setHealth({ ebayConfigured: client.isConfigured() });
app.log.info({ configured: client.isConfigured(), sweeps: cfg.sweeps }, "worker-ebay ready (sweeps scheduled)");

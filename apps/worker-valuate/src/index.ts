/**
 * worker-valuate — the valuation + scoring engine. Consumes the global
 * `valuate` queue that every source worker feeds.
 */
import { EbayClient, KeepaClient, ProductIdentifier } from "@flipsight/clients";
import { TokenBucket } from "@flipsight/shared";
import { VALUATE_QUEUE, WorkerApp } from "@flipsight/worker-core";
import { DealNotifier } from "./notify.js";
import { makeValuateProcessor } from "./valuation.js";

const app = await WorkerApp.create({ name: "worker-valuate" });

const ebay = new EbayClient({
  clientId: process.env.EBAY_CLIENT_ID,
  clientSecret: process.env.EBAY_CLIENT_SECRET,
  marketplaceId: process.env.EBAY_MARKETPLACE_ID ?? "EBAY_US",
  bucket: new TokenBucket({ name: "ebay-comps", ratePerSec: 1.5, burst: 3, log: app.log }),
  log: app.log,
});
const keepa = new KeepaClient({
  apiKey: process.env.KEEPA_API_KEY,
  domain: 1,
  bucket: new TokenBucket({ name: "keepa-comps", ratePerSec: 0.25, burst: 3, log: app.log }),
  log: app.log,
});
const identifier = new ProductIdentifier({ redis: app.redis, log: app.log });
const notifier = new DealNotifier(app);

app.process(VALUATE_QUEUE, makeValuateProcessor({ app, ebay, keepa, identifier, notifier }), {
  concurrency: 3,
});

app.setHealth({
  ebayConfigured: ebay.isConfigured(),
  keepaConfigured: keepa.isConfigured(),
  aiConfigured: identifier.isConfigured(),
  discordConfigured: notifier.discordConfigured,
  pushoverConfigured: notifier.pushoverConfigured,
});
app.log.info(
  {
    ebay: ebay.isConfigured(),
    keepa: keepa.isConfigured(),
    ai: identifier.isConfigured(),
    discord: notifier.discordConfigured,
    pushover: notifier.pushoverConfigured,
  },
  "worker-valuate ready (valuate queue consumer online)",
);

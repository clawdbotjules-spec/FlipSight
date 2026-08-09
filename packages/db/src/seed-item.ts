/**
 * Phase-3 acceptance seed: inserts a fake underpriced Item (the way a source
 * worker would) and enqueues a `valuate` job. The valuation engine should
 * turn it into a Deal within seconds — with a fee/shipping breakdown — and
 * deliver Discord/Pushover/WebSocket alerts.
 *
 * The item carries raw.demoComps (embedded sold prices) so the pipeline runs
 * end-to-end without eBay credentials; with credentials, real comps win for
 * normal items. One deliberate outlier in the prices proves IQR trimming.
 *
 * Run:  npm run seed:item        (host, after `npm run build`)
 *       docker compose exec worker-valuate node packages/db/dist/seed-item.js
 */
import { loadEnvFile } from "@flipsight/shared";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { createPrismaClient } from "./index.js";

loadEnvFile();

async function main() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) throw new Error("REDIS_URL is not set — copy .env.example to .env or export it.");

  const prisma = createPrismaClient();
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const valuateQueue = new Queue("valuate", { connection });

  try {
    const source = await prisma.source.findUnique({ where: { key: "ebay" } });
    if (!source) throw new Error("Sources not seeded yet — run `npm run db:seed` first.");

    const externalId = `demo-item-${Date.now()}`;
    const endsAt = new Date(Date.now() + 25 * 60_000); // ending soon → time-pressure boost
    const item = await prisma.item.create({
      data: {
        sourceId: source.id,
        externalId,
        title: "Bose QuietComfort 45 Wireless Noise Cancelling Headphones - Black",
        category: "Consumer Electronics",
        condition: "Used - Very Good",
        imageUrls: ["https://picsum.photos/seed/flipsight-qc45/400/300"],
        sourceUrl: `https://www.ebay.com/itm/${externalId}`,
        currentPrice: 45.0, // underpriced vs ~$150 sold median
        endsAt,
        bidsCount: 0,
        raw: {
          demo: true,
          injectedBy: "seed-item",
          noReturns: true, // exercises a risk-flag penalty
          demoComps: {
            // 12 realistic sold prices + one $499 outlier the IQR trim drops.
            soldPrices: [139.99, 145.0, 149.95, 152.5, 155.0, 148.0, 160.0, 142.5, 151.0, 158.0, 144.99, 156.5, 499.0],
            activeCount: 9,
          },
        },
      },
    });

    await valuateQueue.add(
      "valuate",
      { itemId: item.id, reason: "seed_item_acceptance" },
      { jobId: `v-${item.id}`, attempts: 4, backoff: { type: "exponential", delay: 10_000 } },
    );

    console.log(`Underpriced item seeded and valuate job enqueued.`);
    console.log(`  item: ${item.id} — "${item.title}"`);
    console.log(`  buy $45.00 | demo sold comps median ≈ $150 (incl. one $499 outlier to be IQR-trimmed)`);
    console.log(`  auction ends in 25 min (time-pressure boost), noReturns risk flag set`);
    console.log(`Watch worker-valuate logs / your WebSocket / Discord for the deal.`);
  } finally {
    await valuateQueue.close();
    connection.disconnect();
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("seed-item failed:", err);
  process.exitCode = 1;
});

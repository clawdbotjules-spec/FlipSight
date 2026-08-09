/**
 * Baseline seed — idempotent. Creates:
 *  - the six marketplace sources with sensible worker config defaults
 *  - a demo org + user (demo@flipsight.dev / $SEED_DEMO_PASSWORD, default
 *    "flipsight-demo") for local development
 *  - a default alert rule for the demo user
 *
 * Run:  npm run db:seed          (host, after `npm run build`)
 *       docker compose exec api node packages/db/dist/seed.js
 */
import { hashPassword, loadEnvFile, SOURCE_KEYS } from "@flipsight/shared";
import { createPrismaClient, type Prisma, type SourceKey } from "./index.js";

loadEnvFile();

const SOURCE_DEFS: Record<
  (typeof SOURCE_KEYS)[number],
  { name: string; config: Prisma.InputJsonObject }
> = {
  ebay: {
    name: "eBay",
    config: {
      pollIntervalSec: 120,
      maxRequestsPerMin: 30,
      api: "browse",
      notes: "Official eBay Browse API; sold comps via Marketplace Insights.",
    },
  },
  keepa_amazon: {
    name: "Amazon (Keepa)",
    config: {
      pollIntervalSec: 300,
      maxRequestsPerMin: 20,
      notes: "Keepa API for Amazon price history, rank, and drops.",
    },
  },
  shopgoodwill: {
    name: "ShopGoodwill",
    config: {
      pollIntervalSec: 300,
      maxRequestsPerMin: 10,
      politeScraping: true,
      notes: "Public endpoints only; randomized delays, conditional requests, respect robots.txt.",
    },
  },
  walmart_clearance: {
    name: "Walmart Clearance",
    config: {
      pollIntervalSec: 600,
      maxRequestsPerMin: 10,
      notes: "Official affiliate/catalog API where available.",
    },
  },
  target_clearance: {
    name: "Target Clearance",
    config: {
      pollIntervalSec: 600,
      maxRequestsPerMin: 10,
      notes: "Public endpoints with polite rate limits.",
    },
  },
  estatesales: {
    name: "EstateSales.net",
    config: {
      pollIntervalSec: 3600,
      maxRequestsPerMin: 5,
      politeScraping: true,
      notes: "Public listings; AI parsing of sale descriptions happens in the estate worker.",
    },
  },
};

export const DEMO_EMAIL = "demo@flipsight.dev";

async function main() {
  const prisma = createPrismaClient();
  try {
    for (const key of SOURCE_KEYS) {
      const def = SOURCE_DEFS[key];
      await prisma.source.upsert({
        where: { key: key as SourceKey },
        update: { name: def.name },
        create: { key: key as SourceKey, name: def.name, config: def.config },
      });
    }
    console.log(`Seeded ${SOURCE_KEYS.length} sources.`);

    const demoPassword = process.env.SEED_DEMO_PASSWORD ?? "flipsight-demo";
    let user = await prisma.user.findUnique({ where: { email: DEMO_EMAIL } });
    if (!user) {
      const passwordHash = await hashPassword(demoPassword);
      user = await prisma.user.create({
        data: {
          email: DEMO_EMAIL,
          passwordHash,
          role: "owner",
          org: { create: { name: "FlipSight Demo" } },
        },
      });
      console.log(`Created demo user ${DEMO_EMAIL} (password: ${demoPassword}).`);
    } else {
      console.log(`Demo user ${DEMO_EMAIL} already exists.`);
    }

    const ruleCount = await prisma.alertRule.count({ where: { userId: user.id } });
    if (ruleCount === 0) {
      await prisma.alertRule.create({
        data: {
          userId: user.id,
          name: "Default: $20+ profit",
          minProfit: 20,
          channels: ["websocket"],
        },
      });
      console.log("Created default alert rule ($20+ net profit, websocket).");
    }

    console.log("Baseline seed complete.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exitCode = 1;
});

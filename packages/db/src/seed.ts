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

/**
 * Source configs use the shared zod schemas (see
 * `@flipsight/shared/source-config`) — workers parse these on every sweep, so
 * edits here (or via the UI later) take effect without restarts. Values below
 * only override schema defaults where useful.
 */
const SOURCE_DEFS: Record<
  (typeof SOURCE_KEYS)[number],
  { name: string; config: Prisma.InputJsonObject }
> = {
  ebay: {
    name: "eBay",
    config: {
      // Ending-soon + newly-listed sweeps watch these Browse category ids:
      // 11700 Home & Garden, 293 Consumer Electronics, 631 Tools, 619 Musical Instruments
      endingSoon: { withinMinutes: 30, maxBids: 0, categoryIds: ["293", "619", "631"], minPrice: 10 },
      newlyListed: { categoryIds: ["293", "619"] },
    },
  },
  keepa_amazon: {
    name: "Amazon (Keepa)",
    config: {
      priceDropPctBelowAvg90: 30,
      pricingErrorPctOfMedian90: 40,
    },
  },
  shopgoodwill: {
    name: "ShopGoodwill",
    config: {
      requestsPerSec: 0.4,
      sweepEverySec: 300,
      maxPagesPerCategory: 2,
    },
  },
  walmart_clearance: {
    name: "Walmart Clearance",
    config: {
      clearanceThresholdPct: 50,
      categories: [
        { id: "3944", name: "Electronics" },
        { id: "1072864", name: "Home Improvement" },
      ],
    },
  },
  target_clearance: {
    name: "Target Clearance",
    config: {
      clearanceThresholdPct: 50,
      storeIds: ["3991"],
      categories: [
        { id: "5xtg6", name: "Electronics" },
        { id: "5xt1a", name: "TVs" },
      ],
    },
  },
  estatesales: {
    name: "EstateSales.net",
    config: {
      region: { state: "FL", city: "Daytona-Beach" },
      radiusMiles: 50,
    },
  },
};

/** Default DB-driven saved searches created once per source (edit via API/UI). */
const DEFAULT_SAVED_SEARCHES: Array<{
  sourceKey: (typeof SOURCE_KEYS)[number];
  name: string;
  params: Prisma.InputJsonObject;
}> = [
  {
    sourceKey: "ebay",
    name: "Power tools (brand misspellings)",
    params: {
      kind: "keywords",
      keywords: ["milwaukee m18 fuel kit", "dewalt 20v max kit"],
      brands: ["milwaukee", "dewalt", "makita"],
      categoryIds: ["631"],
      minPrice: 20,
      maxPrice: 600,
      buyingOption: "ANY",
    },
  },
  {
    sourceKey: "ebay",
    name: "Vintage audio (brand misspellings)",
    params: {
      kind: "keywords",
      keywords: ["vintage receiver", "turntable"],
      brands: ["marantz", "pioneer", "sansui", "mcintosh"],
      categoryIds: [],
      minPrice: 25,
      buyingOption: "ANY",
    },
  },
  {
    sourceKey: "keepa_amazon",
    name: "Starter ASIN watchlist",
    params: {
      kind: "asin_watchlist",
      // Sample high-liquidity products; replace with your own via the API.
      asins: ["B08N5WRWNW", "B0BSHF7WHW", "B07FZ8S74R"],
    },
  },
  { sourceKey: "shopgoodwill", name: "Computers & Electronics", params: { kind: "category", catId: 7, label: "Electronics" } },
  { sourceKey: "shopgoodwill", name: "Tools", params: { kind: "category", catId: 114, label: "Tools" } },
  { sourceKey: "shopgoodwill", name: "Cameras & Camcorders", params: { kind: "category", catId: 170, label: "Cameras" } },
  { sourceKey: "shopgoodwill", name: "Musical Instruments", params: { kind: "category", catId: 13, label: "Instruments" } },
];

export const DEMO_EMAIL = "demo@flipsight.dev";

async function main() {
  const prisma = createPrismaClient();
  try {
    // Note: re-running the seed re-applies the default source configs below.
    // Config edits made via the API/UI should not be combined with re-seeding.
    for (const key of SOURCE_KEYS) {
      const def = SOURCE_DEFS[key];
      await prisma.source.upsert({
        where: { key: key as SourceKey },
        update: { name: def.name, config: def.config },
        create: { key: key as SourceKey, name: def.name, config: def.config },
      });
    }
    console.log(`Seeded ${SOURCE_KEYS.length} sources (configs reset to defaults).`);

    for (const search of DEFAULT_SAVED_SEARCHES) {
      const source = await prisma.source.findUniqueOrThrow({ where: { key: search.sourceKey as SourceKey } });
      const existing = await prisma.savedSearch.findFirst({
        where: { sourceId: source.id, name: search.name },
      });
      if (!existing) {
        await prisma.savedSearch.create({
          data: { sourceId: source.id, name: search.name, params: search.params },
        });
      }
    }
    console.log(`Ensured ${DEFAULT_SAVED_SEARCHES.length} default saved searches.`);

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

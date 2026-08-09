/**
 * Injects a realistic demo deal and publishes it on the `deals:new` Redis
 * channel — exactly what a source worker will do in later phases. Use it to
 * watch the end-to-end alert path: run `npm run listen` (or the web UI) in one
 * terminal, then this script in another; the deal should appear in <1s.
 *
 * Run:  npm run seed:deal        (host, after `npm run build`)
 *       docker compose exec api node packages/db/dist/seed-deal.js
 */
import {
  computeDealEconomics,
  DEALS_NEW_CHANNEL,
  loadEnvFile,
  scoreDeal,
  type DealAlertPayload,
} from "@flipsight/shared";
import { Redis } from "ioredis";
import { createPrismaClient, decN, type CompSource } from "./index.js";

loadEnvFile();

interface DemoItem {
  title: string;
  category: string;
  condition: string;
  buyPrice: number;
  estimatedResale: number;
  resaleLow: number;
  resaleHigh: number;
  soldCompsCount: number;
  sellThroughRate: number;
  estShipping?: number;
  location?: string;
  imageUrl: string;
  compSource: CompSource;
}

const DEMO_ITEMS: DemoItem[] = [
  {
    title: "Milwaukee M18 FUEL 1/2\" Hammer Drill/Driver Kit 2904-22 w/ Batteries",
    category: "Tools",
    condition: "Used - Good",
    buyPrice: 45,
    estimatedResale: 120,
    resaleLow: 95,
    resaleHigh: 140,
    soldCompsCount: 27,
    sellThroughRate: 0.82,
    imageUrl: "https://picsum.photos/seed/flipsight-drill/400/300",
    compSource: "ebay_sold",
  },
  {
    title: "LEGO Star Wars 75192 Millennium Falcon UCS — Sealed Box",
    category: "Toys",
    condition: "New",
    buyPrice: 520,
    estimatedResale: 780,
    resaleLow: 700,
    resaleHigh: 850,
    soldCompsCount: 41,
    sellThroughRate: 0.74,
    estShipping: 34.5,
    imageUrl: "https://picsum.photos/seed/flipsight-lego/400/300",
    compSource: "ebay_sold",
  },
  {
    title: "Vitamix 5200 Professional Blender — Tested, Works Great",
    category: "Kitchen",
    condition: "Used - Very Good",
    buyPrice: 39.99,
    estimatedResale: 150,
    resaleLow: 120,
    resaleHigh: 190,
    soldCompsCount: 64,
    sellThroughRate: 0.88,
    estShipping: 18.25,
    imageUrl: "https://picsum.photos/seed/flipsight-vitamix/400/300",
    compSource: "ebay_sold",
  },
  {
    title: "Pioneer SX-780 Vintage Stereo Receiver — Local Pickup",
    category: "Electronics",
    condition: "Used - Fair",
    buyPrice: 60,
    estimatedResale: 260,
    resaleLow: 200,
    resaleHigh: 330,
    soldCompsCount: 18,
    sellThroughRate: 0.65,
    estShipping: 0,
    location: "Daytona Beach, FL",
    imageUrl: "https://picsum.photos/seed/flipsight-pioneer/400/300",
    compSource: "ebay_sold",
  },
];

async function main() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error("REDIS_URL is not set — copy .env.example to .env or export it.");
  }

  const prisma = createPrismaClient();
  const redis = new Redis(redisUrl);
  try {
    const source = await prisma.source.findUnique({ where: { key: "ebay" } });
    if (!source) {
      throw new Error("Sources not seeded yet — run `npm run db:seed` first.");
    }

    // Rotate through the demo catalog so repeat runs produce varied deals.
    const pick = DEMO_ITEMS[Date.now() % DEMO_ITEMS.length]!;
    const externalId = `demo-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

    const item = await prisma.item.create({
      data: {
        sourceId: source.id,
        externalId,
        title: pick.title,
        category: pick.category,
        condition: pick.condition,
        imageUrls: [pick.imageUrl],
        sourceUrl: `https://www.ebay.com/itm/${externalId}`,
        currentPrice: pick.buyPrice,
        location: pick.location ?? null,
        raw: { demo: true, injectedBy: "seed-deal" },
      },
    });

    const valuation = await prisma.valuation.create({
      data: {
        itemId: item.id,
        estimatedResale: pick.estimatedResale,
        resaleLow: pick.resaleLow,
        resaleHigh: pick.resaleHigh,
        soldCompsCount: pick.soldCompsCount,
        sellThroughRate: pick.sellThroughRate,
        compSource: pick.compSource,
      },
    });

    const econ = computeDealEconomics({
      buyPrice: pick.buyPrice,
      estimatedResale: pick.estimatedResale,
      estShipping: pick.estShipping,
    });
    const score = scoreDeal({
      netProfit: econ.netProfit,
      roiPct: econ.roiPct,
      sellThroughRate: pick.sellThroughRate,
      soldCompsCount: pick.soldCompsCount,
    });

    const deal = await prisma.deal.create({
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

    const payload: DealAlertPayload = {
      publishedAt: Date.now(),
      deal: {
        id: deal.id,
        status: deal.status,
        buyPrice: decN(deal.buyPrice),
        estFees: decN(deal.estFees),
        estShipping: decN(deal.estShipping),
        netProfit: decN(deal.netProfit),
        roiPct: deal.roiPct,
        score: deal.score,
        createdAt: deal.createdAt.toISOString(),
        item: {
          id: item.id,
          title: item.title,
          category: item.category,
          condition: item.condition,
          imageUrls: item.imageUrls,
          sourceUrl: item.sourceUrl,
          currentPrice: decN(item.currentPrice),
          location: item.location,
          sourceKey: source.key,
        },
        valuation: {
          id: valuation.id,
          estimatedResale: decN(valuation.estimatedResale),
          resaleLow: decN(valuation.resaleLow),
          resaleHigh: decN(valuation.resaleHigh),
          soldCompsCount: valuation.soldCompsCount,
          sellThroughRate: valuation.sellThroughRate,
          compSource: valuation.compSource,
        },
      },
    };

    const receivers = await redis.publish(DEALS_NEW_CHANNEL, JSON.stringify(payload));
    console.log(
      `Deal ${deal.id} created and published to "${DEALS_NEW_CHANNEL}" (${receivers} subscriber${receivers === 1 ? "" : "s"}).`,
    );
    console.log(
      `  ${item.title}\n  buy $${econ.buyPrice} → est resale $${pick.estimatedResale}` +
        ` | net profit $${econ.netProfit} (${econ.roiPct}% ROI) | score ${score}`,
    );
  } finally {
    await prisma.$disconnect();
    redis.disconnect();
  }
}

main().catch((err) => {
  console.error("seed-deal failed:", err);
  process.exitCode = 1;
});

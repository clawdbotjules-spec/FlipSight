import { round2 } from "@flipsight/shared";
import { dec, decN, type Prisma } from "@flipsight/db";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { errors } from "../lib/errors.js";
import { decodeCursor, encodeCursor } from "../lib/pagination.js";
import { toLedgerDTO } from "../lib/serializers.js";

const LedgerCreate = z.object({
  dealId: z.string().min(1).max(64),
  purchasePrice: z.number().min(0).max(1_000_000),
  purchasedAt: z.coerce.date().optional(),
});

const LedgerPatch = z.object({
  purchasePrice: z.number().min(0).max(1_000_000).optional(),
  salePrice: z.number().min(0).max(1_000_000).nullish(),
  fees: z.number().min(0).max(1_000_000).nullish(),
  shipping: z.number().min(0).max(1_000_000).nullish(),
  soldAt: z.coerce.date().nullish(),
});

const LedgerQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(200).optional(),
  /** true = only sold flips, false = only unsold. */
  sold: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
});

const IdParams = z.object({ id: z.string().min(1).max(64) });

const LEDGER_INCLUDE = { deal: { include: { item: true } } } as const;

export default async function ledgerRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.addHook("onRequest", app.authenticate);

  r.get("/", { schema: { querystring: LedgerQuery } }, async (req) => {
    const query = req.query;
    const where: Prisma.FlipLedgerWhereInput = { userId: req.user.sub };
    if (query.sold === true) where.soldAt = { not: null };
    if (query.sold === false) where.soldAt = null;

    if (query.cursor) {
      const cursor = decodeCursor(query.cursor);
      if (!cursor) throw errors.badRequest("Invalid cursor");
      const cursorDate = new Date(cursor.ts);
      where.AND = [
        {
          OR: [
            { createdAt: { lt: cursorDate } },
            { createdAt: cursorDate, id: { lt: cursor.id } },
          ],
        },
      ];
    }

    const rows = await app.prisma.flipLedger.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: query.limit + 1,
      include: LEDGER_INCLUDE,
    });
    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    const last = page[page.length - 1];
    return {
      entries: page.map(toLedgerDTO),
      nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
    };
  });

  r.post("/", { schema: { body: LedgerCreate } }, async (req, reply) => {
    const userId = req.user.sub;
    const entry = await app.prisma.$transaction(async (tx) => {
      const deal = await tx.deal.findUnique({ where: { id: req.body.dealId } });
      if (!deal) throw errors.notFound("Deal not found");
      if (deal.userId && deal.userId !== userId) {
        throw errors.forbidden("Deal is claimed by another user");
      }
      const existing = await tx.flipLedger.findUnique({ where: { dealId: deal.id } });
      if (existing) throw errors.conflict("Deal already has a ledger entry");

      await tx.deal.update({
        where: { id: deal.id },
        data: { status: "purchased", userId },
      });
      return tx.flipLedger.create({
        data: {
          dealId: deal.id,
          userId,
          purchasePrice: req.body.purchasePrice,
          purchasedAt: req.body.purchasedAt ?? new Date(),
        },
        include: LEDGER_INCLUDE,
      });
    });
    return reply.status(201).send({ entry: toLedgerDTO(entry) });
  });

  r.patch("/:id", { schema: { params: IdParams, body: LedgerPatch } }, async (req) => {
    const existing = await app.prisma.flipLedger.findFirst({
      where: { id: req.params.id, userId: req.user.sub },
    });
    if (!existing) throw errors.notFound("Ledger entry not found");

    const b = req.body;
    const purchasePrice = b.purchasePrice ?? decN(existing.purchasePrice);
    const salePrice = b.salePrice !== undefined ? b.salePrice : dec(existing.salePrice);
    const fees = b.fees !== undefined ? b.fees : dec(existing.fees);
    const shipping = b.shipping !== undefined ? b.shipping : dec(existing.shipping);
    const soldAt = b.soldAt !== undefined ? b.soldAt : existing.soldAt;

    const realizedProfit =
      salePrice != null ? round2(salePrice - purchasePrice - (fees ?? 0) - (shipping ?? 0)) : null;

    const entry = await app.prisma.flipLedger.update({
      where: { id: existing.id },
      data: {
        purchasePrice,
        salePrice,
        fees,
        shipping,
        soldAt: soldAt ?? (salePrice != null ? new Date() : null),
        realizedProfit,
      },
      include: LEDGER_INCLUDE,
    });

    if (salePrice != null) {
      await app.prisma.deal.updateMany({
        where: { id: existing.dealId, status: "purchased" },
        data: { status: "sold" },
      });
    }
    return { entry: toLedgerDTO(entry) };
  });

  /**
   * P&L dashboard payload: realized profit by period, a cumulative daily
   * series, ROI grouped by source and category, the unsold inventory, and
   * average days-to-sell — one round trip for the whole screen.
   */
  r.get("/analytics", async (req) => {
    const now = Date.now();
    const entries = await app.prisma.flipLedger.findMany({
      where: { userId: req.user.sub },
      orderBy: { purchasedAt: "asc" },
      take: 2000,
      include: { deal: { include: { item: { include: { source: true } }, valuation: true } } },
    });

    const sold = entries.filter((e) => e.soldAt != null && e.realizedProfit != null);
    const dayMs = 24 * 3600_000;
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const profitSince = (since: number) =>
      round2(
        sold
          .filter((e) => e.soldAt!.getTime() >= since)
          .reduce((sum, e) => sum + decN(e.realizedProfit!), 0),
      );

    // Cumulative realized profit, one point per day with activity (90d window).
    const byDay = new Map<string, number>();
    for (const e of sold) {
      if (e.soldAt!.getTime() < now - 90 * dayMs) continue;
      const day = e.soldAt!.toISOString().slice(0, 10);
      byDay.set(day, (byDay.get(day) ?? 0) + decN(e.realizedProfit!));
    }
    let running = 0;
    const cumulative = [...byDay.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([day, profit]) => {
        running = round2(running + profit);
        return { day, profit: round2(profit), cumulative: running };
      });

    const groupRoi = (label: (e: (typeof sold)[number]) => string) => {
      const groups = new Map<string, { profit: number; cost: number; count: number }>();
      for (const e of sold) {
        const key = label(e);
        const g = groups.get(key) ?? { profit: 0, cost: 0, count: 0 };
        g.profit += decN(e.realizedProfit!);
        g.cost += decN(e.purchasePrice);
        g.count += 1;
        groups.set(key, g);
      }
      return [...groups.entries()]
        .map(([name, g]) => ({
          name,
          profit: round2(g.profit),
          roiPct: g.cost > 0 ? round2((g.profit / g.cost) * 100) : 0,
          flips: g.count,
        }))
        .sort((a, b) => b.profit - a.profit);
    };

    const daysToSell = sold.map((e) => (e.soldAt!.getTime() - e.purchasedAt.getTime()) / dayMs);
    const inventory = entries
      .filter((e) => e.soldAt == null)
      .map((e) => ({
        id: e.id,
        dealId: e.dealId,
        title: e.deal.item.title,
        sourceKey: e.deal.item.source.key,
        category: e.deal.item.category,
        purchasePrice: decN(e.purchasePrice),
        purchasedAt: e.purchasedAt.toISOString(),
        daysHeld: Math.floor((now - e.purchasedAt.getTime()) / dayMs),
        estimatedResale: decN(e.deal.valuation.estimatedResale),
        imageUrl: e.deal.item.imageUrls[0] ?? null,
      }))
      .sort((a, b) => b.daysHeld - a.daysHeld);

    return {
      analytics: {
        realized: {
          today: profitSince(startOfToday.getTime()),
          week: profitSince(now - 7 * dayMs),
          month: profitSince(now - 30 * dayMs),
          allTime: round2(sold.reduce((sum, e) => sum + decN(e.realizedProfit!), 0)),
        },
        cumulative,
        roiBySource: groupRoi((e) => e.deal.item.source.key),
        roiByCategory: groupRoi((e) => e.deal.item.category ?? "Uncategorized"),
        inventory,
        avgDaysToSell:
          daysToSell.length > 0
            ? round2(daysToSell.reduce((a, b) => a + b, 0) / daysToSell.length)
            : null,
        soldCount: sold.length,
        activeCount: inventory.length,
        activeCostBasis: round2(inventory.reduce((sum, i) => sum + i.purchasePrice, 0)),
      },
    };
  });

  r.get("/summary", async (req) => {
    const userId = req.user.sub;
    const [all, sold] = await Promise.all([
      app.prisma.flipLedger.aggregate({
        where: { userId },
        _sum: { purchasePrice: true },
        _count: { _all: true },
      }),
      app.prisma.flipLedger.aggregate({
        where: { userId, salePrice: { not: null } },
        _sum: {
          salePrice: true,
          fees: true,
          shipping: true,
          realizedProfit: true,
          purchasePrice: true,
        },
        _count: { _all: true },
      }),
    ]);

    const totalSpent = dec(all._sum.purchasePrice) ?? 0;
    const totalRevenue = dec(sold._sum.salePrice) ?? 0;
    const totalFees = dec(sold._sum.fees) ?? 0;
    const totalShipping = dec(sold._sum.shipping) ?? 0;
    const realizedProfit = dec(sold._sum.realizedProfit) ?? 0;
    const soldCostBasis = dec(sold._sum.purchasePrice) ?? 0;

    return {
      summary: {
        itemsPurchased: all._count._all,
        itemsSold: sold._count._all,
        totalSpent: round2(totalSpent),
        totalRevenue: round2(totalRevenue),
        totalFees: round2(totalFees),
        totalShipping: round2(totalShipping),
        realizedProfit: round2(realizedProfit),
        avgRoiPct: soldCostBasis > 0 ? round2((realizedProfit / soldCostBasis) * 100) : null,
      },
    };
  });
}

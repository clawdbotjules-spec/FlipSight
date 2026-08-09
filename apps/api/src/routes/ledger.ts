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

import { DEAL_STATUSES } from "@flipsight/shared";
import type { Prisma } from "@flipsight/db";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { errors } from "../lib/errors.js";
import { decodeCursor, encodeCursor } from "../lib/pagination.js";
import { toDealDTO } from "../lib/serializers.js";

const DealsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(200).optional(),
  minScore: z.coerce.number().int().min(0).max(100).optional(),
  status: z.enum(DEAL_STATUSES).optional(),
  category: z.string().min(1).max(80).optional(),
  /** Free-text search over the item title. */
  q: z.string().min(1).max(200).optional(),
});

const IdParams = z.object({ id: z.string().min(1).max(64) });

const DEAL_INCLUDE = { item: { include: { source: true } }, valuation: true } as const;

export default async function dealRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.addHook("onRequest", app.authenticate);

  r.get("/", { schema: { querystring: DealsQuery } }, async (req) => {
    const query = req.query;

    const itemFilter: Prisma.ItemWhereInput = {};
    if (query.category) itemFilter.category = { equals: query.category, mode: "insensitive" };
    if (query.q) itemFilter.title = { contains: query.q, mode: "insensitive" };

    const where: Prisma.DealWhereInput = {
      // Default view hides dismissed deals; ask for them explicitly.
      ...(query.status ? { status: query.status } : { status: { not: "dismissed" } }),
      ...(query.minScore != null ? { score: { gte: query.minScore } } : {}),
      ...(Object.keys(itemFilter).length > 0 ? { item: itemFilter } : {}),
    };

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

    const rows = await app.prisma.deal.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: query.limit + 1,
      include: DEAL_INCLUDE,
    });

    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    const last = page[page.length - 1];
    return {
      deals: page.map(toDealDTO),
      nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
    };
  });

  r.get("/:id", { schema: { params: IdParams } }, async (req) => {
    const deal = await app.prisma.deal.findUnique({
      where: { id: req.params.id },
      include: DEAL_INCLUDE,
    });
    if (!deal) throw errors.notFound("Deal not found");
    return { deal: toDealDTO(deal) };
  });

  r.post("/:id/claim", { schema: { params: IdParams } }, async (req) => {
    const updated = await app.prisma.deal.updateMany({
      where: { id: req.params.id, status: { in: ["new", "alerted"] } },
      data: { status: "claimed", userId: req.user.sub },
    });
    if (updated.count === 0) {
      const existing = await app.prisma.deal.findUnique({
        where: { id: req.params.id },
        select: { status: true },
      });
      if (!existing) throw errors.notFound("Deal not found");
      throw errors.conflict(`Deal cannot be claimed from status "${existing.status}"`);
    }
    const deal = await app.prisma.deal.findUniqueOrThrow({
      where: { id: req.params.id },
      include: DEAL_INCLUDE,
    });
    return { deal: toDealDTO(deal) };
  });

  r.post("/:id/dismiss", { schema: { params: IdParams } }, async (req) => {
    const updated = await app.prisma.deal.updateMany({
      where: { id: req.params.id, status: { in: ["new", "alerted", "claimed"] } },
      data: { status: "dismissed" },
    });
    if (updated.count === 0) {
      const existing = await app.prisma.deal.findUnique({
        where: { id: req.params.id },
        select: { status: true },
      });
      if (!existing) throw errors.notFound("Deal not found");
      throw errors.conflict(`Deal cannot be dismissed from status "${existing.status}"`);
    }
    const deal = await app.prisma.deal.findUniqueOrThrow({
      where: { id: req.params.id },
      include: DEAL_INCLUDE,
    });
    return { deal: toDealDTO(deal) };
  });
}

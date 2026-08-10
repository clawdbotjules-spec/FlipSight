/**
 * Source management for the UI: list feeds with activity stats, toggle them
 * on/off, and edit worker config. Config bodies are validated with the same
 * zod schemas the workers parse each sweep (`SOURCE_CONFIG_SCHEMAS`), so a
 * bad edit is rejected here instead of crashing a worker.
 */
import { SOURCE_CONFIG_SCHEMAS, SOURCE_KEYS } from "@flipsight/shared";
import type { Prisma, SourceKey } from "@flipsight/db";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { errors } from "../lib/errors.js";

const KeyParams = z.object({ key: z.enum(SOURCE_KEYS) });

const PatchBody = z.object({
  enabled: z.boolean().optional(),
  /** Full worker config for this source — validated per-source, then stored normalized. */
  config: z.record(z.string(), z.unknown()).optional(),
});

export default async function sourceRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.addHook("onRequest", app.authenticate);

  r.get("/", async () => {
    const dayAgo = new Date(Date.now() - 24 * 3600_000);
    const [sources, counts, recent] = await Promise.all([
      app.prisma.source.findMany({
        orderBy: { key: "asc" },
        include: { _count: { select: { savedSearches: true } } },
      }),
      app.prisma.item.groupBy({ by: ["sourceId"], _count: { _all: true } }),
      app.prisma.item.groupBy({
        by: ["sourceId"],
        where: { lastCheckedAt: { gte: dayAgo } },
        _count: { _all: true },
      }),
    ]);
    const totalBySource = new Map(counts.map((c) => [c.sourceId, c._count._all]));
    const recentBySource = new Map(recent.map((c) => [c.sourceId, c._count._all]));
    return {
      sources: sources.map((s) => ({
        key: s.key,
        name: s.name,
        enabled: s.enabled,
        config: s.config as Record<string, unknown>,
        savedSearches: s._count.savedSearches,
        itemsTotal: totalBySource.get(s.id) ?? 0,
        itemsLast24h: recentBySource.get(s.id) ?? 0,
        updatedAt: s.updatedAt.toISOString(),
      })),
    };
  });

  r.patch("/:key", { schema: { params: KeyParams, body: PatchBody } }, async (req) => {
    const { key } = req.params;
    const data: Prisma.SourceUpdateInput = {};
    if (req.body.enabled != null) data.enabled = req.body.enabled;
    if (req.body.config != null) {
      const parsed = SOURCE_CONFIG_SCHEMAS[key].safeParse(req.body.config);
      if (!parsed.success) {
        throw errors.badRequest(`Invalid config for source "${key}"`, parsed.error.issues);
      }
      data.config = parsed.data as Prisma.InputJsonObject;
    }
    if (Object.keys(data).length === 0) throw errors.badRequest("Nothing to update");

    const source = await app.prisma.source
      .update({ where: { key: key as SourceKey }, data })
      .catch(() => null);
    if (!source) throw errors.notFound(`Source "${key}" not found — run the seed first`);
    return {
      source: {
        key: source.key,
        name: source.name,
        enabled: source.enabled,
        config: source.config as Record<string, unknown>,
        updatedAt: source.updatedAt.toISOString(),
      },
    };
  });
}

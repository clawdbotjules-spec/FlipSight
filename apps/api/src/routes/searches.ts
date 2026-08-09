/**
 * CRUD for DB-driven worker saved searches (keyword sets, ASIN watchlists,
 * category subscriptions). `params` payloads are validated with the same
 * per-source zod schemas the workers parse with, so a UI edit can never feed
 * a worker something it doesn't understand.
 */
import { SAVED_SEARCH_PARAMS_SCHEMAS, SOURCE_KEYS } from "@flipsight/shared";
import type { Prisma, SavedSearch, Source, SourceKey } from "@flipsight/db";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { errors } from "../lib/errors.js";

const SearchCreate = z.object({
  sourceKey: z.enum(SOURCE_KEYS),
  name: z.string().min(1).max(120),
  params: z.record(z.string(), z.unknown()),
  enabled: z.boolean().default(true),
});

const SearchPatch = z.object({
  name: z.string().min(1).max(120).optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean().optional(),
});

const ListQuery = z.object({ source: z.enum(SOURCE_KEYS).optional() });
const IdParams = z.object({ id: z.string().min(1).max(64) });

function validateParams(sourceKey: string, params: unknown): unknown {
  const schema = SAVED_SEARCH_PARAMS_SCHEMAS[sourceKey as keyof typeof SAVED_SEARCH_PARAMS_SCHEMAS];
  if (!schema) return params; // sources without structured searches accept any object
  const parsed = schema.safeParse(params);
  if (!parsed.success) {
    throw errors.badRequest(`Invalid params for source "${sourceKey}"`, parsed.error.issues);
  }
  return parsed.data;
}

function toSearchDTO(search: SavedSearch & { source: Source }) {
  return {
    id: search.id,
    sourceKey: search.source.key,
    name: search.name,
    enabled: search.enabled,
    params: search.params,
    createdAt: search.createdAt.toISOString(),
    updatedAt: search.updatedAt.toISOString(),
  };
}

export default async function searchRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.addHook("onRequest", app.authenticate);

  r.get("/", { schema: { querystring: ListQuery } }, async (req) => {
    const searches = await app.prisma.savedSearch.findMany({
      where: req.query.source ? { source: { key: req.query.source as SourceKey } } : {},
      include: { source: true },
      orderBy: [{ source: { key: "asc" } }, { createdAt: "asc" }],
    });
    return { searches: searches.map(toSearchDTO) };
  });

  r.post("/", { schema: { body: SearchCreate } }, async (req, reply) => {
    const source = await app.prisma.source.findUnique({ where: { key: req.body.sourceKey as SourceKey } });
    if (!source) throw errors.notFound(`Source "${req.body.sourceKey}" not found`);
    const params = validateParams(req.body.sourceKey, req.body.params);
    const search = await app.prisma.savedSearch.create({
      data: {
        sourceId: source.id,
        name: req.body.name,
        enabled: req.body.enabled,
        params: params as Prisma.InputJsonValue,
      },
      include: { source: true },
    });
    return reply.status(201).send({ search: toSearchDTO(search) });
  });

  r.patch("/:id", { schema: { params: IdParams, body: SearchPatch } }, async (req) => {
    const existing = await app.prisma.savedSearch.findUnique({
      where: { id: req.params.id },
      include: { source: true },
    });
    if (!existing) throw errors.notFound("Saved search not found");
    const params =
      req.body.params !== undefined ? validateParams(existing.source.key, req.body.params) : undefined;
    const search = await app.prisma.savedSearch.update({
      where: { id: existing.id },
      data: {
        ...(req.body.name !== undefined ? { name: req.body.name } : {}),
        ...(req.body.enabled !== undefined ? { enabled: req.body.enabled } : {}),
        ...(params !== undefined ? { params: params as Prisma.InputJsonValue } : {}),
      },
      include: { source: true },
    });
    return { search: toSearchDTO(search) };
  });

  r.delete("/:id", { schema: { params: IdParams } }, async (req, reply) => {
    const deleted = await app.prisma.savedSearch.deleteMany({ where: { id: req.params.id } });
    if (deleted.count === 0) throw errors.notFound("Saved search not found");
    return reply.status(204).send();
  });
}

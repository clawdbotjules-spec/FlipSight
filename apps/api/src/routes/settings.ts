/**
 * App settings CRUD — the UI edits the fee schedule, shipping lookup table,
 * and valuation engine config here. Values are validated with the exact zod
 * schemas the valuation worker parses, and GET always returns the effective
 * config (stored value merged with schema defaults).
 */
import { APP_SETTING_KEYS, APP_SETTING_SCHEMAS, type AppSettingKey } from "@flipsight/shared";
import type { Prisma } from "@flipsight/db";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { errors } from "../lib/errors.js";

const KeyParams = z.object({ key: z.enum(APP_SETTING_KEYS as [AppSettingKey, ...AppSettingKey[]]) });

export default async function settingsRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.addHook("onRequest", app.authenticate);

  r.get("/", async () => {
    const rows = await app.prisma.appSetting.findMany();
    const stored = new Map(rows.map((row) => [row.key, row.value]));
    const settings = Object.fromEntries(
      APP_SETTING_KEYS.map((key) => [key, APP_SETTING_SCHEMAS[key].parse(stored.get(key) ?? {})]),
    );
    return { settings };
  });

  r.get("/:key", { schema: { params: KeyParams } }, async (req) => {
    const row = await app.prisma.appSetting.findUnique({ where: { key: req.params.key } });
    const value = APP_SETTING_SCHEMAS[req.params.key].parse(row?.value ?? {});
    return { key: req.params.key, value, updatedAt: row?.updatedAt?.toISOString() ?? null };
  });

  r.put(
    "/:key",
    { schema: { params: KeyParams, body: z.record(z.string(), z.unknown()) } },
    async (req) => {
      const schema = APP_SETTING_SCHEMAS[req.params.key];
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        throw errors.badRequest(`Invalid value for setting "${req.params.key}"`, parsed.error.issues);
      }
      const row = await app.prisma.appSetting.upsert({
        where: { key: req.params.key },
        update: { value: parsed.data as Prisma.InputJsonValue },
        create: { key: req.params.key, value: parsed.data as Prisma.InputJsonValue },
      });
      // Workers re-read settings within 60s (in-process cache TTL).
      return { key: req.params.key, value: parsed.data, updatedAt: row.updatedAt.toISOString() };
    },
  );
}

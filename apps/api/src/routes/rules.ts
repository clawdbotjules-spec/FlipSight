import { ALERT_CHANNELS, RULES_CHANGED_CHANNEL, dealMatchesRule } from "@flipsight/shared";
import { decN } from "@flipsight/db";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { errors } from "../lib/errors.js";
import { toRuleDTO } from "../lib/serializers.js";

const RuleBody = z.object({
  name: z.string().min(1).max(120).default("Untitled rule"),
  minProfit: z.number().min(0).max(1_000_000).nullish(),
  minRoi: z.number().min(0).max(100_000).nullish(),
  maxBuyPrice: z.number().gt(0).max(1_000_000).nullish(),
  categories: z.array(z.string().min(1).max(80)).max(50).default([]),
  keywords: z.array(z.string().min(1).max(80)).max(50).default([]),
  excludeKeywords: z.array(z.string().min(1).max(80)).max(50).default([]),
  localOnly: z.boolean().default(false),
  channels: z.array(z.enum(ALERT_CHANNELS)).min(1).default(["websocket"]),
  enabled: z.boolean().default(true),
});

const RulePatch = RuleBody.partial();

const IdParams = z.object({ id: z.string().min(1).max(64) });

export default async function ruleRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.addHook("onRequest", app.authenticate);

  /** Invalidate this user's cached rules on every API instance. */
  async function broadcastRulesChanged(userId: string) {
    app.fanout.invalidateRules(userId);
    try {
      await app.redis.publish(RULES_CHANGED_CHANNEL, JSON.stringify({ userId }));
    } catch (err) {
      app.log.warn({ err }, "failed to publish rules:changed");
    }
  }

  r.get("/", async (req) => {
    const rules = await app.prisma.alertRule.findMany({
      where: { userId: req.user.sub },
      orderBy: { createdAt: "desc" },
    });
    return { rules: rules.map(toRuleDTO) };
  });

  r.post("/", { schema: { body: RuleBody } }, async (req, reply) => {
    const rule = await app.prisma.alertRule.create({
      data: {
        userId: req.user.sub,
        name: req.body.name,
        minProfit: req.body.minProfit ?? null,
        minRoi: req.body.minRoi ?? null,
        maxBuyPrice: req.body.maxBuyPrice ?? null,
        categories: req.body.categories,
        keywords: req.body.keywords,
        excludeKeywords: req.body.excludeKeywords,
        localOnly: req.body.localOnly,
        channels: req.body.channels,
        enabled: req.body.enabled,
      },
    });
    await broadcastRulesChanged(req.user.sub);
    return reply.status(201).send({ rule: toRuleDTO(rule) });
  });

  /**
   * Live rule preview for the editor: "this rule would have matched N deals in
   * the last 24 h" — runs the exact shared matcher over recent deals without
   * saving anything.
   */
  r.post("/preview", { schema: { body: RuleBody.partial() } }, async (req) => {
    const since = new Date(Date.now() - 24 * 3600_000);
    const recent = await app.prisma.deal.findMany({
      where: { createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take: 500,
      include: { item: true },
    });
    const rule = {
      enabled: true,
      minProfit: req.body.minProfit ?? null,
      minRoi: req.body.minRoi ?? null,
      maxBuyPrice: req.body.maxBuyPrice ?? null,
      categories: req.body.categories ?? [],
      keywords: req.body.keywords ?? [],
      excludeKeywords: req.body.excludeKeywords ?? [],
      localOnly: req.body.localOnly ?? false,
    };
    const matched = recent.filter((deal) =>
      dealMatchesRule(
        {
          buyPrice: decN(deal.buyPrice),
          netProfit: decN(deal.netProfit),
          roiPct: deal.roiPct,
          item: { title: deal.item.title, category: deal.item.category, location: deal.item.location },
        },
        rule,
      ),
    );
    return {
      since: since.toISOString(),
      sampled: recent.length,
      matched: matched.length,
      examples: matched.slice(0, 5).map((d) => ({
        id: d.id,
        title: d.item.title,
        netProfit: decN(d.netProfit),
        score: d.score,
      })),
    };
  });

  r.get("/:id", { schema: { params: IdParams } }, async (req) => {
    const rule = await app.prisma.alertRule.findFirst({
      where: { id: req.params.id, userId: req.user.sub },
    });
    if (!rule) throw errors.notFound("Alert rule not found");
    return { rule: toRuleDTO(rule) };
  });

  r.patch("/:id", { schema: { params: IdParams, body: RulePatch } }, async (req) => {
    const existing = await app.prisma.alertRule.findFirst({
      where: { id: req.params.id, userId: req.user.sub },
      select: { id: true },
    });
    if (!existing) throw errors.notFound("Alert rule not found");

    const b = req.body;
    const rule = await app.prisma.alertRule.update({
      where: { id: existing.id },
      data: {
        ...(b.name !== undefined ? { name: b.name } : {}),
        ...(b.minProfit !== undefined ? { minProfit: b.minProfit } : {}),
        ...(b.minRoi !== undefined ? { minRoi: b.minRoi } : {}),
        ...(b.maxBuyPrice !== undefined ? { maxBuyPrice: b.maxBuyPrice } : {}),
        ...(b.categories !== undefined ? { categories: b.categories } : {}),
        ...(b.keywords !== undefined ? { keywords: b.keywords } : {}),
        ...(b.excludeKeywords !== undefined ? { excludeKeywords: b.excludeKeywords } : {}),
        ...(b.localOnly !== undefined ? { localOnly: b.localOnly } : {}),
        ...(b.channels !== undefined ? { channels: b.channels } : {}),
        ...(b.enabled !== undefined ? { enabled: b.enabled } : {}),
      },
    });
    await broadcastRulesChanged(req.user.sub);
    return { rule: toRuleDTO(rule) };
  });

  r.delete("/:id", { schema: { params: IdParams } }, async (req, reply) => {
    const deleted = await app.prisma.alertRule.deleteMany({
      where: { id: req.params.id, userId: req.user.sub },
    });
    if (deleted.count === 0) throw errors.notFound("Alert rule not found");
    await broadcastRulesChanged(req.user.sub);
    return reply.status(204).send();
  });
}

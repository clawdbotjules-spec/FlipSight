/**
 * System status for the mission-control UI: per-worker activity (derived from
 * checkpoints + item recency — worker health ports aren't reachable from the
 * browser), BullMQ queue depths, dead-letter contents, and hourly ingest
 * sparklines. The whole payload is cached for a few seconds so a dashboard
 * polling every 5 s costs almost nothing.
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { Queue } from "bullmq";
import { Redis } from "ioredis";

const WORKERS = [
  { name: "worker-ebay", queue: "ebay", sources: ["ebay"] },
  { name: "worker-keepa", queue: "keepa", sources: ["keepa_amazon"] },
  { name: "worker-goodwill", queue: "goodwill", sources: ["shopgoodwill"] },
  { name: "worker-retail", queue: "retail", sources: ["walmart_clearance", "target_clearance"] },
  { name: "worker-estate", queue: "estate", sources: ["estatesales"] },
  { name: "worker-valuate", queue: "valuate", sources: [] },
] as const;

const DEAD_LETTER = "dead-letter";
const CACHE_TTL_MS = 5_000;

interface HourBucket {
  key: string;
  hour: Date;
  count: bigint;
}

export default async function statusRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.addHook("onRequest", app.authenticate);

  // Dedicated connection: BullMQ wants maxRetriesPerRequest: null.
  const connection = new Redis(app.config.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true });
  const queues = new Map<string, Queue>();
  const queueFor = (name: string) => {
    let q = queues.get(name);
    if (!q) {
      q = new Queue(name, { connection });
      queues.set(name, q);
    }
    return q;
  };
  app.addHook("onClose", async () => {
    await Promise.allSettled([...queues.values()].map((q) => q.close()));
    connection.disconnect();
  });

  let cache: { at: number; payload: unknown } | null = null;

  r.get("/system", async () => {
    if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.payload;

    const now = Date.now();
    const dayAgo = new Date(now - 24 * 3600_000);
    const hourAgo = new Date(now - 3600_000);

    const [checkpoints, sources, hourly, valuationsLastHour, dealsLast24h, alerts24h, queueCounts, dlqCounts, dlqJobs] =
      await Promise.all([
        app.prisma.workerCheckpoint.groupBy({ by: ["sourceKey"], _max: { updatedAt: true } }),
        app.prisma.source.findMany({ select: { id: true, key: true, enabled: true } }),
        app.prisma.$queryRaw<HourBucket[]>`
          SELECT s."key"::text AS key, date_trunc('hour', i."lastCheckedAt") AS hour, count(*)::bigint AS count
          FROM "Item" i JOIN "Source" s ON s."id" = i."sourceId"
          WHERE i."lastCheckedAt" >= ${dayAgo}
          GROUP BY 1, 2 ORDER BY 2 ASC`,
        app.prisma.valuation.count({ where: { computedAt: { gte: hourAgo } } }),
        app.prisma.deal.count({ where: { createdAt: { gte: dayAgo } } }),
        app.prisma.alertEvent.groupBy({
          by: ["channel"],
          where: { sentAt: { gte: dayAgo } },
          _count: { _all: true },
        }),
        Promise.all(
          WORKERS.map((w) =>
            queueFor(w.queue)
              .getJobCounts("waiting", "active", "delayed", "failed", "completed")
              .catch(() => null),
          ),
        ),
        queueFor(DEAD_LETTER)
          .getJobCounts("waiting", "delayed", "failed")
          .catch(() => null),
        queueFor(DEAD_LETTER)
          .getJobs(["waiting", "delayed"], 0, 9, false)
          .catch(() => []),
      ]);

    const lastCheckpointBySource = new Map(
      checkpoints.map((c) => [c.sourceKey as string, c._max.updatedAt?.toISOString() ?? null]),
    );
    const enabledByKey = new Map(sources.map((s) => [s.key as string, s.enabled]));

    // 24 aligned hour buckets per source key for the sparklines.
    const hourStarts: number[] = [];
    const firstHour = Math.floor((now - 23 * 3600_000) / 3600_000) * 3600_000;
    for (let i = 0; i < 24; i++) hourStarts.push(firstHour + i * 3600_000);
    const sparkBySource = new Map<string, number[]>();
    for (const row of hourly) {
      const spark = sparkBySource.get(row.key) ?? new Array(24).fill(0);
      const idx = Math.floor((row.hour.getTime() - firstHour) / 3600_000);
      if (idx >= 0 && idx < 24) spark[idx] = Number(row.count);
      sparkBySource.set(row.key, spark);
    }

    const workers = WORKERS.map((w, i) => {
      const sparks = w.sources.map((s) => sparkBySource.get(s) ?? new Array(24).fill(0));
      const spark = new Array(24).fill(0).map((_, h) => sparks.reduce((sum, sp) => sum + sp[h], 0));
      const itemsLastHour = spark[23] ?? 0;
      const items24h = spark.reduce((a, b) => a + b, 0);
      const lastActivity = w.sources
        .map((s) => lastCheckpointBySource.get(s))
        .filter(Boolean)
        .sort()
        .pop();
      return {
        name: w.name,
        queue: w.queue,
        sources: w.sources,
        enabled: w.sources.length === 0 ? true : w.sources.some((s) => enabledByKey.get(s) !== false),
        lastActivityAt: lastActivity ?? null,
        itemsLastHour,
        items24h,
        sparkline: spark,
        counts: queueCounts[i],
      };
    });

    const payload = {
      status: {
        generatedAt: new Date(now).toISOString(),
        workers,
        valuationsLastHour,
        dealsLast24h,
        alerts24h: Object.fromEntries(alerts24h.map((a) => [a.channel, a._count._all])),
        deadLetter: {
          counts: dlqCounts,
          recent: dlqJobs.map((j) => ({
            name: j.name,
            failedAt: j.timestamp ? new Date(j.timestamp).toISOString() : null,
            data: j.data as Record<string, unknown>,
          })),
        },
      },
    };
    cache = { at: Date.now(), payload };
    return payload;
  });
}

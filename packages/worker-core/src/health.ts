/**
 * Tiny dependency-free health endpoint for worker containers. Reports DB and
 * Redis reachability plus queue depths; docker-compose healthchecks poll it.
 */
import { createServer, type Server } from "node:http";
import type { PrismaClient } from "@flipsight/db";
import type { Queue } from "bullmq";
import type { Redis } from "ioredis";
import type { Logger } from "pino";

export interface HealthServerDeps {
  worker: string;
  port: number;
  prisma: PrismaClient;
  redis: Redis;
  queues: () => Queue[];
  extra: () => Record<string, unknown>;
  log: Logger;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

export function startHealthServer(deps: HealthServerDeps): Server {
  const server = createServer((req, res) => {
    if (req.url !== "/health" && req.url !== "/") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    void (async () => {
      const checks: { db: "up" | "down"; redis: "up" | "down" } = { db: "up", redis: "up" };
      try {
        await withTimeout(deps.prisma.$queryRaw`SELECT 1`, 2000);
      } catch {
        checks.db = "down";
      }
      try {
        await withTimeout(deps.redis.ping(), 2000);
      } catch {
        checks.redis = "down";
      }

      const queues: Record<string, unknown> = {};
      try {
        for (const queue of deps.queues()) {
          queues[queue.name] = await withTimeout(
            queue.getJobCounts("active", "waiting", "delayed", "failed", "completed"),
            2000,
          );
        }
      } catch {
        // queue stats are best-effort
      }

      const healthy = checks.db === "up" && checks.redis === "up";
      res.writeHead(healthy ? 200 : 503, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          status: healthy ? "ok" : "degraded",
          service: deps.worker,
          uptimeSec: Math.round(process.uptime()),
          checks,
          queues,
          ...deps.extra(),
        }),
      );
    })().catch((err) => {
      deps.log.warn({ err }, "health handler error");
      try {
        res.writeHead(500);
        res.end();
      } catch {
        // socket already gone
      }
    });
  });
  server.listen(deps.port, "0.0.0.0", () => {
    deps.log.info({ port: deps.port }, "health server listening");
  });
  return server;
}

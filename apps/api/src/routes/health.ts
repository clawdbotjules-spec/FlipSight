import type { FastifyInstance } from "fastify";

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

export default async function healthRoutes(app: FastifyInstance) {
  app.get("/health", { config: { rateLimit: false } }, async (_req, reply) => {
    const checks: { db: "up" | "down"; redis: "up" | "down" } = { db: "up", redis: "up" };

    try {
      await withTimeout(app.prisma.$queryRaw`SELECT 1`, 2000);
    } catch {
      checks.db = "down";
    }
    try {
      await withTimeout(app.redis.ping(), 2000);
    } catch {
      checks.redis = "down";
    }

    const healthy = checks.db === "up" && checks.redis === "up";
    return reply.status(healthy ? 200 : 503).send({
      status: healthy ? "ok" : "degraded",
      service: "api",
      uptimeSec: Math.round(process.uptime()),
      wsConnections: app.fanout.connectionCount,
      checks,
    });
  });
}

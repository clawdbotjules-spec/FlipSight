import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { AppError } from "./lib/errors.js";
import authPlugin from "./plugins/auth.js";
import prismaPlugin from "./plugins/prisma.js";
import redisPlugin from "./plugins/redis.js";
import { DealFanout } from "./realtime/fanout.js";
import authRoutes from "./routes/auth.js";
import dealRoutes from "./routes/deals.js";
import healthRoutes from "./routes/health.js";
import ledgerRoutes from "./routes/ledger.js";
import ruleRoutes from "./routes/rules.js";
import searchRoutes from "./routes/searches.js";
import wsRoutes from "./routes/ws.js";
import type { AppConfig } from "./config.js";

declare module "fastify" {
  interface FastifyInstance {
    fanout: DealFanout;
  }
}

export async function buildApp(config: AppConfig): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: ["req.headers.authorization"],
      ...(config.NODE_ENV === "development"
        ? {
            transport: {
              target: "pino-pretty",
              options: { translateTime: "SYS:HH:MM:ss", ignore: "pid,hostname" },
            },
          }
        : {}),
    },
    trustProxy: true,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorate("config", config);

  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof AppError) {
      return reply
        .status(err.statusCode)
        .send({ error: { code: err.code, message: err.message, details: err.details ?? null } });
    }
    const fastifyErr = err as {
      statusCode?: number;
      code?: string;
      message?: string;
      validation?: unknown;
    };
    if (fastifyErr.validation) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION",
          message: "Request validation failed",
          details: fastifyErr.validation,
        },
      });
    }
    const status =
      typeof fastifyErr.statusCode === "number" && fastifyErr.statusCode >= 400
        ? fastifyErr.statusCode
        : 500;
    if (status >= 500) {
      req.log.error({ err }, "unhandled error");
    }
    return reply.status(status).send({
      error: {
        code: fastifyErr.code ?? "INTERNAL",
        message: status >= 500 ? "Internal server error" : (fastifyErr.message ?? "Request failed"),
        details: null,
      },
    });
  });

  app.setNotFoundHandler((req, reply) => {
    reply
      .status(404)
      .send({ error: { code: "NOT_FOUND", message: `Route ${req.method} ${req.url} not found`, details: null } });
  });

  // Infrastructure plugins.
  await app.register(prismaPlugin);
  await app.register(redisPlugin, { url: config.REDIS_URL });
  await app.register(authPlugin, { secret: config.JWT_SECRET });

  const corsOrigins = new Set([config.APP_URL, "http://localhost:3000", "http://127.0.0.1:3000"]);
  await app.register(cors, { origin: [...corsOrigins], credentials: true });

  await app.register(rateLimit, {
    global: true,
    max: config.RATE_LIMIT_MAX,
    timeWindow: "1 minute",
    redis: app.redis,
    nameSpace: "flipsight-rl:",
  });

  await app.register(websocket, {
    options: { maxPayload: 64 * 1024 },
  });

  // Realtime fan-out. Decorated before routes so /ws and /health can use it.
  const fanout = new DealFanout({ prisma: app.prisma, subscriber: app.redisSub, log: app.log });
  app.decorate("fanout", fanout);
  app.addHook("onClose", async () => {
    fanout.stop();
  });

  // Routes.
  await app.register(healthRoutes);
  await app.register(wsRoutes);
  await app.register(authRoutes, { prefix: "/auth" });
  await app.register(ruleRoutes, { prefix: "/rules" });
  await app.register(dealRoutes, { prefix: "/deals" });
  await app.register(ledgerRoutes, { prefix: "/ledger" });
  await app.register(searchRoutes, { prefix: "/searches" });

  await fanout.start();

  return app;
}

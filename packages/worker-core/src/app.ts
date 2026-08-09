/**
 * WorkerApp — the shared chassis for every FlipSight source worker.
 *
 * Provides: env loading, pino structured logging, Prisma + Redis connections,
 * BullMQ queues/workers with sane retry defaults, repeatable job schedulers
 * (persisted in Redis, so schedules survive crashes and resume on restart),
 * a global dead-letter queue, per-source config parsing from `Source.config`,
 * checkpoint storage, a health HTTP server, and graceful shutdown.
 */
import { createPrismaClient, type PrismaClient, type Source, type SavedSearch, type SourceKey } from "@flipsight/db";
import {
  DEALS_NEW_CHANNEL,
  loadEnvFile,
  type DealAlertPayload,
  type SourceKeyName,
} from "@flipsight/shared";
import { Queue, Worker, type Job, type JobsOptions, type WorkerOptions } from "bullmq";
import { Redis } from "ioredis";
import { pino, type Logger } from "pino";
import type { Server } from "node:http";
import { CheckpointStore } from "./checkpoints.js";
import { startHealthServer } from "./health.js";
import type { z } from "zod";

export const DEAD_LETTER_QUEUE = "dead-letter";

export interface WorkerAppOptions {
  name: string;
  /** Primary Source row this worker serves (most workers have exactly one). */
  sourceKey?: SourceKeyName;
}

export interface WorkerEnv {
  DATABASE_URL: string;
  REDIS_URL: string;
  HEALTH_PORT: number;
  LOG_LEVEL: string;
  NODE_ENV: string;
}

const DEFAULT_JOB_OPTS: JobsOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 15_000 },
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

export class WorkerApp {
  readonly queues = new Map<string, Queue>();
  private readonly workers: Worker[] = [];
  private healthServer: Server | null = null;
  private readonly healthExtra: Record<string, unknown> = {};
  private closing = false;

  private constructor(
    readonly name: string,
    readonly env: WorkerEnv,
    readonly log: Logger,
    readonly prisma: PrismaClient,
    /** BullMQ connection (maxRetriesPerRequest: null, as BullMQ requires). */
    readonly bullConnection: Redis,
    /** General-purpose Redis client (pub/sub publish, caching). */
    readonly redis: Redis,
    readonly dlq: Queue,
    private readonly sourceKey?: SourceKeyName,
  ) {}

  static async create(options: WorkerAppOptions): Promise<WorkerApp> {
    loadEnvFile();
    const env: WorkerEnv = {
      DATABASE_URL: requireEnv("DATABASE_URL"),
      REDIS_URL: requireEnv("REDIS_URL"),
      HEALTH_PORT: Number(process.env.HEALTH_PORT ?? 8080),
      LOG_LEVEL: process.env.LOG_LEVEL ?? "info",
      NODE_ENV: process.env.NODE_ENV ?? "development",
    };

    const log = pino({
      name: options.name,
      level: env.LOG_LEVEL,
      base: { worker: options.name },
      ...(env.NODE_ENV === "development"
        ? {
            transport: {
              target: "pino-pretty",
              options: { translateTime: "SYS:HH:MM:ss", ignore: "pid,hostname,worker" },
            },
          }
        : {}),
    });

    const prisma = createPrismaClient();
    await prisma.$connect();

    const bullConnection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
    const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2, connectTimeout: 2000 });
    bullConnection.on("error", (err) => log.warn({ err: err.message }, "bull redis error"));
    redis.on("error", (err) => log.warn({ err: err.message }, "redis error"));
    await redis.ping();

    const dlq = new Queue(DEAD_LETTER_QUEUE, { connection: bullConnection });

    const app = new WorkerApp(
      options.name,
      env,
      log,
      prisma,
      bullConnection,
      redis,
      dlq,
      options.sourceKey,
    );

    app.healthServer = startHealthServer({
      worker: options.name,
      port: env.HEALTH_PORT,
      prisma,
      redis,
      queues: () => [...app.queues.values()],
      extra: () => app.healthExtra,
      log,
    });

    process.once("SIGTERM", () => void app.shutdown("SIGTERM"));
    process.once("SIGINT", () => void app.shutdown("SIGINT"));
    process.on("unhandledRejection", (reason) => {
      log.error({ reason: reason instanceof Error ? reason.stack : reason }, "unhandled rejection");
    });

    log.info({ healthPort: env.HEALTH_PORT }, "worker starting");
    return app;
  }

  queue(name: string): Queue {
    let queue = this.queues.get(name);
    if (!queue) {
      queue = new Queue(name, { connection: this.bullConnection, defaultJobOptions: DEFAULT_JOB_OPTS });
      this.queues.set(name, queue);
    }
    return queue;
  }

  /**
   * Register a processor. Failures are logged; jobs that exhaust their
   * attempts are copied to the global dead-letter queue for inspection.
   */
  process<T = unknown>(
    queueName: string,
    handler: (job: Job<T>) => Promise<unknown>,
    options: Partial<Pick<WorkerOptions, "concurrency">> = {},
  ): Worker<T> {
    this.queue(queueName); // ensure queue exists for health stats
    const worker = new Worker<T>(
      queueName,
      async (job) => {
        const startedAt = Date.now();
        const jobLog = this.log.child({ queue: queueName, job: job.name, jobId: job.id });
        jobLog.debug({ event: "job_started", attempt: job.attemptsMade + 1 }, "job started");
        try {
          const result = await handler(job);
          jobLog.info({ event: "job_completed", durationMs: Date.now() - startedAt }, "job completed");
          return result;
        } catch (err) {
          jobLog.warn(
            {
              event: "job_failed",
              durationMs: Date.now() - startedAt,
              attempt: job.attemptsMade + 1,
              maxAttempts: job.opts.attempts ?? 1,
              err: err instanceof Error ? err.message : String(err),
            },
            "job failed",
          );
          throw err;
        }
      },
      { connection: this.bullConnection, concurrency: options.concurrency ?? 1 },
    );

    worker.on("failed", (job, err) => {
      if (!job) return;
      const maxAttempts = job.opts.attempts ?? 1;
      if (job.attemptsMade >= maxAttempts) {
        this.log.error(
          { event: "job_dead_lettered", queue: queueName, job: job.name, jobId: job.id, err: err.message },
          "job exhausted retries — moving to dead-letter queue",
        );
        void this.dlq
          .add(
            `${queueName}:${job.name}`,
            {
              queue: queueName,
              name: job.name,
              jobId: job.id,
              data: job.data,
              failedReason: err.message,
              attemptsMade: job.attemptsMade,
              failedAt: new Date().toISOString(),
              worker: this.name,
            },
            { removeOnComplete: false, removeOnFail: false, attempts: 1 },
          )
          .catch((dlqErr: Error) => this.log.error({ err: dlqErr.message }, "failed to write dead-letter entry"));
      }
    });
    worker.on("error", (err) => this.log.error({ err: err.message }, "bullmq worker error"));

    this.workers.push(worker as Worker);
    return worker;
  }

  /**
   * Upsert a repeatable schedule (persisted in Redis — restarts resume it,
   * and re-registering with a new interval replaces the old one).
   */
  async scheduleEvery(
    queueName: string,
    schedulerId: string,
    everyMs: number,
    jobName: string,
    data: unknown = {},
    jobOpts: JobsOptions = { attempts: 2, backoff: { type: "exponential", delay: 30_000 } },
  ): Promise<void> {
    const queue = this.queue(queueName);
    await queue.upsertJobScheduler(
      schedulerId,
      { every: everyMs },
      { name: jobName, data, opts: jobOpts },
    );
    this.log.info(
      { event: "schedule_registered", queue: queueName, schedulerId, everySec: Math.round(everyMs / 1000) },
      "repeatable job scheduled",
    );
  }

  checkpoints(sourceKey?: SourceKeyName): CheckpointStore {
    const key = sourceKey ?? this.sourceKey;
    if (!key) throw new Error("checkpoints() requires a sourceKey");
    return new CheckpointStore(this.prisma, key as SourceKey);
  }

  async getSource(sourceKey?: SourceKeyName): Promise<Source> {
    const key = sourceKey ?? this.sourceKey;
    if (!key) throw new Error("getSource() requires a sourceKey");
    const source = await this.prisma.source.findUnique({ where: { key: key as SourceKey } });
    if (!source) {
      throw new Error(`Source row "${key}" not found — run \`npm run db:seed\` first`);
    }
    return source;
  }

  /**
   * Parse `Source.config` with the given schema. Invalid/partial configs fall
   * back to schema defaults (with a warning) so a bad UI edit can't crash the
   * worker. Re-read every sweep so config edits apply without a restart.
   */
  async getSourceConfig<S extends z.ZodTypeAny>(schema: S, sourceKey?: SourceKeyName): Promise<z.infer<S>> {
    const source = await this.getSource(sourceKey);
    const parsed = schema.safeParse(source.config ?? {});
    if (parsed.success) return parsed.data;
    this.log.warn(
      { event: "config_invalid", issues: parsed.error.issues.slice(0, 5) },
      "Source.config failed validation — using schema defaults",
    );
    return schema.parse({});
  }

  async loadSavedSearches(sourceKey?: SourceKeyName): Promise<SavedSearch[]> {
    const source = await this.getSource(sourceKey);
    return this.prisma.savedSearch.findMany({
      where: { sourceId: source.id, enabled: true },
      orderBy: { createdAt: "asc" },
    });
  }

  async publishDealPayload(payload: DealAlertPayload): Promise<number> {
    return this.redis.publish(DEALS_NEW_CHANNEL, JSON.stringify(payload));
  }

  setHealth(fields: Record<string, unknown>): void {
    Object.assign(this.healthExtra, fields);
  }

  async shutdown(signal: string): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.log.info({ signal }, "shutting down gracefully");
    const force = setTimeout(() => process.exit(1), 15_000);
    force.unref();
    try {
      await Promise.allSettled(this.workers.map((w) => w.close()));
      await Promise.allSettled([...this.queues.values()].map((q) => q.close()));
      await this.dlq.close().catch(() => undefined);
      this.healthServer?.close();
      this.redis.disconnect();
      this.bullConnection.disconnect();
      await this.prisma.$disconnect();
      this.log.info("shutdown complete");
      process.exit(0);
    } catch (err) {
      this.log.error({ err }, "error during shutdown");
      process.exit(1);
    }
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required — set it in the environment or .env`);
  return value;
}

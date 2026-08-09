/**
 * Persisted per-source key/value state (WorkerCheckpoint table) so workers
 * resume where they left off after a crash or redeploy: search rotations,
 * last-seen timestamps, HTTP cache validators, content hashes.
 */
import type { PrismaClient, SourceKey, Prisma } from "@flipsight/db";

export class CheckpointStore {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly sourceKey: SourceKey,
  ) {}

  async get<T>(key: string): Promise<T | null> {
    const row = await this.prisma.workerCheckpoint.findUnique({
      where: { sourceKey_key: { sourceKey: this.sourceKey, key } },
    });
    return row ? (row.value as T) : null;
  }

  async set(key: string, value: unknown): Promise<void> {
    await this.prisma.workerCheckpoint.upsert({
      where: { sourceKey_key: { sourceKey: this.sourceKey, key } },
      update: { value: value as Prisma.InputJsonValue },
      create: { sourceKey: this.sourceKey, key, value: value as Prisma.InputJsonValue },
    });
  }
}

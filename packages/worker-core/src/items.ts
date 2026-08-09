/**
 * Canonical Item ingestion used by every source worker, plus the valuate-job
 * enqueue that follows each write (per the worker contract: write/update Item
 * rows, then enqueue a `valuate` job).
 */
import { decN, type Item, type Prisma, type PrismaClient } from "@flipsight/db";
import type { Queue } from "bullmq";

export const VALUATE_QUEUE = "valuate";

export interface UpsertItemInput {
  sourceId: string;
  externalId: string;
  title: string;
  sourceUrl: string;
  currentPrice: number;
  category?: string | null;
  condition?: string | null;
  imageUrls?: string[];
  location?: string | null;
  upc?: string | null;
  isbn?: string | null;
  asin?: string | null;
  endsAt?: Date | null;
  bidsCount?: number | null;
  currency?: string;
  raw?: unknown;
}

export interface UpsertItemResult {
  item: Item;
  created: boolean;
  priceChanged: boolean;
}

export async function upsertItem(prisma: PrismaClient, input: UpsertItemInput): Promise<UpsertItemResult> {
  const where = { sourceId_externalId: { sourceId: input.sourceId, externalId: input.externalId } };
  const existing = await prisma.item.findUnique({ where });

  const common = {
    title: input.title,
    sourceUrl: input.sourceUrl,
    currentPrice: input.currentPrice,
    category: input.category ?? null,
    condition: input.condition ?? null,
    imageUrls: input.imageUrls ?? [],
    location: input.location ?? null,
    upc: input.upc ?? null,
    isbn: input.isbn ?? null,
    asin: input.asin ?? null,
    endsAt: input.endsAt ?? null,
    bidsCount: input.bidsCount ?? null,
    currency: input.currency ?? "USD",
    raw: (input.raw ?? {}) as Prisma.InputJsonValue,
  };

  if (!existing) {
    const item = await prisma.item.create({
      data: { sourceId: input.sourceId, externalId: input.externalId, ...common },
    });
    return { item, created: true, priceChanged: true };
  }

  const priceChanged = Math.abs(decN(existing.currentPrice) - input.currentPrice) >= 0.01;
  const item = await prisma.item.update({
    where,
    data: { ...common, lastCheckedAt: new Date() },
  });
  return { item, created: false, priceChanged };
}

export interface ValuateJobData {
  itemId: string;
  /** Why the item is being (re)valued — shows up in logs and job listings. */
  reason: string;
}

/**
 * Enqueue a valuate job with per-item dedupe: the job id is derived from the
 * item, so re-enqueues while a prior job is queued/recently-completed are
 * no-ops. Pass `force` to bypass dedupe (e.g. price changed materially).
 */
export async function enqueueValuate(
  queue: Queue,
  data: ValuateJobData,
  options: { force?: boolean } = {},
): Promise<void> {
  const jobId = options.force ? `v-${data.itemId}-${Date.now()}` : `v-${data.itemId}`;
  await queue.add("valuate", data, {
    jobId,
    attempts: 4,
    backoff: { type: "exponential", delay: 10_000 },
    removeOnComplete: { age: 3600, count: 5000 },
    removeOnFail: { age: 24 * 3600 },
  });
}

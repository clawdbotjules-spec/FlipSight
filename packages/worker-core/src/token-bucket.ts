/**
 * Token-bucket rate limiter. Each source worker owns one bucket per upstream
 * host, sized from `Source.config`. `take()` resolves when a token is
 * available; waits are logged so rate-limit compliance is provable from logs.
 */
import type { Logger } from "pino";

export interface TokenBucketOptions {
  name: string;
  /** Sustained request rate (tokens refilled per second). */
  ratePerSec: number;
  /** Bucket capacity (burst size). Defaults to ceil(ratePerSec), min 1. */
  burst?: number;
  log?: Logger;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class TokenBucket {
  private readonly capacity: number;
  private tokens: number;
  private lastRefillAt: number;
  /** Serializes takers so concurrent callers queue fairly (FIFO). */
  private queueTail: Promise<void> = Promise.resolve();

  constructor(private readonly opts: TokenBucketOptions) {
    if (opts.ratePerSec <= 0) throw new Error(`TokenBucket ${opts.name}: ratePerSec must be > 0`);
    this.capacity = Math.max(1, opts.burst ?? Math.ceil(opts.ratePerSec));
    this.tokens = this.capacity;
    this.lastRefillAt = Date.now();
  }

  private refill(now: number): void {
    const elapsedSec = (now - this.lastRefillAt) / 1000;
    if (elapsedSec > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.opts.ratePerSec);
      this.lastRefillAt = now;
    }
  }

  /**
   * Acquire `cost` tokens, waiting as needed. Returns milliseconds waited.
   */
  async take(cost = 1): Promise<number> {
    const myTurn = this.queueTail;
    let release!: () => void;
    this.queueTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await myTurn;

    const startedAt = Date.now();
    try {
      for (;;) {
        this.refill(Date.now());
        if (this.tokens >= cost) {
          this.tokens -= cost;
          const waitedMs = Date.now() - startedAt;
          if (waitedMs > 50) {
            this.opts.log?.info(
              { event: "rate_limited", bucket: this.opts.name, waitedMs, ratePerSec: this.opts.ratePerSec },
              "token bucket throttled request",
            );
          }
          return waitedMs;
        }
        const deficit = cost - this.tokens;
        const waitMs = Math.max(10, Math.ceil((deficit / this.opts.ratePerSec) * 1000));
        await sleep(waitMs);
      }
    } finally {
      release();
    }
  }
}

/** Randomized politeness delay (crawl jitter) between scraper requests. */
export async function politeDelay(minMs: number, maxMs: number): Promise<number> {
  const ms = Math.floor(minMs + Math.random() * Math.max(0, maxMs - minMs));
  await sleep(ms);
  return ms;
}

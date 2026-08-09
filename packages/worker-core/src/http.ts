/**
 * Polite HTTP client for source workers: token-bucket pacing, robots.txt
 * enforcement, conditional requests (ETag / Last-Modified persisted in
 * WorkerCheckpoint), timeouts, and structured request logging. Retries are
 * intentionally left to BullMQ's exponential backoff — errors here fail the
 * job, which retries with backoff and eventually dead-letters.
 */
import { createHash } from "node:crypto";
import type { Logger } from "pino";
import type { CheckpointStore } from "./checkpoints.js";
import { RobotsDisallowedError, type RobotsGuard } from "./robots.js";
import type { TokenBucket } from "./token-bucket.js";

export const DEFAULT_USER_AGENT =
  "FlipSightBot/0.1 (+https://github.com/clawdbotjules-spec/FlipSight; polite; contact via repo)";

export interface HttpClientOptions {
  name: string;
  log: Logger;
  bucket?: TokenBucket;
  robots?: RobotsGuard;
  userAgent?: string;
  timeoutMs?: number;
  defaultHeaders?: Record<string, string>;
  checkpoints?: CheckpointStore;
}

export interface HttpRequestOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  /**
   * Enables conditional GETs: validators (ETag/Last-Modified) are persisted
   * under this key and replayed as If-None-Match / If-Modified-Since.
   */
  cacheKey?: string;
  timeoutMs?: number;
}

export interface HttpResult {
  status: number;
  ok: boolean;
  /** True when the server answered 304 Not Modified for a conditional GET. */
  notModified: boolean;
  headers: Headers;
  text: string;
  json<T>(): T;
}

export class HttpStatusError extends Error {
  constructor(
    public readonly url: string,
    public readonly status: number,
    public readonly retryAfterMs: number | null,
    bodyPreview: string,
  ) {
    super(`HTTP ${status} from ${new URL(url).host}: ${bodyPreview.slice(0, 200)}`);
    this.name = "HttpStatusError";
  }
}

interface CacheValidators {
  etag?: string;
  lastModified?: string;
}

export class HttpClient {
  constructor(private readonly opts: HttpClientOptions) {}

  async request(url: string, options: HttpRequestOptions = {}): Promise<HttpResult> {
    const method = options.method ?? "GET";

    if (this.opts.robots) {
      const decision = await this.opts.robots.decide(url);
      if (!decision.allowed) {
        throw new RobotsDisallowedError(url, decision.matchedRule);
      }
    }

    const waitedMs = (await this.opts.bucket?.take(1)) ?? 0;

    const headers: Record<string, string> = {
      "user-agent": this.opts.userAgent ?? DEFAULT_USER_AGENT,
      accept: "application/json, text/html, application/xml;q=0.9, */*;q=0.8",
      ...this.opts.defaultHeaders,
      ...options.headers,
    };

    let validators: CacheValidators | null = null;
    if (options.cacheKey && method === "GET" && this.opts.checkpoints) {
      validators = await this.opts.checkpoints.get<CacheValidators>(`http-cache:${options.cacheKey}`);
      if (validators?.etag) headers["if-none-match"] = validators.etag;
      if (validators?.lastModified) headers["if-modified-since"] = validators.lastModified;
    }

    const startedAt = Date.now();
    const parsed = new URL(url);
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        ...(options.body !== undefined ? { body: options.body } : {}),
        redirect: "follow",
        signal: AbortSignal.timeout(options.timeoutMs ?? this.opts.timeoutMs ?? 25_000),
      });
    } catch (err) {
      this.opts.log.warn(
        { event: "http_error", source: this.opts.name, host: parsed.host, path: parsed.pathname, err: (err as Error).message },
        "http request failed",
      );
      throw err;
    }
    const text = response.status === 304 ? "" : await response.text();
    const durationMs = Date.now() - startedAt;

    this.opts.log.info(
      {
        event: "http_request",
        source: this.opts.name,
        method,
        host: parsed.host,
        path: parsed.pathname,
        status: response.status,
        durationMs,
        throttledMs: waitedMs,
        cached: response.status === 304,
        bytes: text.length,
      },
      "http request",
    );

    if (options.cacheKey && method === "GET" && this.opts.checkpoints && response.ok) {
      const etag = response.headers.get("etag");
      const lastModified = response.headers.get("last-modified");
      if (etag || lastModified) {
        await this.opts.checkpoints.set(`http-cache:${options.cacheKey}`, {
          ...(etag ? { etag } : {}),
          ...(lastModified ? { lastModified } : {}),
        });
      }
    }

    if (!response.ok && response.status !== 304) {
      const retryAfterHeader = response.headers.get("retry-after");
      const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 || null : null;
      throw new HttpStatusError(url, response.status, retryAfterMs, text);
    }

    return {
      status: response.status,
      ok: response.ok,
      notModified: response.status === 304,
      headers: response.headers,
      text,
      json<T>(): T {
        return JSON.parse(text) as T;
      },
    };
  }
}

/** Stable content hash used to detect unchanged responses from POST APIs. */
export function contentHash(value: unknown): string {
  return createHash("sha1").update(JSON.stringify(value)).digest("hex");
}

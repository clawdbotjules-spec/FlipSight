/**
 * Keepa API client. Keepa meters usage in tokens (roughly 1/product); the
 * shared bucket paces requests to the configured tokens/minute, and the
 * client also surfaces Keepa's own tokensLeft so sweeps back off when low.
 */
import { HttpStatusError, type LoggerLike, type TokenBucket } from "@flipsight/shared";

const KEEPA_API = "https://api.keepa.com";

export interface KeepaProduct {
  asin: string;
  title?: string;
  /** csv[0]=AMAZON, csv[1]=NEW, csv[3]=SALES rank … values in cents, -1 = gap. */
  csv?: Array<number[] | null>;
  imagesCSV?: string;
  categoryTree?: Array<{ catId: number; name: string }>;
  brand?: string;
  eanList?: string[];
  upcList?: string[];
  salesRankReference?: number;
  stats?: { current?: number[]; avg90?: number[] };
}

interface KeepaProductResponse {
  tokensLeft?: number;
  refillIn?: number;
  refillRate?: number;
  products?: KeepaProduct[];
  error?: { message?: string };
}

interface KeepaBestSellersResponse {
  tokensLeft?: number;
  bestSellersList?: { asinList?: string[] };
  error?: { message?: string };
}

export class KeepaClient {
  tokensLeft: number | null = null;

  constructor(
    private readonly opts: {
      apiKey: string | undefined;
      domain: number;
      bucket: TokenBucket;
      log: LoggerLike;
    },
  ) {}

  isConfigured(): boolean {
    return Boolean(this.opts.apiKey);
  }

  private async get<T extends { tokensLeft?: number; error?: { message?: string } }>(
    path: string,
    params: URLSearchParams,
    tokenCost: number,
  ): Promise<T> {
    if (!this.opts.apiKey) throw new Error("KEEPA_API_KEY is not set");
    const waitedMs = await this.opts.bucket.take(tokenCost);
    params.set("key", this.opts.apiKey);
    params.set("domain", String(this.opts.domain));
    const url = `${KEEPA_API}${path}?${params.toString()}`;
    const startedAt = Date.now();
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    const text = await res.text();
    this.opts.log.info(
      {
        event: "http_request",
        source: "keepa",
        host: "api.keepa.com",
        path,
        status: res.status,
        durationMs: Date.now() - startedAt,
        throttledMs: waitedMs,
        tokenCost,
      },
      "http request",
    );
    if (!res.ok) {
      throw new HttpStatusError(url, res.status, res.status === 429 ? 60_000 : null, text);
    }
    const json = JSON.parse(text) as T;
    if (typeof json.tokensLeft === "number") {
      this.tokensLeft = json.tokensLeft;
      if (json.tokensLeft < 5) {
        this.opts.log.warn(
          { event: "keepa_tokens_low", tokensLeft: json.tokensLeft },
          "Keepa token balance low — sweeps will slow down",
        );
      }
    }
    if (json.error?.message) throw new Error(`Keepa error: ${json.error.message}`);
    return json;
  }

  async products(asins: string[], statsDays = 90): Promise<KeepaProduct[]> {
    if (asins.length === 0) return [];
    const params = new URLSearchParams({
      asin: asins.join(","),
      stats: String(statsDays),
      history: "1",
    });
    const res = await this.get<KeepaProductResponse>("/product", params, asins.length);
    return res.products ?? [];
  }

  async bestSellers(categoryId: number): Promise<string[]> {
    const params = new URLSearchParams({ category: String(categoryId) });
    const res = await this.get<KeepaBestSellersResponse>("/bestsellers", params, 1);
    return res.bestSellersList?.asinList ?? [];
  }
}

export function keepaImageUrls(imagesCSV: string | undefined): string[] {
  if (!imagesCSV) return [];
  return imagesCSV
    .split(",")
    .slice(0, 3)
    .filter(Boolean)
    .map((name) => `https://m.media-amazon.com/images/I/${name.trim()}`);
}

export function amazonUrl(asin: string): string {
  return `https://www.amazon.com/dp/${asin}`;
}

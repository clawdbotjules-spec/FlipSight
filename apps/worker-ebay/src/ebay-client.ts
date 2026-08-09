/**
 * Thin eBay API client: OAuth2 client-credentials token management, Browse
 * API search, and Marketplace Insights sold-comps search. All calls go
 * through the shared token bucket so the worker's rate limit is provable.
 */
import type { Logger, TokenBucket } from "@flipsight/worker-core";
import { HttpStatusError } from "@flipsight/worker-core";

const EBAY_API = "https://api.ebay.com";
const BROWSE_SCOPE = "https://api.ebay.com/oauth/api_scope";

export interface EbayItemSummary {
  itemId: string;
  title: string;
  price?: { value: string; currency: string };
  currentBidPrice?: { value: string; currency: string };
  bidCount?: number;
  buyingOptions?: string[];
  condition?: string;
  itemWebUrl: string;
  image?: { imageUrl: string };
  additionalImages?: Array<{ imageUrl: string }>;
  itemEndDate?: string;
  itemCreationDate?: string;
  itemLocation?: { city?: string; stateOrProvince?: string; postalCode?: string; country?: string };
  categories?: Array<{ categoryId: string; categoryName?: string }>;
  epid?: string;
  shippingOptions?: Array<{ shippingCost?: { value: string } }>;
}

interface BrowseSearchResponse {
  total?: number;
  itemSummaries?: EbayItemSummary[];
}

export interface SoldCompRecord {
  lastSoldPrice?: { value: string; currency: string };
  lastSoldDate?: string;
  title?: string;
}

interface InsightsResponse {
  total?: number;
  itemSales?: SoldCompRecord[];
}

export class EbayAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EbayAccessError";
  }
}

export interface EbayClientOptions {
  clientId: string | undefined;
  clientSecret: string | undefined;
  marketplaceId: string;
  bucket: TokenBucket;
  log: Logger;
}

export class EbayClient {
  private token: { value: string; expiresAt: number } | null = null;
  private insightsUnavailable = false;

  constructor(private readonly opts: EbayClientOptions) {}

  isConfigured(): boolean {
    return Boolean(this.opts.clientId && this.opts.clientSecret);
  }

  private async getToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    if (!this.isConfigured()) {
      throw new EbayAccessError("EBAY_CLIENT_ID / EBAY_CLIENT_SECRET are not set");
    }
    await this.opts.bucket.take(1);
    const basic = Buffer.from(`${this.opts.clientId}:${this.opts.clientSecret}`).toString("base64");
    const res = await fetch(`${EBAY_API}/identity/v1/oauth2/token`, {
      method: "POST",
      headers: {
        authorization: `Basic ${basic}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_type: "client_credentials", scope: BROWSE_SCOPE }).toString(),
      signal: AbortSignal.timeout(20_000),
    });
    const body = await res.text();
    if (!res.ok) {
      throw new HttpStatusError(`${EBAY_API}/identity/v1/oauth2/token`, res.status, null, body);
    }
    const json = JSON.parse(body) as { access_token: string; expires_in: number };
    this.token = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
    this.opts.log.info({ event: "ebay_token_refreshed", expiresInSec: json.expires_in }, "eBay OAuth token acquired");
    return this.token.value;
  }

  private async apiGet<T>(path: string, params: URLSearchParams): Promise<T> {
    const token = await this.getToken();
    const waitedMs = await this.opts.bucket.take(1);
    const url = `${EBAY_API}${path}?${params.toString()}`;
    const startedAt = Date.now();
    const res = await fetch(url, {
      headers: {
        authorization: `Bearer ${token}`,
        "x-ebay-c-marketplace-id": this.opts.marketplaceId,
        accept: "application/json",
      },
      signal: AbortSignal.timeout(25_000),
    });
    const text = await res.text();
    this.opts.log.info(
      {
        event: "http_request",
        source: "ebay",
        host: "api.ebay.com",
        path,
        status: res.status,
        durationMs: Date.now() - startedAt,
        throttledMs: waitedMs,
      },
      "http request",
    );
    if (res.status === 403) throw new EbayAccessError(`403 for ${path}: ${text.slice(0, 200)}`);
    if (!res.ok) {
      const retryAfter = res.headers.get("retry-after");
      throw new HttpStatusError(url, res.status, retryAfter ? Number(retryAfter) * 1000 : null, text);
    }
    return JSON.parse(text) as T;
  }

  async searchItems(input: {
    q?: string;
    categoryIds?: string[];
    filters?: string[];
    sort?: string;
    limit?: number;
  }): Promise<{ total: number; items: EbayItemSummary[] }> {
    const params = new URLSearchParams();
    if (input.q) params.set("q", input.q);
    if (input.categoryIds && input.categoryIds.length > 0) {
      params.set("category_ids", input.categoryIds.join(","));
    }
    if (input.filters && input.filters.length > 0) params.set("filter", input.filters.join(","));
    if (input.sort) params.set("sort", input.sort);
    params.set("limit", String(input.limit ?? 50));

    const res = await this.apiGet<BrowseSearchResponse>("/buy/browse/v1/item_summary/search", params);
    return { total: res.total ?? 0, items: res.itemSummaries ?? [] };
  }

  /** Count of live listings matching a query (used for sell-through). */
  async countActive(input: { q?: string; gtin?: string }): Promise<number> {
    const params = new URLSearchParams();
    if (input.gtin) params.set("gtin", input.gtin);
    else if (input.q) params.set("q", input.q);
    params.set("limit", "1");
    const res = await this.apiGet<BrowseSearchResponse>("/buy/browse/v1/item_summary/search", params);
    return res.total ?? 0;
  }

  /**
   * Sold/completed comps via the Marketplace Insights API. Requires the
   * (application-gated) marketplace.insights scope; a 403 marks the API
   * unavailable for this process and surfaces as EbayAccessError.
   */
  async searchSoldComps(input: {
    q?: string;
    gtin?: string;
    categoryIds?: string[];
    daysBack: number;
    limit?: number;
  }): Promise<{ total: number; prices: number[] }> {
    if (this.insightsUnavailable) {
      throw new EbayAccessError("Marketplace Insights previously returned 403 — skipping until restart");
    }
    const params = new URLSearchParams();
    if (input.gtin) params.set("gtin", input.gtin);
    else if (input.q) params.set("q", input.q);
    if (input.categoryIds && input.categoryIds.length > 0) {
      params.set("category_ids", input.categoryIds.join(","));
    }
    const since = new Date(Date.now() - input.daysBack * 24 * 3600 * 1000).toISOString();
    params.set("filter", `lastSoldDate:[${since}..]`);
    params.set("limit", String(input.limit ?? 100));

    try {
      const res = await this.apiGet<InsightsResponse>(
        "/buy/marketplace_insights/v1_beta/item_sales/search",
        params,
      );
      const prices = (res.itemSales ?? [])
        .map((sale) => Number(sale.lastSoldPrice?.value))
        .filter((v) => Number.isFinite(v) && v > 0);
      return { total: res.total ?? prices.length, prices };
    } catch (err) {
      if (err instanceof EbayAccessError) {
        this.insightsUnavailable = true;
        this.opts.log.warn(
          { event: "ebay_insights_unavailable" },
          "Marketplace Insights API not authorized for this app — sold comps disabled (request access in eBay dev portal)",
        );
      }
      throw err;
    }
  }
}

export function summaryPrice(item: EbayItemSummary): number | null {
  const bid = Number(item.currentBidPrice?.value);
  if (Number.isFinite(bid) && bid > 0) return bid;
  const price = Number(item.price?.value);
  if (Number.isFinite(price) && price > 0) return price;
  return null;
}

export function summaryLocation(item: EbayItemSummary): string | null {
  const loc = item.itemLocation;
  if (!loc) return null;
  const parts = [loc.city, loc.stateOrProvince].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : null;
}

/**
 * Walmart plugin — uses the official Walmart affiliate/IO API, which signs
 * requests with an RSA key pair (set WALMART_CONSUMER_ID / WALMART_PRIVATE_KEY
 * / WALMART_KEY_VERSION from developer.walmart.com). Without credentials the
 * plugin reports itself unconfigured and the sweep skips it — Walmart's plain
 * web endpoints sit behind bot protection and their ToS disallows scraping,
 * so the official API is the only source we use.
 */
import { createSign } from "node:crypto";
import type { RetailContext, RetailPlugin, RetailProduct } from "./types.js";

const AFFIL_API = "https://developer.api.walmart.com/api-proxy/service/affil/product/v2";

interface WalmartSearchItem {
  itemId: number;
  name: string;
  salePrice?: number;
  msrp?: number;
  upc?: string;
  brandName?: string;
  categoryPath?: string;
  productTrackingUrl?: string;
  productUrl?: string;
  largeImage?: string;
  clearance?: boolean;
  availableOnline?: boolean;
}

function signatureHeaders(env: NodeJS.ProcessEnv): Record<string, string> | null {
  const consumerId = env.WALMART_CONSUMER_ID;
  const privateKeyPem = env.WALMART_PRIVATE_KEY?.replace(/\\n/g, "\n");
  const keyVersion = env.WALMART_KEY_VERSION ?? "1";
  if (!consumerId || !privateKeyPem) return null;
  const timestamp = Date.now().toString();
  const signer = createSign("RSA-SHA256");
  signer.update(`${consumerId}\n${timestamp}\n${keyVersion}\n`);
  const signature = signer.sign(privateKeyPem, "base64");
  return {
    "WM_CONSUMER.ID": consumerId,
    "WM_CONSUMER.INTIMESTAMP": timestamp,
    "WM_SEC.KEY_VERSION": keyVersion,
    "WM_SEC.AUTH_SIGNATURE": signature,
  };
}

export const walmartPlugin: RetailPlugin = {
  key: "walmart",
  displayName: "Walmart Clearance",
  sourceKey: "walmart_clearance",

  configured(ctx) {
    if (!ctx.env.WALMART_CONSUMER_ID || !ctx.env.WALMART_PRIVATE_KEY) {
      return "WALMART_CONSUMER_ID / WALMART_PRIVATE_KEY not set (official affiliate API credentials required)";
    }
    if (ctx.config.categories.length === 0) return "no Walmart categories configured";
    return true;
  },

  async fetchClearance(ctx) {
    const products: RetailProduct[] = [];
    for (const category of ctx.config.categories) {
      const headers = signatureHeaders(ctx.env);
      if (!headers) break;
      const params = new URLSearchParams({
        query: "clearance",
        categoryId: category.id,
        numItems: "25",
        sort: "price",
        order: "ascending",
      });
      try {
        const res = await ctx.http.request(`${AFFIL_API}/search?${params.toString()}`, {
          headers: { ...headers, accept: "application/json" },
        });
        const json = res.json<{ items?: WalmartSearchItem[] }>();
        for (const item of json.items ?? []) {
          if (!item.salePrice || !item.name) continue;
          products.push({
            externalId: `wmt-${item.itemId}`,
            title: item.name,
            url: item.productUrl ?? item.productTrackingUrl ?? `https://www.walmart.com/ip/${item.itemId}`,
            imageUrls: item.largeImage ? [item.largeImage] : [],
            price: item.salePrice,
            msrp: item.msrp ?? null,
            category: category.name,
            brand: item.brandName ?? null,
            upc: item.upc ?? null,
            raw: item,
          });
        }
      } catch (err) {
        ctx.log.warn(
          { event: "retail_category_failed", plugin: "walmart", category: category.id, err: (err as Error).message },
          "Walmart category fetch failed",
        );
      }
    }
    return products;
  },
};

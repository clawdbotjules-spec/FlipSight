/**
 * Target plugin — uses the public redsky endpoints that power target.com's
 * own category pages (key is the site's public web API key, config-driven so
 * it can be rotated). Sale-price items are fetched per configured category;
 * the sweep filters to clearance-threshold hits. Store-level availability is
 * checked for the configured store IDs near the home ZIP.
 */
import type { RetailContext, RetailPlugin, RetailProduct, StoreAvailability } from "./types.js";

const REDSKY = "https://redsky.target.com";
/** Target's public web storefront key (visible in any target.com session). */
const DEFAULT_WEB_KEY = "9f36aeafbe60771e321a7cc95a78140772ab3e96";

interface RedskyProduct {
  tcin: string;
  item?: {
    product_description?: { title?: string };
    enrichment?: { buy_url?: string; images?: { primary_image_url?: string } };
    primary_brand?: { name?: string };
    product_classification?: { product_type_name?: string };
  };
  price?: {
    current_retail?: number;
    current_retail_min?: number;
    reg_retail?: number;
    reg_retail_max?: number;
    formatted_current_price?: string;
  };
}

interface PlpResponse {
  data?: { search?: { products?: RedskyProduct[] } };
}

function webKey(ctx: RetailContext): string {
  return ctx.config.apiKey ?? ctx.env.TARGET_API_KEY ?? DEFAULT_WEB_KEY;
}

export const targetPlugin: RetailPlugin = {
  key: "target",
  displayName: "Target Clearance",
  sourceKey: "target_clearance",

  configured(ctx) {
    if (ctx.config.categories.length === 0) {
      return "no Target categories configured in Source.config.categories";
    }
    return true;
  },

  async fetchClearance(ctx) {
    const products: RetailProduct[] = [];
    const storeId = ctx.config.storeIds[0] ?? "3991";

    for (const category of ctx.config.categories) {
      const params = new URLSearchParams({
        key: webKey(ctx),
        category: category.id,
        channel: "WEB",
        count: "28",
        offset: "0",
        page: `/c/${category.id}`,
        platform: "desktop",
        pricing_store_id: storeId,
        store_ids: ctx.config.storeIds.join(",") || storeId,
        useragent: "Mozilla/5.0",
        visitor_id: "0000000000000000000000000000",
        zip: ctx.config.homeZip,
        facet_recovery: "false",
        // Deals/sale facet — narrows results to marked-down items.
        faceted_value: "5tdv0",
      });
      const url = `${REDSKY}/redsky_aggregations/v1/web/plp_search_v2?${params.toString()}`;
      try {
        const res = await ctx.http.request(url, {
          headers: { accept: "application/json", origin: "https://www.target.com", referer: "https://www.target.com/" },
        });
        const json = res.json<PlpResponse>();
        for (const p of json.data?.search?.products ?? []) {
          const price = p.price?.current_retail ?? p.price?.current_retail_min;
          const msrp = p.price?.reg_retail ?? p.price?.reg_retail_max ?? null;
          const title = p.item?.product_description?.title;
          if (!price || !title) continue;
          products.push({
            externalId: `tgt-${p.tcin}`,
            title,
            url: p.item?.enrichment?.buy_url ?? `https://www.target.com/p/-/A-${p.tcin}`,
            imageUrls: p.item?.enrichment?.images?.primary_image_url
              ? [p.item.enrichment.images.primary_image_url]
              : [],
            price,
            msrp,
            category: category.name,
            brand: p.item?.primary_brand?.name ?? null,
            upc: null,
            raw: p,
          });
        }
      } catch (err) {
        ctx.log.warn(
          { event: "retail_category_failed", plugin: "target", category: category.id, err: (err as Error).message },
          "Target category fetch failed (bot protection or key rotation are the usual causes)",
        );
      }
    }
    return products;
  },

  async checkStoreInventory(ctx, tcins, storeIds) {
    const result: Record<string, StoreAvailability[]> = {};
    if (tcins.length === 0 || storeIds.length === 0) return result;
    const params = new URLSearchParams({
      key: webKey(ctx),
      tcins: tcins.map((t) => t.replace(/^tgt-/, "")).join(","),
      store_id: storeIds[0]!,
      zip: ctx.config.homeZip,
      state: "",
      latitude: "0",
      longitude: "0",
      radius: "50",
    });
    const url = `${REDSKY}/redsky_aggregations/v1/web/product_summary_with_fulfillment_v1?${params.toString()}`;
    try {
      const res = await ctx.http.request(url, { headers: { accept: "application/json" } });
      const json = res.json<{
        data?: {
          product_summaries?: Array<{
            tcin?: string;
            fulfillment?: {
              store_options?: Array<{
                location_id?: string;
                in_store_only?: { availability_status?: string };
                location_available_to_promise_quantity?: number;
              }>;
            };
          }>;
        };
      }>();
      for (const summary of json.data?.product_summaries ?? []) {
        if (!summary.tcin) continue;
        result[`tgt-${summary.tcin}`] = (summary.fulfillment?.store_options ?? []).map((option) => ({
          storeId: option.location_id ?? "unknown",
          available: option.in_store_only?.availability_status === "IN_STOCK",
          quantity: option.location_available_to_promise_quantity ?? null,
        }));
      }
    } catch (err) {
      ctx.log.warn({ event: "store_inventory_failed", plugin: "target", err: (err as Error).message }, "store inventory check failed");
    }
    return result;
  },
};

/**
 * ShopGoodwill listing client. Uses the public JSON endpoint that powers
 * shopgoodwill.com's own category pages, throttled to the configured
 * ~1 request / 2.5s with jitter, and robots-checked via the shared guard.
 */
import type { HttpClient } from "@flipsight/worker-core";

const SEARCH_URL = "https://buyerapi.shopgoodwill.com/api/Search/ItemListing";

export interface GoodwillItem {
  itemId: number;
  categoryId: number;
  categoryName: string | null;
  title: string;
  currentPrice: number;
  minimumBid: number;
  numBids: number;
  startTime: string;
  /** Naive Pacific-time timestamp, e.g. "2026-08-09T10:58:00". */
  endTime: string;
  buyNowPrice: number;
  imageURL: string | null;
  shippingPrice: number;
}

interface SearchResponse {
  searchResults?: { items?: GoodwillItem[]; itemCount?: number };
}

export function goodwillSearchBody(input: { catId: number; page: number; pageSize: number }): string {
  return JSON.stringify({
    // The load-bearing category filter (matches the site's own payload model).
    selectedCategoryIds: String(input.catId),
    selectedGroup: "",
    selectedSellerIds: "",
    catIds: String(input.catId),
    categoryId: input.catId,
    categoryLevel: 1,
    categoryLevelNo: "1",
    partNumber: "",
    catFullName: "",
    categoryChildId: null,
    searchText: "",
    lowPrice: "0",
    highPrice: "999999",
    searchBuyNowOnly: "",
    searchPickupOnly: "false",
    searchNoPickupOnly: "false",
    searchOneCentShippingOnly: "false",
    searchDescriptions: "false",
    searchClosedAuctions: "false",
    closedAuctionEndingDate: "1/1/2024",
    closedAuctionDaysBack: "7",
    isFromHeaderMenuTab: false,
    layout: "",
    isFromHomePage: false,
    searchCanadaShipping: "false",
    searchInternationalShippingOnly: "false",
    sortColumn: "1",
    page: String(input.page),
    pageSize: String(input.pageSize),
    sortDescending: "false",
    savedSearchId: 0,
    useBuyerPrefs: "true",
    searchUSOnlyShipping: "false",
    categoryLevel1: "",
  });
}

export async function searchCategory(
  http: HttpClient,
  input: { catId: number; page: number; pageSize: number },
): Promise<{ items: GoodwillItem[]; itemCount: number }> {
  const result = await http.request(SEARCH_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: goodwillSearchBody(input),
  });
  const json = result.json<SearchResponse>();
  return {
    items: json.searchResults?.items ?? [],
    itemCount: json.searchResults?.itemCount ?? 0,
  };
}

/**
 * ShopGoodwill timestamps are naive Pacific wall-clock times. Convert to a
 * real UTC Date using Intl (handles PST/PDT transitions without a tz lib).
 */
export function pacificToUtc(naiveIso: string): Date | null {
  if (!naiveIso) return null;
  const asUtc = new Date(`${naiveIso}Z`);
  if (Number.isNaN(asUtc.getTime())) return null;
  const offsetMin = timeZoneOffsetMinutes("America/Los_Angeles", asUtc);
  // Wall-clock interpreted as UTC minus the (negative) offset → true UTC.
  return new Date(asUtc.getTime() - offsetMin * 60_000);
}

function timeZoneOffsetMinutes(timeZone: string, at: Date): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(formatter.formatToParts(at).map((p) => [p.type, p.value]));
  const zoned = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour === "24" ? "00" : parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return Math.round((zoned - at.getTime()) / 60_000);
}

export function itemUrl(itemId: number): string {
  return `https://shopgoodwill.com/item/${itemId}`;
}

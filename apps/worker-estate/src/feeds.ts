/**
 * Estate-sale feed readers: EstateSales.net public area pages (robots-allowed
 * server-rendered HTML) and generic RSS feeds (HiBid zip searches, etc.).
 * Parsing is deliberately tolerant — these are lead generators, not APIs.
 */
import { XMLParser } from "fast-xml-parser";
import type { HttpClient } from "@flipsight/worker-core";

export interface SaleLead {
  externalId: string;
  url: string;
  title: string | null;
  source: "estatesales" | "rss";
}

export interface SaleDetail {
  title: string;
  description: string;
  imageUrls: string[];
}

/** List sale links from an estatesales.net area page: /{ST}/{City}/{zip}. */
export async function fetchEstateSalesLeads(
  http: HttpClient,
  input: { state: string; city: string; zip: string },
): Promise<SaleLead[]> {
  const url = `https://www.estatesales.net/${input.state}/${input.city}/${input.zip}`;
  const res = await http.request(url, { cacheKey: `esn:${input.state}:${input.city}:${input.zip}` });
  if (res.notModified) return [];

  const leads = new Map<string, SaleLead>();
  const linkRe = /href="(\/[A-Z]{2}\/[A-Za-z-]+\/\d{5}\/(\d+))"/g;
  for (const match of res.text.matchAll(linkRe)) {
    const [, path, saleId] = match;
    if (!leads.has(saleId!)) {
      leads.set(saleId!, {
        externalId: `esn-${saleId}`,
        url: `https://www.estatesales.net${path}`,
        title: null,
        source: "estatesales",
      });
    }
  }
  return [...leads.values()];
}

/** Parse any RSS/Atom feed into leads (HiBid exposes zip-radius RSS feeds). */
export async function fetchRssLeads(http: HttpClient, feedUrl: string): Promise<SaleLead[]> {
  const res = await http.request(feedUrl, { cacheKey: `rss:${feedUrl}` });
  if (res.notModified) return [];

  const parser = new XMLParser({ ignoreAttributes: false });
  const doc = parser.parse(res.text) as {
    rss?: { channel?: { item?: unknown } };
    feed?: { entry?: unknown };
  };
  const rawItems = doc.rss?.channel?.item ?? doc.feed?.entry ?? [];
  const items = Array.isArray(rawItems) ? rawItems : [rawItems];

  const leads: SaleLead[] = [];
  for (const raw of items) {
    const entry = raw as { title?: unknown; link?: unknown; guid?: unknown };
    const title = textOf(entry.title);
    const link =
      textOf(entry.link) ??
      (entry.link as { "@_href"?: string } | undefined)?.["@_href"] ??
      null;
    if (!link) continue;
    const guid = textOf(entry.guid) ?? link;
    leads.push({
      externalId: `rss-${hashString(guid)}`,
      url: link,
      title,
      source: "rss",
    });
  }
  return leads;
}

/** Fetch a sale page and reduce it to AI-ready text + image URLs. */
export async function fetchSaleDetail(http: HttpClient, url: string): Promise<SaleDetail> {
  const res = await http.request(url);
  const html = res.text;

  const title =
    firstMatch(html, /<meta property="og:title" content="([^"]+)"/) ??
    firstMatch(html, /<title>([^<]+)<\/title>/) ??
    url;

  const metaDescription = firstMatch(html, /<meta (?:property="og:description"|name="description") content="([^"]+)"/);
  const bodyText = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&amp;|&#\d+;|&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  const imageUrls = new Set<string>();
  const ogImage = firstMatch(html, /<meta property="og:image" content="([^"]+)"/);
  if (ogImage) imageUrls.add(ogImage);
  for (const match of html.matchAll(/<img[^>]+src="(https:\/\/[^"]+\.(?:jpe?g|png|webp)[^"]*)"/gi)) {
    if (imageUrls.size >= 6) break;
    imageUrls.add(match[1]!);
  }

  return {
    title: decodeEntities(title).trim(),
    description: [metaDescription ? decodeEntities(metaDescription) : null, bodyText.slice(0, 8000)]
      .filter(Boolean)
      .join("\n\n"),
    imageUrls: [...imageUrls],
  };
}

function textOf(value: unknown): string | null {
  if (typeof value === "string") return value.trim();
  if (value && typeof value === "object" && "#text" in value) {
    const text = (value as { "#text"?: unknown })["#text"];
    return typeof text === "string" ? text.trim() : null;
  }
  return null;
}

function firstMatch(text: string, re: RegExp): string | null {
  const match = text.match(re);
  return match ? match[1]! : null;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function hashString(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

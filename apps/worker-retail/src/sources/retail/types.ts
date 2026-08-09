/**
 * Retail plugin contract — adding a retailer means one new file implementing
 * `RetailPlugin` plus a registry entry in `./index.ts`.
 */
import type { RetailSourceConfig, SourceKeyName } from "@flipsight/shared";
import type { CheckpointStore, HttpClient, Logger } from "@flipsight/worker-core";

export interface RetailContext {
  http: HttpClient;
  log: Logger;
  config: RetailSourceConfig;
  checkpoints: CheckpointStore;
  env: NodeJS.ProcessEnv;
}

export interface StoreAvailability {
  storeId: string;
  available: boolean;
  quantity: number | null;
}

export interface RetailProduct {
  externalId: string;
  title: string;
  url: string;
  imageUrls: string[];
  /** Current (clearance) price. */
  price: number;
  /** MSRP / regular list price, when the retailer exposes it. */
  msrp: number | null;
  category: string | null;
  brand: string | null;
  upc: string | null;
  storeAvailability?: StoreAvailability[];
  raw: unknown;
}

export interface RetailPlugin {
  key: string;
  displayName: string;
  /** Which Source row this retailer's items land under. */
  sourceKey: SourceKeyName;
  /** True when usable, otherwise a human-readable reason it is disabled. */
  configured(ctx: RetailContext): true | string;
  /** Fetch current clearance candidates (pre-filter; the sweep applies the MSRP threshold). */
  fetchClearance(ctx: RetailContext): Promise<RetailProduct[]>;
  /** Optional per-store inventory check for a set of product ids. */
  checkStoreInventory?(
    ctx: RetailContext,
    productIds: string[],
    storeIds: string[],
  ): Promise<Record<string, StoreAvailability[]>>;
}

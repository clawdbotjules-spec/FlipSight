import type { RetailPlugin } from "./types.js";
import { targetPlugin } from "./target.js";
import { walmartPlugin } from "./walmart.js";

/** Add a retailer: create `./<name>.ts` implementing RetailPlugin, list it here. */
export const RETAIL_PLUGINS: RetailPlugin[] = [targetPlugin, walmartPlugin];

export * from "./types.js";

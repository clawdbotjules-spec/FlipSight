/**
 * Read app-level settings (AppSetting table) with schema-validated parsing
 * and a short in-process cache, so workers see UI edits within a minute
 * without hammering Postgres.
 */
import type { PrismaClient } from "@flipsight/db";
import type { z } from "zod";

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { value: unknown; expiresAt: number }>();

export async function getAppSetting<S extends z.ZodTypeAny>(
  prisma: PrismaClient,
  key: string,
  schema: S,
): Promise<z.infer<S>> {
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value as z.infer<S>;

  const row = await prisma.appSetting.findUnique({ where: { key } });
  const parsed = schema.safeParse(row?.value ?? {});
  const value = parsed.success ? parsed.data : schema.parse({});
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

/** Test/diagnostic helper. */
export function clearAppSettingCache(): void {
  cache.clear();
}

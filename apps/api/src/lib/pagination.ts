/**
 * Opaque cursor for keyset pagination over (createdAt DESC, id DESC).
 * Encodes `<epochMillis>:<id>` as base64url.
 */

export interface DecodedCursor {
  ts: number;
  id: string;
}

export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.getTime()}:${id}`, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): DecodedCursor | null {
  let raw: string;
  try {
    raw = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const sep = raw.indexOf(":");
  if (sep === -1) return null;
  const ts = Number(raw.slice(0, sep));
  const id = raw.slice(sep + 1);
  if (!Number.isFinite(ts) || id === "") return null;
  return { ts, id };
}

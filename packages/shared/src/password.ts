/**
 * Password hashing with Node's built-in scrypt — no native-module build
 * headaches in containers, parameters stored alongside the hash so they can
 * be raised later without invalidating existing credentials.
 *
 * Stored format: scrypt$N$r$p$<salt b64url>$<hash b64url>
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;
// 128 * N * r bytes is the scrypt memory requirement; give headroom above it.
const MAXMEM = 128 * N * R * 2;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return ["scrypt", N, R, P, salt.toString("base64url"), derived.toString("base64url")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
  const n = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  const salt = Buffer.from(saltB64, "base64url");
  const expected = Buffer.from(hashB64, "base64url");
  const derived = await scrypt(password, salt, expected.length, {
    N: n,
    r,
    p,
    maxmem: 128 * n * r * 2,
  });
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/**
 * A throwaway hash used to equalize timing on login when the email doesn't
 * exist (avoids a user-enumeration timing oracle).
 */
export const DUMMY_PASSWORD_HASH =
  "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$Tt9M9UKvRQGDNsGKajlDbDBvJPGRrl7Rk2C3uzr0dmC0jgAAV5C0mLEyIfPB2lzUqIVUvxKGnvLINQhToMNW1g";

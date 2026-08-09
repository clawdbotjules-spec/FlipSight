/**
 * Minimal .env loader (no dependency on dotenv). Looks for a .env file in the
 * given candidate paths (defaults: cwd, then two levels up — covering both
 * repo-root scripts and workspace-cwd scripts) and applies KEY=VALUE lines
 * that aren't already set in process.env. Containers get their env from
 * docker-compose, where this is a silent no-op.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export function loadEnvFile(candidates?: string[]): string | null {
  const paths = candidates ?? [
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "..", "..", ".env"),
  ];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    const content = readFileSync(path, "utf8");
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line === "" || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (key !== "" && !(key in process.env)) {
        process.env[key] = value;
      }
    }
    return path;
  }
  return null;
}

/**
 * Watchdog — the smallest possible external observer. Pings every service's
 * /health on an interval; when a target has been unreachable for longer than
 * WATCHDOG_DOWN_AFTER_SEC (default 120 s) it posts one Discord alert, and one
 * recovery notice when the target comes back. No DB, no Redis — if the whole
 * stack burns down, this still runs and still tells you.
 *
 * Targets come from WATCHDOG_TARGETS ("name=url,name=url"); the default list
 * matches docker-compose service names.
 */
import { createServer } from "node:http";
import { pino } from "pino";

const log = pino({ name: "watchdog", level: process.env.LOG_LEVEL ?? "info" });

const INTERVAL_SEC = Number(process.env.WATCHDOG_INTERVAL_SEC ?? 30);
const DOWN_AFTER_SEC = Number(process.env.WATCHDOG_DOWN_AFTER_SEC ?? 120);
const TIMEOUT_MS = Number(process.env.WATCHDOG_TIMEOUT_MS ?? 5_000);
const HEALTH_PORT = Number(process.env.HEALTH_PORT ?? 8080);
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL ?? "";

const DEFAULT_TARGETS =
  "api=http://api:4000/health," +
  "web=http://web:3000/login," +
  "worker-ebay=http://worker-ebay:8080/health," +
  "worker-keepa=http://worker-keepa:8080/health," +
  "worker-goodwill=http://worker-goodwill:8080/health," +
  "worker-retail=http://worker-retail:8080/health," +
  "worker-estate=http://worker-estate:8080/health," +
  "worker-valuate=http://worker-valuate:8080/health";

interface Target {
  name: string;
  url: string;
}

interface TargetState {
  up: boolean;
  downSince: number | null;
  alerted: boolean;
  lastError: string | null;
  lastCheckedAt: number;
}

const targets: Target[] = (process.env.WATCHDOG_TARGETS ?? DEFAULT_TARGETS)
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => {
    const eq = entry.indexOf("=");
    return { name: entry.slice(0, eq), url: entry.slice(eq + 1) };
  });

const states = new Map<string, TargetState>(
  targets.map((t) => [t.name, { up: true, downSince: null, alerted: false, lastError: null, lastCheckedAt: 0 }]),
);

if (!WEBHOOK) {
  log.warn("DISCORD_WEBHOOK_URL not set — outages will only be logged, not alerted");
}

function fmtDuration(ms: number): string {
  const min = Math.floor(ms / 60_000);
  const sec = Math.floor((ms % 60_000) / 1000);
  return min > 0 ? `${min}m ${sec}s` : `${sec}s`;
}

async function postDiscord(title: string, description: string, color: number): Promise<void> {
  if (!WEBHOOK) return;
  try {
    const res = await fetch(WEBHOOK, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "FlipSight Watchdog",
        embeds: [{ title, description, color, timestamp: new Date().toISOString() }],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) log.warn({ status: res.status }, "discord webhook rejected the alert");
  } catch (err) {
    log.warn({ err: (err as Error).message }, "failed to post discord alert");
  }
}

async function checkTarget(target: Target): Promise<void> {
  const state = states.get(target.name)!;
  state.lastCheckedAt = Date.now();
  let ok = false;
  let error: string | null = null;
  try {
    const res = await fetch(target.url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    ok = res.ok;
    if (!ok) error = `HTTP ${res.status}`;
  } catch (err) {
    error = (err as Error).message;
  }

  if (ok) {
    if (state.alerted && state.downSince) {
      const downFor = fmtDuration(Date.now() - state.downSince);
      log.info({ event: "target_recovered", target: target.name, downFor }, "target recovered");
      await postDiscord(
        `🟢 ${target.name} recovered`,
        `Back up after **${downFor}** of downtime.\n\`${target.url}\``,
        0x2ecc71,
      );
    }
    state.up = true;
    state.downSince = null;
    state.alerted = false;
    state.lastError = null;
    return;
  }

  state.up = false;
  state.lastError = error;
  state.downSince ??= Date.now();
  const downMs = Date.now() - state.downSince;
  log.warn({ event: "target_down", target: target.name, downForSec: Math.round(downMs / 1000), error }, "target unreachable");

  if (!state.alerted && downMs >= DOWN_AFTER_SEC * 1000) {
    state.alerted = true;
    log.error({ event: "target_alert", target: target.name }, "outage threshold crossed — alerting");
    await postDiscord(
      `🔴 ${target.name} is DOWN`,
      `Unreachable for **${fmtDuration(downMs)}** (threshold ${DOWN_AFTER_SEC}s).\n\`${target.url}\`\nLast error: ${error}`,
      0xe74c3c,
    );
  }
}

async function tick(): Promise<void> {
  await Promise.allSettled(targets.map(checkTarget));
}

// The watchdog's own /health — reports every target's state so `docker ps`
// and the status page can see through its eyes.
const server = createServer((req, res) => {
  if (req.url === "/health") {
    const body = {
      status: "ok",
      service: "watchdog",
      intervalSec: INTERVAL_SEC,
      downAfterSec: DOWN_AFTER_SEC,
      discordConfigured: Boolean(WEBHOOK),
      targets: Object.fromEntries(
        [...states.entries()].map(([name, s]) => [
          name,
          {
            up: s.up,
            downForSec: s.downSince ? Math.round((Date.now() - s.downSince) / 1000) : 0,
            alerted: s.alerted,
            lastError: s.lastError,
          },
        ]),
      ),
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
    return;
  }
  res.writeHead(404);
  res.end();
});
server.listen(HEALTH_PORT, () => log.info({ port: HEALTH_PORT, targets: targets.length }, "watchdog up"));

const interval = setInterval(() => void tick(), INTERVAL_SEC * 1000);
void tick();

function shutdown(signal: string): void {
  log.info({ signal }, "watchdog shutting down");
  clearInterval(interval);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3_000).unref();
}
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));

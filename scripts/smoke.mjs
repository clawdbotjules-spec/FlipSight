#!/usr/bin/env node
/**
 * End-to-end acceptance test for Phase 1. Against a running stack
 * (`docker compose up` or local dev), this script:
 *
 *   1. waits for GET /health to report ok
 *   2. registers a fresh user (falls back to login if it exists)
 *   3. creates an alert rule via the API
 *   4. opens a native WebSocket with the JWT
 *   5. injects a deal via the seed script (same path a worker uses)
 *   6. asserts the deal arrives over the WebSocket in < 1000 ms
 *   7. verifies the deal shows up in GET /deals and can be claimed
 *
 * Usage:  npm install && npm run build   (once)
 *         npm run smoke
 * Env:    API_URL (default http://localhost:4000)
 */
import { spawn } from "node:child_process";
import process from "node:process";
import WebSocket from "ws";

const API_URL = process.env.API_URL ?? "http://localhost:4000";
const WS_URL = API_URL.replace(/^http/, "ws");
const HEALTH_TIMEOUT_MS = 90_000;
const DEAL_TIMEOUT_MS = 15_000;
const MAX_ALERT_LATENCY_MS = 1_000;

const log = (msg) => console.log(`[smoke] ${msg}`);
const fail = (msg) => {
  console.error(`[smoke] FAIL: ${msg}`);
  process.exit(1);
};

async function api(path, { method = "GET", token, body } = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  const text = await res.text();
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
  }
  return { status: res.status, json };
}

async function waitForHealth() {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const { status, json } = await api("/health");
      if (status === 200 && json?.status === "ok") return json;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  fail(`API did not become healthy within ${HEALTH_TIMEOUT_MS / 1000}s at ${API_URL}`);
}

function runSeedDeal() {
  return new Promise((resolve, reject) => {
    const child = spawn("npm", ["run", "--silent", "seed:deal"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("exit", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`seed:deal exited ${code}:\n${out}`)),
    );
    child.on("error", reject);
  });
}

async function main() {
  log(`waiting for API at ${API_URL} ...`);
  await waitForHealth();
  log("health check ok (db + redis up)");

  // -- register / login ------------------------------------------------------
  const email = `smoke-${Date.now()}@flipsight.dev`;
  const password = "smoke-test-password-1";
  let token;
  const reg = await api("/auth/register", {
    method: "POST",
    body: { email, password, orgName: "Smoke Test Org" },
  });
  if (reg.status === 201) {
    token = reg.json.token;
    log(`registered ${email}`);
  } else if (reg.status === 409) {
    const login = await api("/auth/login", { method: "POST", body: { email, password } });
    if (login.status !== 200) fail(`login failed: ${login.status} ${JSON.stringify(login.json)}`);
    token = login.json.token;
    log(`logged in as existing ${email}`);
  } else {
    fail(`register failed: ${reg.status} ${JSON.stringify(reg.json)}`);
  }

  const me = await api("/auth/me", { token });
  if (me.status !== 200) fail(`GET /auth/me failed: ${me.status}`);
  log(`authenticated as ${me.json.user.email} (org: ${me.json.org.name})`);

  // -- create an alert rule --------------------------------------------------
  const ruleRes = await api("/rules", {
    method: "POST",
    token,
    body: { name: "Smoke: $10+ profit", minProfit: 10, channels: ["websocket"] },
  });
  if (ruleRes.status !== 201) {
    fail(`create rule failed: ${ruleRes.status} ${JSON.stringify(ruleRes.json)}`);
  }
  log(`created alert rule "${ruleRes.json.rule.name}" (${ruleRes.json.rule.id})`);

  // -- open websocket & inject a deal ---------------------------------------
  const ws = new WebSocket(`${WS_URL}/ws?token=${encodeURIComponent(token)}`);
  const received = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no deal.new message within ${DEAL_TIMEOUT_MS / 1000}s`)),
      DEAL_TIMEOUT_MS,
    );
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === "hello") {
        log(`websocket connected (hello for user ${msg.userId})`);
        return;
      }
      if (msg.type === "deal.new") {
        clearTimeout(timer);
        resolve({ msg, receivedAt: Date.now() });
      }
    });
    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });

  log("injecting a deal via seed script ...");
  await runSeedDeal();

  const { msg, receivedAt } = await received.catch((err) => fail(err.message));
  const latency = receivedAt - msg.publishedAt;
  const deal = msg.deal;
  log(`deal.new received: "${deal.item.title}"`);
  log(`  net profit $${deal.netProfit} | ROI ${deal.roiPct}% | score ${deal.score}`);
  log(`  publish -> websocket latency: ${latency}ms`);
  if (latency > MAX_ALERT_LATENCY_MS) {
    fail(`alert latency ${latency}ms exceeds ${MAX_ALERT_LATENCY_MS}ms budget`);
  }
  ws.close();

  // -- feed + claim ----------------------------------------------------------
  const feed = await api(`/deals?limit=5`, { token });
  if (feed.status !== 200) fail(`GET /deals failed: ${feed.status}`);
  const found = feed.json.deals.find((d) => d.id === deal.id);
  if (!found) fail("injected deal not present in GET /deals feed");
  log(`deal present in feed (status: ${found.status})`);

  const claim = await api(`/deals/${deal.id}/claim`, { method: "POST", token });
  if (claim.status !== 200) fail(`claim failed: ${claim.status} ${JSON.stringify(claim.json)}`);
  log(`deal claimed (status: ${claim.json.deal.status})`);

  console.log(`\n[smoke] ACCEPTANCE PASS — alert latency ${latency}ms (budget ${MAX_ALERT_LATENCY_MS}ms)`);
  process.exit(0);
}

main().catch((err) => fail(err.stack ?? String(err)));

#!/usr/bin/env node
/**
 * End-to-end acceptance test for Phases 1 + 3. Against a running stack
 * (`docker compose up` or local dev), this script:
 *
 *   1. waits for GET /health to report ok
 *   2. registers a fresh user (falls back to login if it exists)
 *   3. creates an alert rule via the API
 *   4. opens a native WebSocket with the JWT
 *   5. injects a pre-valued deal via seed:deal (phase-1 realtime path)
 *   6. asserts the deal arrives over the WebSocket in < 1000 ms
 *   7. verifies the deal shows up in GET /deals and can be claimed
 *   8. phase 3: injects a fake underpriced Item via seed:item and waits for
 *      worker-valuate to identify → comp → score → publish a Deal; asserts
 *      the fee/shipping/net-profit math from deal.meta is self-consistent,
 *      the $499 comp outlier was IQR-trimmed, and prints the full breakdown
 *      (requires worker-valuate to be running — skip with SMOKE_PHASE3=0)
 *
 * Usage:  npm install && npm run build   (once)
 *         npm run smoke
 * Env:    API_URL (default http://localhost:4000), SMOKE_PHASE3=0 to skip step 8
 */
import { spawn } from "node:child_process";
import process from "node:process";
import WebSocket from "ws";

const API_URL = process.env.API_URL ?? "http://localhost:4000";
const WS_URL = API_URL.replace(/^http/, "ws");
const HEALTH_TIMEOUT_MS = 90_000;
const DEAL_TIMEOUT_MS = 15_000;
// Phase 3 goes through the real BullMQ pipeline (identify → comps → score),
// so allow queue pickup + a possible Anthropic identify call.
const VALUATE_TIMEOUT_MS = 90_000;
const MAX_ALERT_LATENCY_MS = 1_000;

const log = (msg) => console.log(`[smoke] ${msg}`);
const fail = (msg) => {
  console.error(`[smoke] FAIL: ${msg}`);
  process.exit(1);
};
const round2 = (n) => Math.round(n * 100) / 100;

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

function runSeed(script) {
  return new Promise((resolve, reject) => {
    const child = spawn("npm", ["run", "--silent", script], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("exit", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${script} exited ${code}:\n${out}`)),
    );
    child.on("error", reject);
  });
}

/** Opens a WS and resolves with the first deal.new whose item title matches. */
function awaitDealOverWs(token, titleMatch, timeoutMs) {
  const ws = new WebSocket(`${WS_URL}/ws?token=${encodeURIComponent(token)}`);
  const opened = new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  const received = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no matching deal.new within ${timeoutMs / 1000}s (title ~ "${titleMatch}")`)),
      timeoutMs,
    );
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === "deal.new" && msg.deal.item.title.includes(titleMatch)) {
        clearTimeout(timer);
        resolve({ msg, receivedAt: Date.now() });
      }
    });
    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
  return { ws, opened, received };
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
  await runSeed("seed:deal");

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

  // -- phase 3: valuation engine end-to-end ----------------------------------
  if (process.env.SMOKE_PHASE3 === "0") {
    console.log(`\n[smoke] ACCEPTANCE PASS (phase 1) — alert latency ${latency}ms (budget ${MAX_ALERT_LATENCY_MS}ms)`);
    process.exit(0);
  }

  log("phase 3: seeding a fake underpriced item for the valuation engine ...");
  const watcher = awaitDealOverWs(token, "QuietComfort", VALUATE_TIMEOUT_MS);
  await watcher.opened;
  const seededAt = Date.now();
  await runSeed("seed:item");
  log("item seeded + valuate job enqueued; waiting for worker-valuate ...");

  const p3 = await watcher.received.catch((err) =>
    fail(`${err.message} — is worker-valuate running? (its logs show why items are skipped)`),
  );
  watcher.ws.close();
  const d3 = p3.msg.deal;
  const wsLatency3 = p3.receivedAt - p3.msg.publishedAt;
  const pipelineMs = p3.receivedAt - seededAt;

  log(`valuation deal received: "${d3.item.title}"`);
  log(`  seed -> deal alert: ${(pipelineMs / 1000).toFixed(1)}s end-to-end | publish -> ws: ${wsLatency3}ms`);
  if (wsLatency3 > MAX_ALERT_LATENCY_MS) {
    fail(`phase-3 alert latency ${wsLatency3}ms exceeds ${MAX_ALERT_LATENCY_MS}ms budget`);
  }

  // -- sane math: recompute everything from the payload itself ---------------
  const meta = d3.meta;
  if (!meta?.fees || !meta?.shipping || !meta?.scoreBreakdown || !meta?.comps) {
    fail(`deal.meta missing breakdown sections: ${JSON.stringify(meta)}`);
  }
  const resale = d3.valuation.estimatedResale;
  const expectFees = round2(resale * (meta.fees.pct / 100) + meta.fees.fixed);
  if (d3.estFees !== expectFees) {
    fail(`fee math off: estFees $${d3.estFees} != ${meta.fees.pct}% of $${resale} + $${meta.fees.fixed} = $${expectFees}`);
  }
  if (d3.estShipping !== meta.shipping.cost) {
    fail(`shipping mismatch: estShipping $${d3.estShipping} != resolved $${meta.shipping.cost}`);
  }
  if (meta.shipping.rule !== "category:Electronics") {
    fail(`expected shipping rule category:Electronics for "Consumer Electronics", got "${meta.shipping.rule}"`);
  }
  const expectNet = round2(resale - d3.buyPrice - d3.estFees - d3.estShipping);
  if (d3.netProfit !== expectNet) {
    fail(`net-profit math off: ${d3.netProfit} != ${resale} - ${d3.buyPrice} - ${d3.estFees} - ${d3.estShipping} = ${expectNet}`);
  }
  if (d3.netProfit <= 0) fail(`expected a profitable demo deal, got net $${d3.netProfit}`);
  if (!(d3.score >= 55 && d3.score <= 100)) fail(`score ${d3.score} outside expected [55, 100]`);
  if (!(meta.comps.trimmedOutliers >= 1)) {
    fail(`IQR trim did not drop the seeded $499 outlier (trimmedOutliers=${meta.comps.trimmedOutliers})`);
  }
  if (!meta.riskFlags?.includes("no_returns")) {
    fail(`expected no_returns risk flag, got: ${JSON.stringify(meta.riskFlags)}`);
  }
  const sb = meta.scoreBreakdown;
  const expectScore = Math.round(
    Math.min(100, Math.max(0, sb.profitPts + sb.roiPts + sb.sellThroughPts + sb.compConfidencePts + sb.timePressurePts - sb.riskPenalty)),
  );
  // Components are rounded to 0.1 for display, so allow ±1 on the recomputed sum.
  if (Math.abs(expectScore - d3.score) > 1) {
    fail(`score breakdown inconsistent: parts sum to ${expectScore}, score is ${d3.score}`);
  }

  log("  breakdown (from deal.meta):");
  log(`    identity: "${meta.identity.canonicalName}" via ${meta.identity.method}${meta.identity.demo ? " [demo comps]" : ""}`);
  log(
    `    comps: $${resale} est resale from ${d3.valuation.compSource} (n=${meta.comps.sampleSize} after IQR-trimming ${meta.comps.trimmedOutliers} outlier(s), range $${d3.valuation.resaleLow}-$${d3.valuation.resaleHigh}, sell-through ${d3.valuation.sellThroughRate})`,
  );
  log(`    fees: $${d3.estFees} = ${meta.fees.pct}% + $${meta.fees.fixed} (${meta.fees.matchedCategory ? `category "${meta.fees.matchedCategory}"` : "default schedule"})`);
  log(`    shipping: $${d3.estShipping} (rule: ${meta.shipping.rule})`);
  log(`    net: $${resale} - $${d3.buyPrice} buy - $${d3.estFees} fees - $${d3.estShipping} ship = $${d3.netProfit} (ROI ${d3.roiPct}%)`);
  log(
    `    score ${d3.score}: profit ${sb.profitPts} + roi ${sb.roiPts} + sell-through ${sb.sellThroughPts} + comp-confidence ${sb.compConfidencePts} + time-pressure ${sb.timePressurePts} - risk ${sb.riskPenalty} (${(meta.riskFlags ?? []).join(", ") || "no flags"})`,
  );

  const feed3 = await api(`/deals?limit=10`, { token });
  if (feed3.status !== 200) fail(`GET /deals failed: ${feed3.status}`);
  const found3 = feed3.json.deals.find((d) => d.id === d3.id);
  if (!found3) fail("valuation deal not present in GET /deals feed");
  log(`deal present in feed (status: ${found3.status})`);

  console.log(
    `\n[smoke] ACCEPTANCE PASS — phase 1 alert ${latency}ms; phase 3 pipeline ${(pipelineMs / 1000).toFixed(1)}s, publish->ws ${wsLatency3}ms (budget ${MAX_ALERT_LATENCY_MS}ms)`,
  );
  process.exit(0);
}

main().catch((err) => fail(err.stack ?? String(err)));

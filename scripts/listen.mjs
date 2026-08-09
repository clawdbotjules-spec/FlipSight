#!/usr/bin/env node
/**
 * Live deal watcher — logs in (demo user by default) and streams deal alerts
 * from the WebSocket to your terminal. Run `npm run seed:deal` in another
 * terminal to see one arrive.
 *
 * Env: API_URL (default http://localhost:4000)
 *      FLIPSIGHT_EMAIL / FLIPSIGHT_PASSWORD (default demo@flipsight.dev / flipsight-demo)
 */
import process from "node:process";
import WebSocket from "ws";

const API_URL = process.env.API_URL ?? "http://localhost:4000";
const EMAIL = process.env.FLIPSIGHT_EMAIL ?? "demo@flipsight.dev";
const PASSWORD = process.env.FLIPSIGHT_PASSWORD ?? "flipsight-demo";

const res = await fetch(`${API_URL}/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
if (!res.ok) {
  console.error(`login failed (${res.status}) — did you run \`npm run db:seed\`?`);
  process.exit(1);
}
const { token } = await res.json();
console.log(`logged in as ${EMAIL}, connecting ...`);

const ws = new WebSocket(`${API_URL.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(token)}`);

ws.on("open", () => console.log("connected — waiting for deals (Ctrl+C to exit)"));
ws.on("close", (code) => {
  console.log(`connection closed (${code})`);
  process.exit(0);
});
ws.on("error", (err) => {
  console.error("websocket error:", err.message);
  process.exit(1);
});
ws.on("message", (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === "hello") return;
  if (msg.type === "deal.new") {
    const d = msg.deal;
    const latency = Date.now() - msg.publishedAt;
    console.log(
      `\n⚡ [+${latency}ms] score ${d.score} | $${d.netProfit} profit (${d.roiPct}% ROI)` +
        `\n   ${d.item.title}` +
        `\n   buy $${d.buyPrice} → est. resale $${d.valuation.estimatedResale}` +
        ` (${d.valuation.soldCompsCount} comps) | ${d.item.sourceKey}` +
        `\n   ${d.item.sourceUrl}`,
    );
  }
});

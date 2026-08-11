/**
 * API integration test — boots the real Fastify app against the dev
 * Postgres + Redis (docker compose up -d postgres redis) and walks the
 * core loop over `app.inject` (no sockets): register → auth → rules CRUD +
 * validation → a deal through the feed/claim/dismiss lifecycle → settings
 * round-trip → sources & status.
 *
 * Run:  make test-integration     (or: npm run test:api with infra up)
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

const suffix = `it-${Date.now()}`;
const email = `${suffix}@flipsight.dev`;
const password = "integration-test-pass-1";

let app: FastifyInstance;
let token = "";
let ruleId = "";
let dealId = "";
let itemId = "";

beforeAll(async () => {
  const config = loadConfig({ ...process.env, LOG_LEVEL: "error", NODE_ENV: "test" });
  app = await buildApp(config);
  const health = await app.inject({ method: "GET", url: "/health" });
  if (health.statusCode !== 200) {
    throw new Error(
      "API health check failed — the integration test needs postgres + redis running " +
        "(docker compose up -d postgres redis) and migrations applied (npm run db:deploy).",
    );
  }
}, 30_000);

afterAll(async () => {
  if (!app) return; // boot failed — nothing to clean up
  // Best-effort cleanup of everything this run created.
  try {
    if (dealId) await app.prisma.alertEvent.deleteMany({ where: { dealId } });
    if (dealId) await app.prisma.deal.delete({ where: { id: dealId } }).catch(() => undefined);
    if (itemId) await app.prisma.item.delete({ where: { id: itemId } }).catch(() => undefined);
    await app.prisma.user.deleteMany({ where: { email } }); // cascades rules
    await app.prisma.org.deleteMany({ where: { name: `Org ${suffix}` } });
  } finally {
    await app.close();
  }
});

describe("auth", () => {
  it("registers a new org + user and returns a JWT", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email, password, orgName: `Org ${suffix}` },
    });
    expect(res.statusCode).toBe(201);
    token = res.json().token;
    expect(token).toBeTruthy();
  });

  it("identifies the user on /auth/me", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.email).toBe(email);
  });

  it("rejects a bad token with 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { authorization: "Bearer not-a-real-token" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("alert rules", () => {
  it("creates a rule", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/rules",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: `Rule ${suffix}`, minProfit: 25, channels: ["websocket"] },
    });
    expect(res.statusCode).toBe(201);
    ruleId = res.json().rule.id;
    expect(res.json().rule.minProfit).toBe(25);
  });

  it("rejects invalid rule bodies with 400 VALIDATION", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/rules",
      headers: { authorization: `Bearer ${token}` },
      payload: { minProfit: -5 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION");
  });

  it("previews how many recent deals a rule would match", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/rules/preview",
      headers: { authorization: `Bearer ${token}` },
      payload: { minProfit: 0 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().matched).toBeGreaterThanOrEqual(0);
    expect(res.json().sampled).toBeGreaterThanOrEqual(res.json().matched);
  });

  it("updates and lists the rule", async () => {
    const patch = await app.inject({
      method: "PATCH",
      url: `/rules/${ruleId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { enabled: false },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().rule.enabled).toBe(false);

    const list = await app.inject({
      method: "GET",
      url: "/rules",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list.json().rules.some((r: { id: string }) => r.id === ruleId)).toBe(true);
  });
});

describe("deal lifecycle", () => {
  it("surfaces a deal in the feed and claims it (idempotence guarded)", async () => {
    // Insert a deal the way the valuation engine would, then drive it through
    // the API: feed → detail → claim → double-claim 409 → dismiss.
    const source = await app.prisma.source.findUniqueOrThrow({ where: { key: "ebay" } });
    const item = await app.prisma.item.create({
      data: {
        sourceId: source.id,
        externalId: `integration-${suffix}`,
        title: `Integration Widget ${suffix}`,
        category: "Consumer Electronics",
        sourceUrl: "https://example.com/integration",
        currentPrice: 40,
        imageUrls: [],
      },
    });
    itemId = item.id;
    const valuation = await app.prisma.valuation.create({
      data: {
        itemId: item.id,
        estimatedResale: 120,
        resaleLow: 100,
        resaleHigh: 140,
        soldCompsCount: 12,
        sellThroughRate: 0.7,
        compSource: "ebay_sold",
      },
    });
    const deal = await app.prisma.deal.create({
      data: {
        itemId: item.id,
        valuationId: valuation.id,
        buyPrice: 40,
        estFees: 16.62,
        estShipping: 14.99,
        netProfit: 48.39,
        roiPct: 120.98,
        score: 70,
        meta: { riskFlags: [], fees: { pct: 13.6, fixed: 0.3, matchedCategory: null } },
      },
    });
    dealId = deal.id;

    const feed = await app.inject({
      method: "GET",
      url: `/deals?q=${encodeURIComponent(suffix)}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(feed.statusCode).toBe(200);
    expect(feed.json().deals).toHaveLength(1);
    expect(feed.json().deals[0].netProfit).toBe(48.39);

    const detail = await app.inject({
      method: "GET",
      url: `/deals/${deal.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().deal.meta.fees.pct).toBe(13.6);

    const claim = await app.inject({
      method: "POST",
      url: `/deals/${deal.id}/claim`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(claim.statusCode).toBe(200);
    expect(claim.json().deal.status).toBe("claimed");

    const doubleClaim = await app.inject({
      method: "POST",
      url: `/deals/${deal.id}/claim`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(doubleClaim.statusCode).toBe(409);

    const dismiss = await app.inject({
      method: "POST",
      url: `/deals/${deal.id}/dismiss`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(dismiss.statusCode).toBe(200);
    expect(dismiss.json().deal.status).toBe("dismissed");
  });
});

describe("settings & ops surfaces", () => {
  it("round-trips the fee schedule through PUT /settings/fees", async () => {
    const before = await app.inject({
      method: "GET",
      url: "/settings/fees",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(before.statusCode).toBe(200);
    const schedule = before.json().value ?? before.json();

    const bad = await app.inject({
      method: "PUT",
      url: "/settings/fees",
      headers: { authorization: `Bearer ${token}` },
      payload: { default: { pct: "not-a-number" } },
    });
    expect(bad.statusCode).toBe(400);

    const put = await app.inject({
      method: "PUT",
      url: "/settings/fees",
      headers: { authorization: `Bearer ${token}` },
      payload: schedule.default ? schedule : { default: { pct: 13.6, fixed: 0.3 }, perCategory: {} },
    });
    expect(put.statusCode).toBe(200);
  });

  it("lists sources and system status", async () => {
    const sources = await app.inject({
      method: "GET",
      url: "/sources",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(sources.statusCode).toBe(200);
    expect(sources.json().sources.length).toBe(6);

    const status = await app.inject({
      method: "GET",
      url: "/status/system",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(status.statusCode).toBe(200);
    expect(status.json().status.workers.length).toBe(6);
  });
});

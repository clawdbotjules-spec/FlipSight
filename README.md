# FlipSight

Real-time marketplace arbitrage engine. FlipSight continuously monitors
marketplaces and retailer clearance feeds, values every item against real
sold-price data, and pushes instant alerts when the projected profit after
fees and shipping clears your threshold. Multi-tenant by design so it can
later ship as a subscription deal-alert SaaS.

## Status

**Phase 1 — core data model + API skeleton: complete.**

- [x] Prisma schema: `Org`, `User`, `Source`, `Item`, `Valuation`, `Deal`,
      `AlertRule`, `AlertEvent`, `FlipLedger`
- [x] Fastify API with JWT auth, Zod validation on every route, Redis-backed
      rate limiting
- [x] Alert-rule CRUD, cursor-paginated deal feed (score/category/status/text
      filters), claim/dismiss, flip ledger + P&L summary
- [x] Realtime layer: Redis pub/sub `deals:new` → per-user rule matching →
      native WebSocket push (measured publish→client latency: **2–9 ms**)
- [x] Dockerized stack (`postgres` + `redis` + `api`) with healthchecks,
      `restart: unless-stopped`, and automatic migrations on boot
- [x] End-to-end acceptance test (`npm run smoke`)

Later phases (service slots already reserved in `docker-compose.yml`):
per-source BullMQ workers (`worker-ebay`, `worker-keepa`, `worker-retail`,
`worker-goodwill`, `worker-estate`), Anthropic-powered enrichment (listing
drafting, photo/description classification, estate-sale parsing), the
Next.js web app, Discord/Pushover alert channels, and the `caddy` edge.

## Architecture

```
                     ┌─────────────────────────────────────────────┐
   marketplaces ───▶ │ per-source workers (BullMQ, phase 2+)       │
   & clearance feeds │ poll politely → upsert Item → Valuation →   │
                     │ create Deal → publish deals:new             │
                     └───────────────┬─────────────────────────────┘
                                     │ Redis pub/sub  deals:new
                                     ▼
 ┌──────────┐  SQL   ┌───────────────────────────────┐  WebSocket   ┌────────┐
 │ Postgres │ ◀────▶ │ api (Fastify)                 │ ───────────▶ │ web /  │
 │ 16       │        │ REST + JWT + rate limiting    │  deal.new    │ clients│
 └──────────┘        │ DealFanout: match alert rules │ < 1s budget  └────────┘
                     │ per connected user            │
                     └───────────────────────────────┘
```

Deal producers (workers today, the seed script in phase 1) write to Postgres
and publish the full deal payload on `deals:new`. The API's `DealFanout`
subscribes, matches each deal against the **enabled alert rules of every
connected user** (30 s in-memory cache, invalidated via `rules:changed`),
pushes over plain WebSockets, records `AlertEvent` rows, and flips the deal
`new → alerted`. Heavy work never runs in request handlers.

## Quickstart (Docker)

```bash
cp .env.example .env         # defaults work for local dev; set JWT_SECRET
docker compose up --build -d # postgres + redis + api, migrations run on boot
docker compose ps            # wait for all three to report healthy

# seed sources + demo user (demo@flipsight.dev / flipsight-demo) + default rule
docker compose exec api node packages/db/dist/seed.js

# terminal A — stream deal alerts (needs host node: npm install && npm run build)
npm run listen

# terminal B — inject a deal exactly the way a worker will
docker compose exec api node packages/db/dist/seed-deal.js
```

Terminal A prints the deal within a few milliseconds:

```
⚡ [+9ms] score 68 | $121.75 profit (23.41% ROI)
   LEGO Star Wars 75192 Millennium Falcon UCS — Sealed Box
   buy $520 → est. resale $780 (41 comps) | ebay
   https://www.ebay.com/itm/demo-…
```

## Acceptance test

With the stack up (Docker or local), one command proves the whole loop —
register → login → create rule → WebSocket connect → deal injected → alert
received in under 1 second → deal in feed → claim:

```bash
npm install && npm run build   # once
npm run smoke
# …
# [smoke] ACCEPTANCE PASS — alert latency 9ms (budget 1000ms)
```

## Local development (no Docker for the API)

```bash
cp .env.example .env
docker compose up -d postgres redis   # or point .env at your own instances
npm install
npm run db:generate                   # prisma client
npm run db:migrate                    # apply migrations (dev)
npm run build                         # shared + db + api
npm run db:seed
npm run dev:api                       # tsx watch, pretty logs
```

Useful scripts (repo root):

| Script              | What it does                                        |
| ------------------- | --------------------------------------------------- |
| `npm run build`     | Compile `shared` → `db` → `api`                     |
| `npm test`          | Unit tests (rule matching, deal economics)          |
| `npm run db:migrate`| Create/apply migrations against `DATABASE_URL`      |
| `npm run db:seed`   | Sources + demo user + default alert rule (idempotent) |
| `npm run seed:deal` | Insert a demo deal and publish it on `deals:new`    |
| `npm run listen`    | Log in as demo user and stream alerts to the terminal |
| `npm run smoke`     | End-to-end acceptance test                          |

## API

Base URL `http://localhost:4000`. All routes return JSON; errors are
`{ "error": { "code", "message", "details" } }`. Authenticated routes take
`Authorization: Bearer <token>`. Every route validates input with Zod;
global rate limit 300 req/min (20/min on credential endpoints).

| Method & path              | Auth | Description |
| -------------------------- | ---- | ----------- |
| `GET /health`              | –    | Liveness/readiness: DB + Redis checks, WS connection count |
| `POST /auth/register`      | –    | `{email, password, orgName?}` → creates org + owner user, returns `{token, user}` |
| `POST /auth/login`         | –    | `{email, password}` → `{token, user}` |
| `GET /auth/me`             | ✓    | Current user + org |
| `GET /rules`               | ✓    | List my alert rules |
| `POST /rules`              | ✓    | Create rule: `{name?, minProfit?, minRoi?, maxBuyPrice?, categories[], keywords[], excludeKeywords[], localOnly?, channels[], enabled?}` |
| `GET /rules/:id`           | ✓    | Fetch one rule |
| `PATCH /rules/:id`         | ✓    | Partial update (triggers live cache invalidation) |
| `DELETE /rules/:id`        | ✓    | Delete rule |
| `GET /deals`               | ✓    | Cursor-paginated feed. Query: `limit`, `cursor`, `minScore`, `status`, `category`, `q`. Dismissed deals hidden unless `status=dismissed` |
| `GET /deals/:id`           | ✓    | Deal with item + valuation |
| `POST /deals/:id/claim`    | ✓    | Claim (`new`/`alerted` → `claimed`), 409 otherwise |
| `POST /deals/:id/dismiss`  | ✓    | Dismiss (`new`/`alerted`/`claimed` → `dismissed`) |
| `GET /ledger`              | ✓    | My flips, cursor-paginated; `?sold=true|false` filter |
| `POST /ledger`             | ✓    | Record a purchase `{dealId, purchasePrice, purchasedAt?}` → deal `purchased` |
| `PATCH /ledger/:id`        | ✓    | Record sale `{salePrice?, fees?, shipping?, soldAt?}` → computes `realizedProfit`, deal `sold` |
| `GET /ledger/summary`      | ✓    | P&L totals: spent, revenue, fees, realized profit, avg ROI |

### WebSocket

Connect to `ws://localhost:4000/ws?token=<jwt>` (native `WebSocket`, no
Socket.IO framing). Invalid/missing tokens are closed with code `4401`.

Server messages:

```jsonc
{ "type": "hello", "userId": "…", "serverTime": 1754700000000 }

{
  "type": "deal.new",
  "publishedAt": 1754700000123,        // producer clock — measure your latency
  "matchedRuleIds": ["…"],             // which of your rules fired
  "deal": {
    "id": "…", "status": "new", "buyPrice": 45, "estFees": 16.3,
    "estShipping": 12.99, "netProfit": 45.71, "roiPct": 101.58, "score": 60,
    "item": { "title": "…", "category": "Tools", "sourceKey": "ebay", "sourceUrl": "…", "location": null, "…": "…" },
    "valuation": { "estimatedResale": 120, "resaleLow": 95, "resaleHigh": 140, "soldCompsCount": 27, "sellThroughRate": 0.82, "compSource": "ebay_sold" }
  }
}
```

A deal is delivered to a user when **any** of their enabled rules with the
`websocket` channel matches: `minProfit`, `minRoi`, `maxBuyPrice`,
`categories` (empty = all), `keywords` (any must appear in the title),
`excludeKeywords` (none may appear), `localOnly` (item must have a pickup
location). Matching logic lives in `packages/shared/src/matching.ts` and is
unit-tested — future Discord/Pushover workers reuse the same function.

## Data model

- **Org / User** — every user belongs to an org (multi-tenant from day one);
  registration creates both. JWTs carry `sub`, `orgId`, `role`.
- **Source** — one row per feed (`ebay`, `keepa_amazon`, `shopgoodwill`,
  `walmart_clearance`, `target_clearance`, `estatesales`) with `enabled` and
  per-source worker `config` JSON.
- **Item** — canonical product record per source listing (`sourceId` +
  `externalId` unique), UPC/ISBN/ASIN when known, prices as `Decimal(12,2)`,
  `location` for local-pickup items, raw payload retained.
- **Valuation** — resale estimate (`estimatedResale` / low / high), sold-comps
  count, sell-through rate, comp source (`ebay_sold` | `keepa`).
- **Deal** — buy price, estimated fees/shipping, net profit, ROI %, 0–100
  score, lifecycle `new → alerted → claimed → purchased → sold` (or
  `dismissed`), claimed-by user.
- **AlertRule / AlertEvent** — per-user thresholds + delivery bookkeeping
  (unique per deal × rule × channel).
- **FlipLedger** — actual purchases and sales; powers `GET /ledger/summary`.

## Environment

All variables documented in [`.env.example`](.env.example): `DATABASE_URL`,
`REDIS_URL`, `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, `KEEPA_API_KEY`,
`ANTHROPIC_API_KEY`, `DISCORD_WEBHOOK_URL`, `PUSHOVER_TOKEN`,
`PUSHOVER_USER`, `JWT_SECRET`, `APP_URL` (worker/AI/alert keys are consumed
in later phases). docker-compose substitutes from `.env` and wires container
networking automatically.

## Principles

1. **Always on** — every service is a long-running process with a
   `/health` endpoint, Docker healthcheck, and `restart: unless-stopped`.
   Migrations apply idempotently on boot; SIGTERM shuts down gracefully.
2. **Lag-free** — deal detection → UI alert in <1 s over WebSockets (measured
   single-digit ms in the smoke test). Heavy work happens in workers; API
   handlers stay thin.
3. **Legal sources only** — official APIs and public endpoints; no scraping
   of sites whose ToS prohibits it (no Facebook Marketplace). Workers respect
   robots.txt and rate limits, with randomized delays, caching, and
   conditional requests (per-source config lives in `Source.config`).
4. **Multi-tenant ready** — orgs, users, and per-user alert rules from day
   one, even with a single user today.

## Repository layout

```
apps/api/           Fastify API + WebSocket fan-out (Dockerfile here)
packages/db/        Prisma schema, migrations, seeds, client wrapper
packages/shared/    Cross-service contracts: realtime payloads, rule
                    matching, deal economics, password hashing (unit-tested)
scripts/            smoke.mjs (acceptance), listen.mjs (live deal watcher)
caddy/Caddyfile     Edge config for the later web + HTTPS phase
docker-compose.yml  postgres + redis + api (+ commented slots for phase 2+)
```

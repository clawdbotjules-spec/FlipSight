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
- [x] Dockerized stack with healthchecks, `restart: unless-stopped`, and
      automatic migrations on boot
- [x] End-to-end acceptance test (`npm run smoke`)

**Phase 2 — source workers: complete.**

- [x] `@flipsight/worker-core` framework: BullMQ queues + repeatable
      schedulers (Redis-persisted → sweeps resume after crashes), per-source
      token-bucket rate limiting with `rate_limited`/`throttledMs` log
      evidence, robots.txt guard, conditional-request HTTP client, structured
      pino logging, a global dead-letter queue, `/health` per worker, and
      graceful SIGTERM shutdown
- [x] `worker-ebay` — Browse API sweeps: DB-driven keyword sets expanded with
      **programmatic brand misspellings** (dropped/swapped letters, missing
      spaces), auctions ending ≤30 min with zero/low bids, newly-listed BINs
- [x] `worker-keepa` — ASIN watchlists + best-seller ranges, PriceSnapshot
      history, price-drop (>30% under 90-day avg) and **Amazon pricing
      error** (<40% of 90-day median) detection
- [x] `worker-goodwill` — polite polling of ShopGoodwill categories
      (~1 req/2.5 s + jitter, content-hash caching, robots-aware); extracts
      title / current bid / ends-at / images. **Verified live**: hundreds of
      real items ingested across Electronics/Tools/Cameras/Instruments
- [x] `worker-retail` — plugin system (`sources/retail/walmart.ts`,
      `target.ts`, shared interface): Target via public redsky endpoints
      (**verified live** — real >50%-off clearance detected) with per-store
      inventory near `HOME_ZIP`; Walmart via the official affiliate API when
      credentials are provided
- [x] `worker-estate` — EstateSales.net + RSS feeds around `HOME_ZIP`
      (**verified live**), Anthropic-powered extraction of notable brands /
      categories / worth-attending score (structured outputs), stored as
      `estate_lead` Items
- [x] `/searches` CRUD — every worker's keyword sets / watchlists /
      categories are DB rows editable via the API (validated with the same
      zod schemas the workers parse)

**Phase 3 — valuation + scoring engine, multi-channel alerts, AI listing
assistant: complete.**

- [x] `worker-valuate` — the dedicated `valuate` consumer every source worker
      feeds: **identify** (UPC/ASIN/ISBN → Anthropic title normalization with
      an hourly budget → heuristic fallback) → **comps** (eBay sold median
      over 90 days with **IQR outlier trimming** + Keepa when an ASIN exists,
      cached in Redis 24 h keyed by normalized product name) → **economics**
      (per-category eBay fees, default 13.6% + $0.30, and a weight/category
      shipping lookup table — both editable via `PUT /settings/:key`) →
      **score 0–100** (profit 35 / ROI 25 / sell-through 15 / comp confidence
      15, **time pressure** up to +10 as auctions close, **risk flags** −6
      each: vague title, as-is/untested, parts-only, no returns, stock photo)
- [x] Deals open when score ≥ threshold **and** net profit clears the
      configurable floor; every Deal carries a full `meta` breakdown
      (identity, fee %, shipping rule, score components, comp sample) shown
      in alerts and the API
- [x] **Discord + Pushover delivery** in addition to WebSockets: one rich
      embed / message per deal per channel, `AlertEvent` bookkeeping per
      (deal × rule × channel) with delivery timestamps on 2xx
- [x] `POST /assistant/listing` — photos + a few words → Claude drafts a
      comp-optimized eBay listing (≤80-char title, item specifics, honest
      description) with a suggested price from the comp engine (structured
      JSON via `zodOutputFormat`)
- [x] `AppSetting` config store with zod-validated `GET/PUT /settings/:key`
      (`fees`, `shipping`, `valuation`) — workers re-read within 60 s, no
      restarts
- [x] Unit tests on the fee math, shipping resolution, scoring components,
      risk flags, and IQR trimming (52 tests); acceptance verified live on
      the host **and** in the 9-service Docker stack: seeded underpriced item
      → Deal with sane, self-consistent math in **0.9–1.1 s** end-to-end,
      Discord webhook received the embed, WebSocket pushed in 2 ms

**Phase 4 — the mission-control web UI: complete.**

- [x] `apps/web` — Next.js 15 + Tailwind 4, dark trading-terminal aesthetic:
      near-black base with a faint blueprint grid + film grain, glassmorphic
      panels with 1px cyan→violet gradient edges, one restrained neon palette
      (cyan primary · violet secondary · amber warnings · green profit),
      Geist Mono for every number, Geist Sans for text
- [x] **Live Deal Feed** — WebSocket-driven stream: new deals slide in with a
      glow pulse, animated score rings, buy→resale arrows, live auction
      countdowns (one shared 1 Hz clock), risk-flag chips, Open / Claim /
      Dismiss / Draft-my-listing actions, filter bar (search, source,
      category, min-score slider, local-only) — **window-virtualized so
      1,000+ deals scroll at 60 fps**
- [x] **Deal Detail drawer** — sold-comp distribution histogram + price
      history (Recharts, lazy-loaded so the feed chunk stays lean), the full
      fee/shipping/net economics table, score-anatomy bars, risk flags, and
      the engine's reasoning in plain sentences
- [x] **P&L dashboard** — today/week/month/all-time realized profit with
      ticking counters, cumulative profit area chart, ROI by source and
      category, active inventory with days-held, average days-to-sell
- [x] **Sources & Rules** — per-source enable toggles + live ingest stats,
      keyword/brand-seed editing, zod-validated config JSON, and an alert-rule
      editor with a live preview ("would have matched N deals in the last
      24 h") powered by the exact server-side matcher
- [x] **Listing Assistant** — photo dropzone → Claude-drafted listing with
      80-char title counter, item specifics, honest description, comp-based
      price suggestion, one-click copy buttons
- [x] **System Status** — per-worker cards with 24 h ingest sparklines, queue
      depths, engine throughput, alert delivery counts, dead-letter table
      (5 s polling against a server-cached aggregate)
- [x] Acceptance verified against the full 10-service Docker stack:
      **Lighthouse performance 93–97 / accessibility 100** on the feed,
      seeded deal → rendered card in **2–5 ms** publish→client (measured in
      the UI's own latency badge), mobile layouts with zero horizontal
      overflow, 16/16 Playwright checks green

**Phase 5 — hardening + deploy: complete.**

- [x] Graceful SIGTERM everywhere: BullMQ workers finish in-flight jobs
      (long sweeps yield between pages), force-close inside the compose
      `stop_grace_period` so shutdown never races a SIGKILL; interrupted
      jobs re-run after restart (everything is an idempotent upsert)
- [x] `watchdog` service: pings every `/health` from inside the network,
      posts a Discord alert when anything is down > 2 min and a recovery
      notice when it returns — depends on nothing, so it survives what it
      watches
- [x] Nightly `pg_dump` backups to the mounted `./backups` volume (custom
      format, one on boot + daily at `BACKUP_HOUR_UTC`, pruned after
      `BACKUP_KEEP_DAYS`) + `make backup` / `make restore FILE=…`
- [x] `make deploy` for a single Ubuntu VPS: preflight (refuses placeholder
      secrets), build, start with `--wait`, idempotent seed, status —
      re-run it for every update
- [x] Tests: valuation math / scoring / rule matching / fees / IQR units
      (52) + a 10-case API integration suite (auth, rules CRUD +
      validation + preview, deal feed→claim→409→dismiss, settings
      round-trip, sources, status)
- [x] Verified: kill any container → docker restarts it and the system
      self-heals; docker daemon restart → all services return healthy on
      their own; runbook for everything else (`docs/RUNBOOK.md`)

Phase 6+: the `caddy` HTTPS edge (slot reserved in `docker-compose.yml`).

## Architecture

```
  eBay Browse API ──▶ worker-ebay ────┐        ┌──────────────────────────────┐
  Keepa (Amazon) ──▶ worker-keepa ───┤        │ worker-valuate               │
  ShopGoodwill ────▶ worker-goodwill ─┼──────▶ │ identify (codes→AI→heuristic)│
  Target/Walmart ──▶ worker-retail ───┤ Items  │ → comps (IQR-trimmed eBay    │
  EstateSales/HiBid ▶ worker-estate ──┘  +     │   sold + Keepa, 24h cache)   │
                                      valuate  │ → fees/shipping → score v2   │
                                      jobs     │ → Deal → publish deals:new   │
                                               └──┬───────────┬───────────────┘
                                     Redis pub/sub│           │ Discord webhook
                                                  ▼           ▼ + Pushover
 ┌──────────┐  SQL   ┌───────────────────────────────┐  WebSocket   ┌─────────────┐
 │ Postgres │ ◀────▶ │ api (Fastify)                 │ ───────────▶ │ web         │
 │ 16       │        │ REST + JWT + rate limiting    │  deal.new    │ Next.js 15  │
 └──────────┘        │ DealFanout: match alert rules │ < 1s budget  │ live feed · │
                     │ per connected user            │              │ P&L · rules │
                     │ /settings · /assistant/listing│              │ · assistant │
                     └───────────────────────────────┘              └─────────────┘
```

Each worker is an isolated BullMQ process: repeatable schedules persisted in
Redis (crash → restart → resume), a per-source token bucket (waits are logged
as `rate_limited` events with `throttledMs` on every request — rate-limit
compliance is provable from logs), exponential-backoff retries, and a global
`dead-letter` queue that captures jobs which exhaust their attempts. Source
workers write/update `Item` rows and enqueue `valuate` jobs; `worker-valuate`
identifies the product, prices it against IQR-trimmed sold comps, applies the
configurable fee/shipping tables, scores it (time pressure + risk flags),
records a Valuation for every job, and — when the score and net-profit gates
pass — creates the Deal, publishes `deals:new`, and delivers Discord/Pushover
alerts for matching rules. The API's `DealFanout` subscribes to `deals:new`,
matches each deal against the **enabled alert rules of every connected user**
(30 s cache, invalidated via `rules:changed`), pushes over plain WebSockets,
records `AlertEvent` rows, and flips deals `new → alerted`. Heavy work never
runs in request handlers.

### Politeness & legality

Only official APIs and public endpoints are used. Every scraper-style worker
checks robots.txt per host, paces requests through a token bucket
(ShopGoodwill: ~1 request / 2.5 s + randomized jitter; measured gaps
2.4–2.6 s), sends conditional requests (ETag / Last-Modified) or
content-hash caches to skip unchanged pages, and identifies itself with a
contactable User-Agent. Facebook Marketplace is not touched. One documented
judgment call: `buyerapi.shopgoodwill.com` (the JSON API behind
shopgoodwill.com's own pages) serves a blanket `Disallow: /` aimed at search
indexers; the worker's robots guard treats it as "warn" (fetch politely, log
the conflict loudly) — set `robotsPolicy` to `enforce` in the source config
to hard-disable those fetches instead.

## Quickstart (Docker)

```bash
cp .env.example .env         # defaults work for local dev; set JWT_SECRET
docker compose up --build -d # postgres + redis + api + web + 6 workers, migrations on boot
docker compose ps            # wait for all ten to report healthy
# open http://localhost:3000 — log in as demo@flipsight.dev / flipsight-demo

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
received in under 1 second → deal in feed → claim — then the phase-3 engine:
`seed:item` inserts a fake underpriced item (embedded demo comps including a
$499 outlier), and the script waits for `worker-valuate` to turn it into a
Deal, re-computes the fee/shipping/net-profit math from the payload's own
`meta` breakdown, and asserts the outlier was IQR-trimmed:

```bash
npm install && npm run build   # once
npm run smoke                  # SMOKE_PHASE3=0 to run only the phase-1 part
# …
# [smoke]     fees: $20.77 = 13.6% + $0.3 (default schedule)
# [smoke]     shipping: $14.99 (rule: category:Electronics)
# [smoke]     net: $150.48 - $45 buy - $20.77 fees - $14.99 ship = $69.72 (ROI 154.93%)
# [smoke]     score 61: profit 24.4 + roi 19.4 + sell-through 8.9 + comp-confidence 7.8 + time-pressure 7 - risk 6 (no_returns)
# [smoke] ACCEPTANCE PASS — phase 1 alert 5ms; phase 3 pipeline 0.9s, publish->ws 2ms (budget 1000ms)
```

## Web UI

`http://localhost:3000` — dark-only mission control (log in with the seeded
demo user). Built with Next.js 15, Tailwind 4, native WebSocket, TanStack
Query + Virtual, Recharts (lazy-loaded off the feed path), and Geist.

- **Live Feed** (`/`) — realtime deal stream; the topbar badge shows the live
  publish→client latency of the last alert (measured 2–5 ms). The list is
  window-virtualized; new arrivals prepend with a glow pulse and animated
  score ring. An inline `<head>` script starts the first `/deals` fetch while
  the JS bundles are still downloading.
- **Deal drawer** — click any card: comp histogram, price history, fee &
  shipping breakdown, score anatomy, engine reasoning, claim/dismiss/draft.
- **P&L** (`/pnl`), **Sources & Rules** (`/sources`), **Assistant**
  (`/assistant`), **System** (`/status`).
- Performance: Lighthouse **93–97 performance / 100 accessibility** on the
  authenticated feed (feed route ships ~134 kB gz first-load; charts and the
  drawer live in lazy chunks). Fully responsive — bottom tab bar on mobile.
- `NEXT_PUBLIC_API_URL` is baked at build time (compose passes
  `APP_API_URL`, defaulting to `http://localhost:4000` — the URL the
  *browser* uses to reach the API).

## Deploying to a VPS

One Ubuntu box with Docker is all it takes. From a fresh server:

```bash
# 1. Docker (skip if preinstalled):  https://docs.docker.com/engine/install/ubuntu/
curl -fsSL https://get.docker.com | sudo sh && sudo usermod -aG docker $USER  # re-login after

# 2. Get the code
git clone <your-fork-url> flipsight && cd flipsight

# 3. Configure — make deploy creates .env on first run and stops so you can edit it
make deploy          # -> "Created .env … EDIT IT FIRST"
nano .env            # set JWT_SECRET (openssl rand -hex 32) + any API keys you have
make deploy          # builds, starts all 12 services, waits healthy, seeds
```

That's the whole install. `make deploy` is idempotent — it's also the update
command (`make update` = `git pull` + `make deploy`). Useful afterwards:

```bash
make status      # health of every service
make logs SERVICE=worker-valuate
make smoke       # end-to-end acceptance against the running stack
make backup      # on-demand pg_dump (nightly happens automatically)
make restore FILE=backups/flipsight-20260810-030000.dump
```

Every service restarts itself (`restart: unless-stopped`), so a server
reboot needs no hands — just make sure Docker starts at boot
(`sudo systemctl enable docker`). The stack listens on `:3000` (web) and
`:4000` (api); to serve HTTPS on a domain, uncomment the `caddy` service and
edit `caddy/Caddyfile`. When something misbehaves: [docs/RUNBOOK.md](docs/RUNBOOK.md).

## Getting the API keys

Everything optional degrades gracefully — start with zero keys (ShopGoodwill
and Target work unauthenticated) and add these as you get them:

- **eBay** (live listings + sold comps — the valuation engine's best data):
  create a developer account at [developer.ebay.com](https://developer.ebay.com)
  (free, instant for the standard tier) → *Application Keys* → create a
  **Production** keyset → copy the **App ID (Client ID)** and **Cert ID
  (Client Secret)** into `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET`. The app
  uses the OAuth client-credentials flow — no user consent steps needed.
- **Keepa** (Amazon price history): [keepa.com/#!api](https://keepa.com/#!api),
  buy an API subscription (token-metered), copy the key into
  `KEEPA_API_KEY`.
- **Anthropic** (product identification, estate-sale analysis, listing
  assistant): create a key at
  [console.anthropic.com](https://console.anthropic.com) → `ANTHROPIC_API_KEY`.
- **Discord alerts**: in your server — *Server Settings → Integrations →
  Webhooks → New Webhook*, pick a channel, *Copy Webhook URL* →
  `DISCORD_WEBHOOK_URL`. The watchdog reuses the same webhook for outage
  alerts.
- **Pushover** (phone push): [pushover.net](https://pushover.net) → your
  **User Key** → `PUSHOVER_USER`; *Create an Application* → its token →
  `PUSHOVER_TOKEN`.

## Adding a new source

Two sizes, depending on how much machinery the source needs:

**A retailer with a public product API** → add a plugin to the existing
retail worker. Implement the `RetailPlugin` interface
(`apps/worker-retail/src/sources/retail/types.ts` — `key`, `isConfigured`,
`fetchClearance(ctx)`, optional per-store availability) in a new file next to
`walmart.ts`/`target.ts`, and register it in `RETAIL_PLUGINS`
(`sources/retail/index.ts`). It inherits sweeps, pacing, upserts, and
valuation enqueueing for free.

**A whole new marketplace** → a dedicated worker:

1. **Schema**: add the key to the `SourceKey` enum in
   `packages/db/prisma/schema.prisma` + `SOURCE_KEYS` in
   `packages/shared/src/constants.ts`; `npm run db:migrate`.
2. **Config**: a zod schema for its knobs in
   `packages/shared/src/source-config.ts` (register in
   `SOURCE_CONFIG_SCHEMAS`), and defaults in `packages/db/src/seed.ts`.
3. **Worker**: `apps/worker-<name>/` riding `WorkerApp` from
   `@flipsight/worker-core` — schedule sweeps with `app.scheduleEvery`,
   fetch through `HttpClient` (token bucket + robots.txt + conditional
   requests) or pace an official API with `TokenBucket`, then
   `upsertItem()` + `enqueueValuate()` per listing. Check `app.isClosing`
   between pages so SIGTERM stays graceful. Copy the shape of
   `worker-goodwill` (scraper) or `worker-keepa` (API).
4. **Wire it up**: root `build` script, a service block in
   `docker-compose.yml` (use `docker/worker.Dockerfile`,
   `args: {WORKER: worker-<name>}`), a `COPY` line for its `package.json`
   in the three Dockerfiles, and add it to the watchdog's default targets
   (`apps/watchdog/src/index.ts`).
5. **Respect the rules**: official APIs or public endpoints only, check
   robots.txt, rate-limit with jitter, and never touch sites whose ToS
   forbids automation.

The valuation engine, alerting, UI feed, and P&L need **zero changes** —
anything that lands in `Item` and enqueues `valuate` flows all the way to
Discord on its own.

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
| `npm run build`     | Compile backend workspaces in dependency order      |
| `npm run build -w @flipsight/web` | Production Next.js build (standalone output) |
| `npm run dev -w @flipsight/web` | Web UI dev server on :3000              |
| `npm test`          | Unit tests (rule matching, economics, fees/shipping, scoring, comp stats) |
| `npm run test:api`  | API integration suite (needs postgres+redis up; or `make test-integration`) |
| `npm run db:migrate`| Create/apply migrations against `DATABASE_URL`      |
| `npm run db:seed`   | Sources + demo user + default alert rule + app settings (idempotent) |
| `npm run seed:deal` | Insert a pre-valued demo deal and publish it on `deals:new` |
| `npm run seed:item` | Insert a fake underpriced Item + enqueue a `valuate` job (phase-3 demo) |
| `npm run listen`    | Log in as demo user and stream alerts to the terminal |
| `npm run smoke`     | End-to-end acceptance test (phases 1 + 3)           |

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
| `GET /searches?source=`    | ✓    | Worker saved searches (keyword sets, ASIN watchlists, categories) |
| `POST /searches`           | ✓    | Create `{sourceKey, name, params, enabled?}` — params zod-validated per source |
| `PATCH /searches/:id`      | ✓    | Update name/params/enabled (workers pick changes up next sweep) |
| `DELETE /searches/:id`     | ✓    | Delete a saved search |
| `GET /settings`            | ✓    | Effective valuation config: `fees`, `shipping`, `valuation` (defaults merged in) |
| `GET /settings/:key`       | ✓    | One setting (`fees` \| `shipping` \| `valuation`) |
| `PUT /settings/:key`       | ✓    | Replace a setting — zod-validated against the same schema workers parse; picked up within 60 s, no restarts |
| `POST /assistant/listing`  | ✓    | AI listing draft: `{notes, imageUrls?, imagesBase64?, itemId?}` → `{draft{title ≤80, itemSpecifics, description, condition, …}, pricing{suggested, low, high, basis}}`. 5 req/min; 503 without `ANTHROPIC_API_KEY` |

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
    "valuation": { "estimatedResale": 120, "resaleLow": 95, "resaleHigh": 140, "soldCompsCount": 27, "sellThroughRate": 0.82, "compSource": "ebay_sold" },
    "meta": {                          // present on engine-created deals
      "identity": { "canonicalName": "…", "method": "upc|asin|isbn|ai|heuristic" },
      "fees": { "pct": 13.6, "fixed": 0.3, "matchedCategory": null },
      "shipping": { "cost": 14.99, "rule": "category:Electronics" },
      "riskFlags": ["no_returns"],
      "scoreBreakdown": { "score": 61, "profitPts": 24.4, "roiPts": 19.4, "sellThroughPts": 8.9, "compConfidencePts": 7.8, "timePressurePts": 7, "riskPenalty": 6 },
      "comps": { "source": "ebay_sold", "sampleSize": 12, "trimmedOutliers": 1, "activeCount": 9 }
    }
  }
}
```

A deal is delivered to a user when **any** of their enabled rules with the
`websocket` channel matches: `minProfit`, `minRoi`, `maxBuyPrice`,
`categories` (empty = all), `keywords` (any must appear in the title),
`excludeKeywords` (none may appear), `localOnly` (item must have a pickup
location). Matching logic lives in `packages/shared/src/matching.ts` and is
unit-tested — `worker-valuate`'s Discord/Pushover delivery reuses the same
function against rules carrying those channels (one message per deal per
channel, `AlertEvent` rows per deal × rule × channel).

## Data model

- **Org / User** — every user belongs to an org (multi-tenant from day one);
  registration creates both. JWTs carry `sub`, `orgId`, `role`.
- **Source** — one row per feed (`ebay`, `keepa_amazon`, `shopgoodwill`,
  `walmart_clearance`, `target_clearance`, `estatesales`) with `enabled` and
  per-source worker `config` JSON.
- **AppSetting** — key/value config store for the valuation engine (`fees`,
  `shipping`, `valuation`), zod-validated on write via `PUT /settings/:key`
  and re-read by workers within 60 s.
- **Item** — canonical product record per source listing (`sourceId` +
  `externalId` unique), UPC/ISBN/ASIN when known, prices as `Decimal(12,2)`,
  `location` for local-pickup items, raw payload retained.
- **Valuation** — resale estimate (`estimatedResale` / low / high), sold-comps
  count, sell-through rate, comp source (`ebay_sold` | `keepa`).
- **Deal** — buy price, estimated fees/shipping, net profit, ROI %, 0–100
  score, lifecycle `new → alerted → claimed → purchased → sold` (or
  `dismissed`), claimed-by user, plus a `meta` JSON breakdown (identity,
  fee/shipping resolution, score components, risk flags, comp sample).
- **AlertRule / AlertEvent** — per-user thresholds + delivery bookkeeping
  (unique per deal × rule × channel).
- **FlipLedger** — actual purchases and sales; powers `GET /ledger/summary`.

## Environment

All variables documented in [`.env.example`](.env.example): `DATABASE_URL`,
`REDIS_URL`, `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, `KEEPA_API_KEY`,
`ANTHROPIC_API_KEY` (AI identify + estate analysis + listing assistant),
`DISCORD_WEBHOOK_URL` and `PUSHOVER_TOKEN`/`PUSHOVER_USER` (deal alert
channels in `worker-valuate`), `JWT_SECRET`, `APP_URL`. Everything optional
degrades gracefully — a missing key disables that capability with a clear
log, never a crash. docker-compose substitutes from `.env` and wires
container networking automatically.

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

## Workers

Every worker container exposes `GET :8080/health` (DB/Redis checks + queue
depths + last-sweep stats) and runs under `restart: unless-stopped`.
Configuration lives in the DB: `Source.config` (rates, sweep intervals,
thresholds, categories — see `packages/shared/src/source-config.ts` for every
knob and default) and `SavedSearch` rows (what to search), both editable via
the API without restarts. Credentials come from env; a worker without its
keys idles with a clear log instead of crashing:

| Worker | Sources | Needs env | Without it |
| --- | --- | --- | --- |
| `worker-ebay` | eBay Browse + Marketplace Insights sweeps | `EBAY_CLIENT_ID/SECRET` | sweeps idle |
| `worker-keepa` | Keepa (Amazon history) | `KEEPA_API_KEY` | sweeps idle |
| `worker-goodwill` | ShopGoodwill public listings | — | fully live |
| `worker-retail` | Target (redsky public), Walmart (affiliate API) | `HOME_ZIP`; Walmart keys optional | Target live, Walmart disabled |
| `worker-estate` | EstateSales.net, RSS (HiBid) + Claude analysis | `HOME_ZIP`; `ANTHROPIC_API_KEY` optional | leads stored without AI scores |
| `worker-valuate` | `valuate` queue consumer: identify → comps → score → Deal → alerts | eBay keys for real comps; `ANTHROPIC_API_KEY`, `KEEPA_API_KEY`, `DISCORD_WEBHOOK_URL`, `PUSHOVER_*` all optional | heuristic identify, demo-comps items only, WS-only alerts |

Failure handling: transient errors retry with exponential backoff; jobs that
exhaust attempts land in the global `dead-letter` queue with the failure
reason, attempt count, and originating worker (inspect via Redis/BullMQ).
Kill-test verified: `SIGKILL` on a worker → docker restarts it → Redis-backed
schedulers resume, prior completed jobs intact.

## Repository layout

```
apps/web/             Next.js 15 mission-control UI: live feed, deal drawer,
                      P&L, sources & rules, listing assistant, system status
apps/api/             Fastify API + WebSocket fan-out + settings + listing
                      assistant (Dockerfile here)
apps/worker-ebay/     eBay Browse sweeps (keywords + misspellings, ending-soon,
                      newly-listed)
apps/worker-keepa/    Keepa/Amazon watchlists, price history, anomaly flags
apps/worker-goodwill/ ShopGoodwill polite category poller
apps/worker-retail/   Retail clearance plugins (sources/retail/{walmart,target}.ts)
apps/worker-estate/   Estate-sale feeds + Anthropic analysis
apps/worker-valuate/  Valuation engine: identify → comps → economics → score →
                      Deal → deals:new + Discord/Pushover delivery
packages/db/          Prisma schema, migrations, seeds, client wrapper
packages/shared/      Cross-service contracts: realtime payloads, rule matching,
                      deal economics, scoring, fee/shipping config, comp stats
packages/worker-core/ Worker chassis: BullMQ app, robots guard, polite HTTP
                      client, checkpoints, DLQ, health server, app settings
packages/clients/     Marketplace/AI clients shared by workers and the API:
                      eBay, Keepa, comps engine, product identifier, listing
                      assistant
apps/watchdog/        Health pinger → Discord outage/recovery alerts
docker/               worker.Dockerfile (shared by all workers + watchdog)
scripts/              smoke.mjs (acceptance), listen.mjs (deal watcher),
                      backup.sh / restore.sh (pg_dump ops)
docs/RUNBOOK.md       What to do when the watchdog pings you
Makefile              deploy / update / status / logs / backup / restore / test
caddy/Caddyfile       Edge config for the later HTTPS phase
docker-compose.yml    postgres + redis + api + web + 6 workers + watchdog +
                      nightly backup (slot for caddy)
```

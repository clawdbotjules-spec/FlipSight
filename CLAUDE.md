# FlipSight — agent notes

Real-time marketplace arbitrage engine. Phase 1 (data model + API +
realtime), Phase 2 (five source workers), and Phase 3 (valuation engine +
Discord/Pushover alerts + AI listing assistant) are complete; see README.md
for the product/API overview.

## Commands

```bash
npm install                # npm workspaces: packages/{shared,db,worker-core,clients}, apps/{api,worker-*}
npm run build              # tsc: shared → db → worker-core → clients → api → workers (ORDER MATTERS)
npm test                   # vitest unit tests in packages/shared
npm run db:generate        # prisma generate (after schema changes)
npm run db:migrate         # prisma migrate dev (needs postgres up)
npm run db:seed            # sources+configs, saved searches, demo user, app settings (RESETS Source.config)
npm run seed:deal          # inject pre-valued demo deal + publish deals:new
npm run seed:item          # inject underpriced Item + enqueue valuate job (phase-3 demo)
npm run dev:api            # tsx watch with pretty logs
npm run smoke              # E2E acceptance vs running stack (phases 1+3; SMOKE_PHASE3=0 to skip 3)
docker compose up --build  # postgres + redis + api + 6 workers
# Run one worker on the host:  HEALTH_PORT=8103 node apps/worker-goodwill/dist/index.js
```

## Architecture invariants

- **Realtime contract**: producers publish the full `DealAlertPayload`
  (see `packages/shared/src/realtime.ts`) on Redis channel `deals:new`.
  The API's `DealFanout` (`apps/api/src/realtime/fanout.ts`) matches it
  against connected users' rules and pushes over plain WebSockets (`ws`,
  NOT Socket.IO — the frontend uses native WebSocket). Rule caches are
  invalidated via the `rules:changed` channel — publish it after any rule
  mutation.
- **Rule matching and deal economics live in `@flipsight/shared`** and are
  unit-tested; API and workers must use those functions, never reimplement
  matching. Fee/shipping resolution (`settings-config.ts`) and scoring
  (`scoring.ts`) live there too.
- **Marketplace/AI clients live in `@flipsight/clients`** (eBay, Keepa,
  comps engine, product identifier, listing assistant) — shared by
  worker-valuate, source workers, and the API. Don't re-add per-worker
  client copies.
- **Valuation engine config is DB-backed** (`AppSetting` rows `fees`,
  `shipping`, `valuation`) — edited via `PUT /settings/:key`, zod-validated
  by `APP_SETTING_SCHEMAS`, read through `getAppSetting()` (60 s cache).
  Change the schemas in `packages/shared/src/settings-config.ts`, not
  ad-hoc.
- **Money is `Decimal(12,2)` in Postgres, plain `number` in every DTO/JSON
  payload** — convert with `dec()`/`decN()` from `@flipsight/db`.
- Heavy work never runs in request handlers (p95 API target <100 ms);
  workers are separate processes (phase 2+, BullMQ on Redis).
- Every service exposes `/health` and runs under `restart: unless-stopped`
  with a Docker healthcheck.

## Conventions & gotchas

- **Workers**: every worker rides `WorkerApp` from `@flipsight/worker-core`
  (BullMQ + pino + health server + DLQ + graceful shutdown). Sweep cadence,
  rate limits, thresholds and categories live in `Source.config`; what to
  search lives in `SavedSearch` rows — both zod-validated via
  `packages/shared/src/source-config.ts` and re-read every sweep (no restart
  needed). Scraper workers must go through `HttpClient` (token bucket +
  robots guard + conditional requests); API-key workers pace via
  `TokenBucket` directly. All source workers upsert via `upsertItem()` then
  `enqueueValuate()` — the valuate consumer lives in **worker-valuate**
  (identify → comps → economics → score → Deal → publish + Discord/Pushover).
- **Alert delivery semantics**: the API's fanout handles the `websocket`
  channel; worker-valuate's `DealNotifier` handles `discord`/`pushover` —
  one message per deal per channel (not per rule), `AlertEvent` rows per
  (deal, rule, channel) with a unique constraint + `skipDuplicates`, and
  `deliveredAt` set only on 2xx. Items with `raw.demoComps` are valued from
  embedded prices when `valuation.allowDemoComps` (default true, loudly
  logged) — disable in prod.
- ShopGoodwill's search API silently ignores unknown body fields — the
  category filter is `selectedCategoryIds` (see `worker-goodwill/src/client.ts`);
  don't "simplify" the request body without re-verifying category scoping.
- ESM everywhere (`"type": "module"`, TS `module: NodeNext`) — relative
  imports need explicit `.js` extensions.
- Workspace deps (`@flipsight/shared`, `@flipsight/db`) resolve to `dist/`,
  so `npm run build` must precede seeds/scripts after fresh clone or edits.
- zod v4: use `.prefault({})` (not `.default({})`) for object-typed defaults
  in config schemas.
- Zod validation on EVERY route via `fastify-type-provider-zod` (zod v4);
  errors are normalized in `app.ts`'s error handler
  (`{error: {code, message, details}}`).
- Prisma is pinned to v6 (`prisma-client-js` generator). Migrations live in
  `packages/db/prisma/migrations/`; the api container applies them via
  `prisma migrate deploy` in `apps/api/docker-entrypoint.sh`.
- Root npm scripts run prisma/tsx from the repo root so the root `.env` is
  picked up (`loadEnvFile()` in shared also checks `../../.env`).
- JWT auth: `app.authenticate` onRequest hook; WS auth via `?token=` query
  param (close code 4401 on failure).
- `docker-compose.yml` contains commented service slots for phase 4+
  (`web`, `caddy`) — uncomment as those apps land.
- Auth endpoints have a stricter rate limit (20/min); `/health` and `/ws`
  are exempt; `POST /assistant/listing` is 5/min and is a deliberate
  long-call exception to the <100 ms rule (user-invoked AI tool).
- Anthropic calls use `messages.parse` + `zodOutputFormat` structured
  outputs (`@anthropic-ai/sdk`), model from `ANTHROPIC_MODEL` (default
  `claude-sonnet-5`); always handle `stop_reason === "refusal"` and null
  `parsed_output`.

# FlipSight — agent notes

Real-time marketplace arbitrage engine. Phase 1 (data model + API + realtime)
and Phase 2 (five source workers) are complete; see README.md for the
product/API overview.

## Commands

```bash
npm install                # npm workspaces: packages/{shared,db,worker-core}, apps/{api,worker-*}
npm run build              # tsc: shared → db → worker-core → api → workers (ORDER MATTERS)
npm test                   # vitest unit tests in packages/shared
npm run db:generate        # prisma generate (after schema changes)
npm run db:migrate         # prisma migrate dev (needs postgres up)
npm run db:seed            # sources+configs, saved searches, demo user (RESETS Source.config)
npm run seed:deal          # inject demo deal + publish deals:new
npm run dev:api            # tsx watch with pretty logs
npm run smoke              # E2E acceptance vs running stack (expects <1s WS latency)
docker compose up --build  # postgres + redis + api + 5 workers
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
  unit-tested; API and future workers must use those functions, never
  reimplement matching.
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
  `TokenBucket` directly. All workers upsert via `upsertItem()` then
  `enqueueValuate()` — the valuate consumer lives in worker-ebay.
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
- `docker-compose.yml` contains commented service slots for phase 2+
  (`web`, `worker-*`, `caddy`) — uncomment as those apps land.
- Auth endpoints have a stricter rate limit (20/min); `/health` and `/ws`
  are exempt from rate limiting.

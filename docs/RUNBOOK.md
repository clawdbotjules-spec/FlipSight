# FlipSight runbook

Field guide for when something breaks. Every service self-heals via
`restart: unless-stopped` and the watchdog posts to Discord when anything is
down for more than 2 minutes — this file is for when you get that ping.

First move, always:

```bash
make status                      # who is unhealthy?
SERVICE=<name> make logs         # what is it saying?
```

---

## A service is down / restart-looping

1. `docker compose ps` — a container in `Restarting` is crash-looping;
   `unhealthy` means it runs but fails its healthcheck.
2. `docker compose logs --tail 200 <service>` — workers log structured JSON;
   the last `err` line is almost always the answer.
3. Common causes:
   - **Bad env** (`DATABASE_URL`, missing `JWT_SECRET`): the process exits at
     boot with a clear message. Fix `.env`, `docker compose up -d <service>`.
   - **Postgres/Redis not up yet**: workers wait via `depends_on`, but if the
     DB is unhealthy see the Postgres section below.
   - **Out of disk**: `df -h` — see "Disk full".
4. One-off restart: `docker compose restart <service>`. The watchdog posts a
   recovery notice when the healthcheck goes green again.

## Deals stopped appearing

Work down the pipeline:

1. **Are items being ingested?** System screen (`/status`) → items/hour per
   worker, or `SELECT count(*) FROM "Item" WHERE "lastCheckedAt" > now() - interval '1 hour';`
   - Zero across all sources → check worker logs; eBay/Keepa idle without
     credentials (by design), ShopGoodwill/Target need no keys.
2. **Is the valuate queue draining?** `/status` shows waiting/active for
   worker-valuate. A growing `waiting` count with zero `active` means the
   consumer is down.
3. **Are valuations happening but no Deals?** `worker-valuate` logs
   `valuate_below_threshold` events — thresholds live in Settings
   (`PUT /settings/valuation`, `scoreThreshold`, `minNetProfit`). Lower them
   or check `valuate_thin_comps` (not enough sold comps → add eBay keys).
4. **Deals exist but no alerts?** Check AlertRules are enabled and their
   channels; the API fanout handles `websocket`, worker-valuate handles
   `discord`/`pushover`. `AlertEvent.deliveredAt IS NULL` rows mean delivery
   failed — check `DISCORD_WEBHOOK_URL` / `PUSHOVER_*` env.

## Dead-letter queue has entries

Jobs land in `dead-letter` after exhausting retries; the System screen shows
the most recent with reasons. They carry the original queue, job name, and
payload. After fixing the cause, re-run naturally: sweeps are repeatable (the
next scheduled sweep covers the gap) and valuations re-trigger on the item's
next price change — or enqueue one manually:

```bash
docker compose exec worker-valuate node -e '
  const {Queue}=require("bullmq");
  const q=new Queue("valuate",{connection:{url:process.env.REDIS_URL}});
  q.add("valuate",{itemId:"<ITEM_ID>",reason:"manual_requeue"}).then(()=>process.exit(0));'
```

## eBay: 401s / no results

- OAuth tokens are cached and refreshed automatically; persistent 401 means
  the client id/secret pair is wrong or the keyset was revoked — regenerate
  in the eBay developer portal (Production keyset).
- HTTP 429: the token bucket already paces requests; a burst of 429s usually
  means another consumer shares the keyset. Lower the worker's rate in
  Sources → eBay config.

## ShopGoodwill sweep suddenly finds nothing

Their search API changes occasionally. Symptoms: `sweep_completed` with
`found: 0` across all categories while the site works in a browser.
`worker-goodwill/src/client.ts` documents the request contract — the category
filter field is `selectedCategoryIds` and the API silently ignores unknown
fields, so diff the site's own XHR payload against ours before changing code.

## Postgres trouble

- **Unhealthy**: `docker compose logs postgres`. Corrupt shutdown usually
  recovers on its own (WAL replay). Disk full → free space, restart.
- **Stuck saying "the database system is shutting down"**: someone sent
  postgres a plain SIGTERM ("smart" shutdown — it waits forever for the
  api's pooled connections to close). `docker restart -t 5 postgres`
  forces it through; dependents crash-loop with backoff until it returns,
  then recover on their own (verified behavior).
- **Disk full**: backups and the DB share the disk. Prune old dumps
  (`ls -lh backups/`), lower `BACKUP_KEEP_DAYS`, `docker system prune -f`
  for dangling images.
- **Restore from backup** (destructive):
  `make restore FILE=backups/flipsight-YYYYMMDD-HHMMSS.dump`
  then `docker compose restart api worker-valuate` (config caches).
- Nightly dumps come from the `backup` sidecar (03:00 UTC by default —
  `BACKUP_HOUR_UTC`); confirm with `docker compose logs backup`.

## Redis trouble

Queues and schedules live in Redis with AOF persistence (`redisdata`
volume) — restart-safe. If Redis is wiped entirely, nothing is lost
permanently: schedules re-register when each worker boots, and items/deals
live in Postgres. In-flight jobs from the wiped queue are gone; the next
sweep re-covers them.

## WebSocket won't connect from the UI

- Topbar shows "offline": the browser can't reach `NEXT_PUBLIC_API_URL`.
  That URL is baked into the web image at **build** time — rebuild with the
  right `APP_API_URL` (must be reachable from the *browser*, not the docker
  network).
- Close code 4401 → expired/invalid JWT; log out and back in.
- CORS errors in the console → `APP_URL` in `.env` must match the origin the
  UI is served from; restart the api after changing it.

## Watchdog is alerting but services look fine

The watchdog checks from inside the compose network. If `api` answers on the
host but the watchdog says down, DNS/network inside compose broke — usually a
half-removed network after a manual `docker network` operation:
`docker compose down && make up`.

## Server rebooted

Nothing to do. Docker's `restart: unless-stopped` brings every service back
(verified: daemon restart → all containers return and go healthy on their
own). If Docker itself isn't enabled at boot: `sudo systemctl enable docker`.

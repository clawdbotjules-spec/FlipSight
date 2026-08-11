#!/usr/bin/env sh
# Restore a pg_dump custom-format backup into the running postgres container.
# DESTRUCTIVE: --clean drops existing objects before recreating them.
#
#   ./scripts/restore.sh backups/flipsight-YYYYMMDD-HHMMSS.dump
set -eu
cd "$(dirname "$0")/.."

FILE="${1:?usage: scripts/restore.sh <backups/flipsight-....dump>}"
[ -f "$FILE" ] || { echo "no such file: $FILE" >&2; exit 1; }

echo "restoring $FILE into the flipsight database (existing data will be replaced)"
docker compose exec -T postgres pg_restore \
  --clean --if-exists --no-owner \
  -U "${POSTGRES_USER:-flipsight}" \
  -d "${POSTGRES_DB:-flipsight}" < "$FILE"
echo "restore complete — restart the api/workers so caches reset:  docker compose restart api worker-valuate"

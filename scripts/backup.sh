#!/usr/bin/env sh
# On-demand Postgres backup (the compose `backup` service handles the nightly
# one). Writes a custom-format dump to ./backups via the running container:
#
#   ./scripts/backup.sh                # or: make backup
#
# Restore (DESTRUCTIVE — replaces current data):
#
#   ./scripts/restore.sh backups/flipsight-YYYYMMDD-HHMMSS.dump
set -eu
cd "$(dirname "$0")/.."

mkdir -p backups
FILE="backups/flipsight-$(date -u +%Y%m%d-%H%M%S).dump"
echo "dumping to $FILE ..."
if ! docker compose exec -T postgres pg_dump \
  --format=custom \
  -U "${POSTGRES_USER:-flipsight}" \
  "${POSTGRES_DB:-flipsight}" > "$FILE"; then
  rm -f "$FILE" # never leave a truncated dump behind
  echo "backup FAILED — is postgres healthy? (docker compose ps)" >&2
  exit 1
fi
echo "done: $FILE ($(du -h "$FILE" | cut -f1))"

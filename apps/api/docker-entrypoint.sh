#!/bin/sh
# Apply pending migrations, then start the API.
# `migrate deploy` is a no-op when the schema is current, so restarts are safe.
set -e

echo "[entrypoint] applying database migrations..."
npx prisma migrate deploy --schema packages/db/prisma/schema.prisma

echo "[entrypoint] starting api..."
exec node apps/api/dist/index.js

# FlipSight API — build from the repo root:
#   docker build -f apps/api/Dockerfile .
# (docker-compose does this automatically)

FROM node:22-slim AS build
# Prisma engines need openssl available at generate time.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Install dependencies first so source edits don't bust the npm cache layer.
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker-ebay/package.json apps/worker-ebay/package.json
COPY apps/worker-keepa/package.json apps/worker-keepa/package.json
COPY apps/worker-goodwill/package.json apps/worker-goodwill/package.json
COPY apps/worker-retail/package.json apps/worker-retail/package.json
COPY apps/worker-estate/package.json apps/worker-estate/package.json
COPY apps/worker-valuate/package.json apps/worker-valuate/package.json
COPY apps/watchdog/package.json apps/watchdog/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/worker-core/package.json packages/worker-core/package.json
COPY packages/clients/package.json packages/clients/package.json
RUN npm ci

COPY packages ./packages
COPY apps ./apps
RUN npx prisma generate --schema packages/db/prisma/schema.prisma
RUN npm run build -w @flipsight/shared \
  && npm run build -w @flipsight/db \
  && npm run build -w @flipsight/worker-core \
  && npm run build -w @flipsight/clients \
  && npm run build -w @flipsight/api

FROM node:22-slim AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app /app
USER node
EXPOSE 4000
CMD ["sh", "apps/api/docker-entrypoint.sh"]

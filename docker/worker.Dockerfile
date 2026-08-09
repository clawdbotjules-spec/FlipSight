# Shared Dockerfile for all FlipSight workers — build from the repo root:
#   docker build -f docker/worker.Dockerfile --build-arg WORKER=worker-ebay .
# (docker-compose passes WORKER per service)

FROM node:22-slim AS build
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker-ebay/package.json apps/worker-ebay/package.json
COPY apps/worker-keepa/package.json apps/worker-keepa/package.json
COPY apps/worker-goodwill/package.json apps/worker-goodwill/package.json
COPY apps/worker-retail/package.json apps/worker-retail/package.json
COPY apps/worker-estate/package.json apps/worker-estate/package.json
COPY apps/worker-valuate/package.json apps/worker-valuate/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/worker-core/package.json packages/worker-core/package.json
COPY packages/clients/package.json packages/clients/package.json
RUN npm ci

COPY packages ./packages
COPY apps ./apps
RUN npx prisma generate --schema packages/db/prisma/schema.prisma
RUN npm run build

FROM node:22-slim AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app /app
ARG WORKER
ENV WORKER=${WORKER}
USER node
EXPOSE 8080
# `exec` keeps node as PID 1 so SIGTERM reaches the graceful-shutdown handler.
CMD ["sh", "-c", "exec node apps/${WORKER}/dist/index.js"]

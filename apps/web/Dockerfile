# FlipSight web (Next.js standalone) — build from the repo root:
#   docker build -f apps/web/Dockerfile --build-arg NEXT_PUBLIC_API_URL=http://localhost:4000 .
# (docker-compose does this automatically)

FROM node:22-slim AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
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

COPY apps/web ./apps/web
# NEXT_PUBLIC_* is baked into the client bundle at build time: point it at the
# URL the BROWSER uses to reach the API (not the docker-internal hostname).
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
RUN npm run build -w @flipsight/web

FROM node:22-slim AS runtime
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
WORKDIR /app
# Standalone output is rooted at the monorepo root (outputFileTracingRoot).
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]

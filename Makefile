# FlipSight ops — single-VPS deployment (Ubuntu + Docker preinstalled).
# Run these from the repo checkout on the server. `make deploy` is idempotent:
# run it for first install and for every update.

COMPOSE ?= docker compose
SHELL := /bin/sh

.PHONY: help deploy preflight up down restart status logs seed seed-deal seed-item \
        smoke test test-integration backup restore update

help: ## List available targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

preflight: ## Verify docker, compose, and a real .env exist
	@command -v docker >/dev/null || { echo "docker is not installed — see README 'Deploying to a VPS'"; exit 1; }
	@docker compose version >/dev/null 2>&1 || { echo "docker compose v2 plugin missing (apt install docker-compose-plugin)"; exit 1; }
	@test -f .env || { cp .env.example .env; \
		echo ""; \
		echo "  Created .env from .env.example."; \
		echo "  EDIT IT FIRST — at minimum set a real JWT_SECRET:"; \
		echo "      openssl rand -hex 32"; \
		echo "  then re-run: make deploy"; \
		echo ""; \
		exit 1; }
	@grep -q "^JWT_SECRET=change-me" .env && { \
		echo "Refusing to deploy with the placeholder JWT_SECRET — edit .env (openssl rand -hex 32)"; \
		exit 1; } || true

deploy: preflight ## Build images, start everything, wait healthy, seed (idempotent)
	$(COMPOSE) build
	$(COMPOSE) up -d --remove-orphans --wait --wait-timeout 420
	$(COMPOSE) exec -T api node packages/db/dist/seed.js
	@echo ""
	@echo "  FlipSight is up:"
	@echo "    web  http://$$(hostname -I 2>/dev/null | awk '{print $$1}' || echo localhost):3000"
	@echo "    api  http://$$(hostname -I 2>/dev/null | awk '{print $$1}' || echo localhost):4000/health"
	@echo "  demo login: demo@flipsight.dev / flipsight-demo (change SEED_DEMO_PASSWORD in .env)"
	@echo ""
	@$(MAKE) --no-print-directory status

update: ## Pull latest code and redeploy
	git pull --ff-only
	@$(MAKE) --no-print-directory deploy

up: ## Start the stack (no rebuild)
	$(COMPOSE) up -d --wait --wait-timeout 420

down: ## Stop the stack (data volumes are kept)
	$(COMPOSE) down

restart: ## Restart everything gracefully
	$(COMPOSE) restart

status: ## Health of every service
	@$(COMPOSE) ps --format 'table {{.Service}}\t{{.Status}}'

logs: ## Tail logs (all services, or SERVICE=worker-valuate make logs)
	$(COMPOSE) logs -f --tail 100 $(SERVICE)

seed: ## Baseline seed: sources, demo user, app settings (idempotent)
	$(COMPOSE) exec -T api node packages/db/dist/seed.js

seed-deal: ## Inject a pre-valued demo deal (phase-1 realtime path)
	$(COMPOSE) exec -T api node packages/db/dist/seed-deal.js

seed-item: ## Inject an underpriced item through the valuation engine
	$(COMPOSE) exec -T worker-valuate node packages/db/dist/seed-item.js

smoke: ## End-to-end acceptance against the running stack (needs host node)
	@test -d node_modules || npm ci
	@test -d packages/shared/dist || npm run build
	npm run smoke

test: ## Unit tests (rule matching, economics, fees/shipping, scoring)
	@test -d node_modules || npm ci
	npm test

test-integration: ## API integration test (starts postgres+redis if needed)
	@test -d node_modules || npm ci
	@test -d packages/shared/dist || npm run build
	$(COMPOSE) up -d --wait postgres redis
	npm run test:api

backup: ## On-demand pg_dump to ./backups (nightly runs automatically)
	./scripts/backup.sh

restore: ## Restore a dump: make restore FILE=backups/flipsight-....dump
	./scripts/restore.sh $(FILE)

/**
 * DealFanout — bridges Redis pub/sub to per-user WebSocket delivery.
 *
 * Workers (and the seed script) publish full deal payloads on `deals:new`.
 * This class matches each incoming deal against the alert rules of every
 * *connected* user and pushes `deal.new` messages to their sockets, then
 * records AlertEvent rows and flips the deal status new → alerted.
 *
 * Rules are cached in-memory for a short TTL; mutations invalidate via the
 * `rules:changed` channel so the cache stays correct across API instances.
 */
import {
  DEALS_NEW_CHANNEL,
  RULES_CHANGED_CHANNEL,
  DealAlertPayloadSchema,
  RulesChangedPayloadSchema,
  dealMatchesRule,
  type RuleForMatch,
  type WsServerMessage,
} from "@flipsight/shared";
import type { PrismaClient } from "@flipsight/db";
import type { FastifyBaseLogger } from "fastify";
import type { Redis } from "ioredis";
import type { WebSocket } from "ws";

interface MatchableRule extends RuleForMatch {
  id: string;
  channels: string[];
}

interface CacheEntry {
  rules: MatchableRule[];
  expiresAt: number;
}

interface FanoutDeps {
  prisma: PrismaClient;
  subscriber: Redis;
  log: FastifyBaseLogger;
}

const RULE_CACHE_TTL_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 30_000;

export class DealFanout {
  private readonly clients = new Map<string, Set<WebSocket>>();
  private readonly ruleCache = new Map<string, CacheEntry>();
  private readonly aliveSockets = new WeakSet<WebSocket>();
  private heartbeat: NodeJS.Timeout | null = null;
  private started = false;

  constructor(private readonly deps: FanoutDeps) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.deps.subscriber.subscribe(DEALS_NEW_CHANNEL, RULES_CHANGED_CHANNEL);
    this.deps.subscriber.on("message", (channel: string, message: string) => {
      if (channel === DEALS_NEW_CHANNEL) {
        void this.handleDealMessage(message);
      } else if (channel === RULES_CHANGED_CHANNEL) {
        this.handleRulesChanged(message);
      }
    });
    this.heartbeat = setInterval(() => this.pingClients(), HEARTBEAT_INTERVAL_MS);
    this.heartbeat.unref();
    this.deps.log.info({ channels: [DEALS_NEW_CHANNEL, RULES_CHANGED_CHANNEL] }, "deal fanout subscribed");
  }

  stop(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    for (const sockets of this.clients.values()) {
      for (const socket of sockets) {
        try {
          socket.close(1001, "Server shutting down");
        } catch {
          // already closed
        }
      }
    }
    this.clients.clear();
    this.ruleCache.clear();
  }

  get connectionCount(): number {
    let count = 0;
    for (const sockets of this.clients.values()) count += sockets.size;
    return count;
  }

  addClient(userId: string, socket: WebSocket): void {
    let set = this.clients.get(userId);
    if (!set) {
      set = new Set();
      this.clients.set(userId, set);
    }
    set.add(socket);
    this.aliveSockets.add(socket);

    socket.on("pong", () => this.aliveSockets.add(socket));
    socket.on("close", () => this.removeClient(userId, socket));
    socket.on("error", (err) => {
      this.deps.log.warn({ err: (err as Error).message, userId }, "websocket error");
      try {
        socket.close();
      } catch {
        // ignore
      }
    });

    // Warm the rule cache so the first deal doesn't pay the DB round-trip.
    void this.getRules(userId).catch(() => undefined);

    this.send(socket, { type: "hello", userId, serverTime: Date.now() });
    this.deps.log.info({ userId, connections: this.connectionCount }, "websocket client connected");
  }

  removeClient(userId: string, socket: WebSocket): void {
    const set = this.clients.get(userId);
    if (!set) return;
    set.delete(socket);
    if (set.size === 0) {
      this.clients.delete(userId);
      this.ruleCache.delete(userId);
    }
  }

  invalidateRules(userId: string): void {
    this.ruleCache.delete(userId);
  }

  private send(socket: WebSocket, message: WsServerMessage): void {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  private pingClients(): void {
    for (const [userId, sockets] of this.clients) {
      for (const socket of sockets) {
        if (!this.aliveSockets.has(socket)) {
          this.deps.log.info({ userId }, "terminating unresponsive websocket");
          socket.terminate();
          continue;
        }
        this.aliveSockets.delete(socket);
        try {
          socket.ping();
        } catch {
          socket.terminate();
        }
      }
    }
  }

  private async getRules(userId: string): Promise<MatchableRule[]> {
    const cached = this.ruleCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) return cached.rules;

    const rows = await this.deps.prisma.alertRule.findMany({
      where: { userId, enabled: true },
    });
    const rules: MatchableRule[] = rows.map((row) => ({
      id: row.id,
      enabled: row.enabled,
      minProfit: row.minProfit ? row.minProfit.toNumber() : null,
      minRoi: row.minRoi,
      maxBuyPrice: row.maxBuyPrice ? row.maxBuyPrice.toNumber() : null,
      categories: row.categories,
      keywords: row.keywords,
      excludeKeywords: row.excludeKeywords,
      localOnly: row.localOnly,
      channels: row.channels,
    }));
    this.ruleCache.set(userId, { rules, expiresAt: Date.now() + RULE_CACHE_TTL_MS });
    return rules;
  }

  private handleRulesChanged(raw: string): void {
    try {
      const parsed = RulesChangedPayloadSchema.safeParse(JSON.parse(raw));
      if (parsed.success) this.invalidateRules(parsed.data.userId);
    } catch {
      // malformed invalidation message — ignore
    }
  }

  private async handleDealMessage(raw: string): Promise<void> {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      this.deps.log.warn("received non-JSON message on deals:new");
      return;
    }
    const parsed = DealAlertPayloadSchema.safeParse(json);
    if (!parsed.success) {
      this.deps.log.warn({ issues: parsed.error.issues }, "invalid deals:new payload");
      return;
    }
    const { deal, publishedAt } = parsed.data;

    const events: Array<{ dealId: string; ruleId: string; channel: "websocket"; deliveredAt: Date }> = [];
    for (const [userId, sockets] of this.clients) {
      if (sockets.size === 0) continue;
      let rules: MatchableRule[];
      try {
        rules = await this.getRules(userId);
      } catch (err) {
        this.deps.log.warn({ err, userId }, "failed to load alert rules for fanout");
        continue;
      }
      const matched = rules.filter(
        (rule) => rule.channels.includes("websocket") && dealMatchesRule(deal, rule),
      );
      if (matched.length === 0) continue;

      const message: WsServerMessage = {
        type: "deal.new",
        publishedAt,
        matchedRuleIds: matched.map((rule) => rule.id),
        deal,
      };
      for (const socket of sockets) this.send(socket, message);

      const deliveredAt = new Date();
      for (const rule of matched) {
        events.push({ dealId: deal.id, ruleId: rule.id, channel: "websocket", deliveredAt });
      }
    }

    if (events.length > 0) {
      // Delivery bookkeeping happens after the push so it never adds latency.
      try {
        await this.deps.prisma.alertEvent.createMany({ data: events, skipDuplicates: true });
        await this.deps.prisma.deal.updateMany({
          where: { id: deal.id, status: "new" },
          data: { status: "alerted" },
        });
      } catch (err) {
        this.deps.log.warn({ err, dealId: deal.id }, "failed to record alert events");
      }
      this.deps.log.info(
        { dealId: deal.id, deliveries: events.length, latencyMs: Date.now() - publishedAt },
        "deal fanned out",
      );
    }
  }
}

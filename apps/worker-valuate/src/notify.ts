/**
 * Deal alert delivery beyond WebSockets: after a Deal is created, every
 * enabled AlertRule (all users — connected or not) is evaluated; matches on
 * the discord / pushover channels get one notification per deal per channel,
 * and an AlertEvent row per (deal, rule, channel). WebSocket delivery stays
 * with the API's fanout, which records its own AlertEvents.
 */
import { dealMatchesRule, TokenBucket, type DealAlertPayload } from "@flipsight/shared";
import type { WorkerApp } from "@flipsight/worker-core";

export interface NotifyResult {
  matchedRules: number;
  discordSent: boolean;
  pushoverSent: boolean;
  events: number;
}

export class DealNotifier {
  private readonly bucket: TokenBucket;
  private warnedMissing = new Set<string>();

  constructor(private readonly app: WorkerApp) {
    // Discord webhooks allow ~30/min; stay well under across both channels.
    this.bucket = new TokenBucket({ name: "notifications", ratePerSec: 0.4, burst: 2, log: app.log });
  }

  get discordConfigured(): boolean {
    return Boolean(process.env.DISCORD_WEBHOOK_URL);
  }

  get pushoverConfigured(): boolean {
    return Boolean(process.env.PUSHOVER_TOKEN && process.env.PUSHOVER_USER);
  }

  async notifyDeal(
    payload: DealAlertPayload,
    options: { discordEnabled: boolean; pushoverEnabled: boolean },
  ): Promise<NotifyResult> {
    const deal = payload.deal;
    const rules = await this.app.prisma.alertRule.findMany({
      where: { enabled: true, channels: { hasSome: ["discord", "pushover"] } },
    });

    const matched = rules.filter((rule) =>
      dealMatchesRule(deal, {
        enabled: rule.enabled,
        minProfit: rule.minProfit ? rule.minProfit.toNumber() : null,
        minRoi: rule.minRoi,
        maxBuyPrice: rule.maxBuyPrice ? rule.maxBuyPrice.toNumber() : null,
        categories: rule.categories,
        keywords: rule.keywords,
        excludeKeywords: rule.excludeKeywords,
        localOnly: rule.localOnly,
      }),
    );
    if (matched.length === 0) return { matchedRules: 0, discordSent: false, pushoverSent: false, events: 0 };

    const wantsDiscord = options.discordEnabled && matched.some((r) => r.channels.includes("discord"));
    const wantsPushover = options.pushoverEnabled && matched.some((r) => r.channels.includes("pushover"));

    // One message per deal per channel (multiple matching rules share it).
    const discordSent = wantsDiscord ? await this.sendDiscord(payload) : false;
    const pushoverSent = wantsPushover ? await this.sendPushover(payload) : false;

    const now = new Date();
    const events = matched.flatMap((rule) =>
      (["discord", "pushover"] as const)
        .filter((channel) => rule.channels.includes(channel))
        .map((channel) => ({
          dealId: deal.id,
          ruleId: rule.id,
          channel,
          deliveredAt: (channel === "discord" ? discordSent : pushoverSent) ? now : null,
        })),
    );
    if (events.length > 0) {
      await this.app.prisma.alertEvent.createMany({ data: events, skipDuplicates: true });
      await this.app.prisma.deal.updateMany({ where: { id: deal.id, status: "new" }, data: { status: "alerted" } });
    }
    return { matchedRules: matched.length, discordSent, pushoverSent, events: events.length };
  }

  private async sendDiscord(payload: DealAlertPayload): Promise<boolean> {
    const url = process.env.DISCORD_WEBHOOK_URL;
    if (!url) {
      this.warnOnce("discord", "DISCORD_WEBHOOK_URL not set — discord alerts disabled");
      return false;
    }
    const deal = payload.deal;
    const meta = (deal.meta ?? {}) as {
      fees?: { pct?: number; fixed?: number };
      shipping?: { rule?: string };
      riskFlags?: string[];
    };
    const feeNote = meta.fees ? ` (${meta.fees.pct}% + $${meta.fees.fixed})` : "";
    const shipNote = meta.shipping?.rule ? ` (${meta.shipping.rule})` : "";
    const body = {
      username: "FlipSight",
      embeds: [
        {
          title: `$${deal.netProfit} profit — ${deal.item.title.slice(0, 200)}`,
          url: deal.item.sourceUrl,
          color: 0x2ecc71,
          fields: [
            { name: "Buy", value: `$${deal.buyPrice}`, inline: true },
            { name: "Est. resale", value: `$${deal.valuation.estimatedResale}`, inline: true },
            { name: "Net profit", value: `$${deal.netProfit} (${deal.roiPct}% ROI)`, inline: true },
            { name: "Fees", value: `$${deal.estFees}${feeNote}`, inline: true },
            { name: "Shipping", value: `$${deal.estShipping}${shipNote}`, inline: true },
            { name: "Score", value: `${deal.score}/100`, inline: true },
            {
              name: "Comps",
              value: `${deal.valuation.soldCompsCount} sold · $${deal.valuation.resaleLow}–$${deal.valuation.resaleHigh}`,
              inline: true,
            },
            ...(meta.riskFlags && meta.riskFlags.length > 0
              ? [{ name: "Risk flags", value: meta.riskFlags.join(", "), inline: true }]
              : []),
          ],
          footer: { text: `${deal.item.sourceKey} · FlipSight` },
          ...(deal.item.imageUrls[0] ? { thumbnail: { url: deal.item.imageUrls[0] } } : {}),
        },
      ],
    };
    return this.post("discord", url, { "content-type": "application/json" }, JSON.stringify(body));
  }

  private async sendPushover(payload: DealAlertPayload): Promise<boolean> {
    const token = process.env.PUSHOVER_TOKEN;
    const user = process.env.PUSHOVER_USER;
    if (!token || !user) {
      this.warnOnce("pushover", "PUSHOVER_TOKEN / PUSHOVER_USER not set — pushover alerts disabled");
      return false;
    }
    const deal = payload.deal;
    const form = new URLSearchParams({
      token,
      user,
      title: `FlipSight: $${deal.netProfit} profit (score ${deal.score})`,
      message:
        `${deal.item.title.slice(0, 180)}\n` +
        `Buy $${deal.buyPrice} → resale $${deal.valuation.estimatedResale} · ` +
        `fees $${deal.estFees} · ship $${deal.estShipping} · ROI ${deal.roiPct}%`,
      url: deal.item.sourceUrl,
      url_title: "Open listing",
    });
    return this.post(
      "pushover",
      "https://api.pushover.net/1/messages.json",
      { "content-type": "application/x-www-form-urlencoded" },
      form.toString(),
    );
  }

  private async post(
    channel: string,
    url: string,
    headers: Record<string, string>,
    body: string,
  ): Promise<boolean> {
    await this.bucket.take(1);
    const startedAt = Date.now();
    try {
      const res = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(10_000) });
      const ok = res.ok;
      this.app.log[ok ? "info" : "warn"](
        { event: "alert_delivery", channel, status: res.status, durationMs: Date.now() - startedAt },
        ok ? "alert delivered" : "alert delivery failed",
      );
      return ok;
    } catch (err) {
      this.app.log.warn(
        { event: "alert_delivery", channel, err: err instanceof Error ? err.message : String(err) },
        "alert delivery failed",
      );
      return false;
    }
  }

  private warnOnce(key: string, msg: string): void {
    if (this.warnedMissing.has(key)) return;
    this.warnedMissing.add(key);
    this.app.log.warn({ event: "notifier_unconfigured", channel: key }, msg);
  }
}

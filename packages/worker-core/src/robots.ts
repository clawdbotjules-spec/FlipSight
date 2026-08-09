/**
 * Minimal robots.txt guard (RFC 9309 subset): per-host fetch + cache, group
 * matching for our user-agent token (falling back to `*`), longest-match
 * allow/disallow, and crawl-delay extraction.
 *
 * Policies are per-host and config-driven:
 *  - "enforce" (default): disallowed URLs are skipped with an error log
 *  - "warn": fetch proceeds but the conflict is logged prominently
 *  - "off": no robots checking for that host
 */
import type { Logger } from "pino";

export type RobotsPolicy = "enforce" | "warn" | "off";

interface RobotsRules {
  /** [allow, pathPrefix] pairs. */
  rules: Array<{ allow: boolean; path: string }>;
  crawlDelaySec: number | null;
  fetchedAt: number;
}

export interface RobotsGuardOptions {
  userAgent: string;
  /** Token matched against User-agent lines (e.g. "flipsightbot"). */
  agentToken: string;
  log: Logger;
  ttlMs?: number;
  policies?: Record<string, RobotsPolicy>;
  defaultPolicy?: RobotsPolicy;
  fetchImpl?: typeof fetch;
}

export interface RobotsDecision {
  allowed: boolean;
  policy: RobotsPolicy;
  matchedRule: string | null;
  crawlDelaySec: number | null;
}

export class RobotsGuard {
  private readonly cache = new Map<string, RobotsRules>();
  private readonly warned = new Set<string>();
  private readonly ttlMs: number;

  constructor(private readonly opts: RobotsGuardOptions) {
    this.ttlMs = opts.ttlMs ?? 3600_000;
  }

  policyFor(host: string): RobotsPolicy {
    return this.opts.policies?.[host] ?? this.opts.defaultPolicy ?? "enforce";
  }

  async decide(url: string): Promise<RobotsDecision> {
    const { host, origin, pathname, search } = new URL(url);
    const policy = this.policyFor(host);
    if (policy === "off") {
      return { allowed: true, policy, matchedRule: null, crawlDelaySec: null };
    }

    const rules = await this.load(origin);
    const target = pathname + search;
    let matched: { allow: boolean; path: string } | null = null;
    for (const rule of rules.rules) {
      if (rule.path === "") continue;
      if (target.startsWith(rule.path)) {
        if (
          matched === null ||
          rule.path.length > matched.path.length ||
          (rule.path.length === matched.path.length && rule.allow && !matched.allow)
        ) {
          matched = rule;
        }
      }
    }

    const disallowed = matched !== null && !matched.allow;
    if (disallowed) {
      const warnKey = `${host}:${matched!.path}`;
      if (!this.warned.has(warnKey)) {
        this.warned.add(warnKey);
        this.opts.log[policy === "enforce" ? "error" : "warn"](
          {
            event: "robots_disallowed",
            host,
            path: target,
            rule: matched!.path,
            policy,
            action: policy === "enforce" ? "request blocked" : "proceeding per configured override",
          },
          "robots.txt disallows this path",
        );
      }
    }

    return {
      allowed: !disallowed || policy === "warn",
      policy,
      matchedRule: matched?.path ?? null,
      crawlDelaySec: rules.crawlDelaySec,
    };
  }

  async crawlDelaySec(url: string): Promise<number | null> {
    const { origin } = new URL(url);
    return (await this.load(origin)).crawlDelaySec;
  }

  private async load(origin: string): Promise<RobotsRules> {
    const cached = this.cache.get(origin);
    if (cached && Date.now() - cached.fetchedAt < this.ttlMs) return cached;

    let body = "";
    try {
      const fetchImpl = this.opts.fetchImpl ?? fetch;
      const res = await fetchImpl(`${origin}/robots.txt`, {
        headers: { "user-agent": this.opts.userAgent },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) body = await res.text();
    } catch (err) {
      this.opts.log.debug({ origin, err: (err as Error).message }, "robots.txt fetch failed; allowing");
    }

    const rules = this.parse(body);
    this.cache.set(origin, rules);
    return rules;
  }

  private parse(body: string): RobotsRules {
    const groups: Array<{ agents: string[]; rules: Array<{ allow: boolean; path: string }>; crawlDelaySec: number | null }> = [];
    let current: (typeof groups)[number] | null = null;
    let lastLineWasAgent = false;

    for (const rawLine of body.split(/\r?\n/)) {
      const line = rawLine.replace(/#.*$/, "").trim();
      if (line === "") continue;
      const colon = line.indexOf(":");
      if (colon === -1) continue;
      const field = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();

      if (field === "user-agent") {
        if (!lastLineWasAgent || current === null) {
          current = { agents: [], rules: [], crawlDelaySec: null };
          groups.push(current);
        }
        current.agents.push(value.toLowerCase());
        lastLineWasAgent = true;
        continue;
      }
      lastLineWasAgent = false;
      if (current === null) continue;
      if (field === "disallow") current.rules.push({ allow: false, path: value });
      else if (field === "allow") current.rules.push({ allow: true, path: value });
      else if (field === "crawl-delay") {
        const parsed = Number(value);
        if (Number.isFinite(parsed) && parsed >= 0) current.crawlDelaySec = parsed;
      }
    }

    const token = this.opts.agentToken.toLowerCase();
    const specific = groups.filter((g) => g.agents.some((a) => a !== "*" && token.includes(a)));
    const wildcard = groups.filter((g) => g.agents.includes("*"));
    const applicable = specific.length > 0 ? specific : wildcard;

    return {
      rules: applicable.flatMap((g) => g.rules),
      crawlDelaySec: applicable.reduce<number | null>(
        (acc, g) => (g.crawlDelaySec != null ? Math.max(acc ?? 0, g.crawlDelaySec) : acc),
        null,
      ),
      fetchedAt: Date.now(),
    };
  }
}

export class RobotsDisallowedError extends Error {
  constructor(public readonly url: string, public readonly rule: string | null) {
    super(`robots.txt disallows ${url}${rule ? ` (rule: ${rule})` : ""}`);
    this.name = "RobotsDisallowedError";
  }
}

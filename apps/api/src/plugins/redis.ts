import fp from "fastify-plugin";
import { Redis } from "ioredis";

declare module "fastify" {
  interface FastifyInstance {
    /** General-purpose client: commands, publishing, rate-limit counters. */
    redis: Redis;
    /** Dedicated subscriber connection (subscriber mode blocks normal commands). */
    redisSub: Redis;
  }
}

export interface RedisPluginOptions {
  url: string;
}

export default fp<RedisPluginOptions>(
  async (app, opts) => {
    const redis = new Redis(opts.url, {
      connectTimeout: 2000,
      maxRetriesPerRequest: 2,
    });
    const redisSub = new Redis(opts.url, {
      connectTimeout: 2000,
      // Subscriber must keep retrying forever rather than failing commands.
      maxRetriesPerRequest: null,
    });
    redis.on("error", (err) => app.log.warn({ err: err.message }, "redis client error"));
    redisSub.on("error", (err) => app.log.warn({ err: err.message }, "redis subscriber error"));

    await redis.ping();

    app.decorate("redis", redis);
    app.decorate("redisSub", redisSub);
    app.addHook("onClose", async () => {
      redis.disconnect();
      redisSub.disconnect();
    });
  },
  { name: "redis" },
);

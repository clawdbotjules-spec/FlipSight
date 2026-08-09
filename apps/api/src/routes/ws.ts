import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { TokenPayload } from "../plugins/auth.js";

const WsQuery = z.object({
  /**
   * JWT access token. Browsers cannot set an Authorization header on a native
   * WebSocket, so the token travels in the query string. Missing/invalid
   * tokens get an application close code 4401 after the upgrade.
   */
  token: z.string().max(4096).optional(),
});

/**
 * Realtime feed: `GET /ws?token=<jwt>` upgrades to a WebSocket. The server
 * pushes `hello` on connect and `deal.new` whenever a published deal matches
 * one of the user's enabled alert rules with the `websocket` channel.
 */
export default async function wsRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/ws",
    {
      websocket: true,
      config: { rateLimit: false },
      schema: { querystring: WsQuery },
    },
    (socket, req) => {
      const token = req.query.token;
      if (!token) {
        socket.close(4401, "Missing token");
        return;
      }
      let payload: TokenPayload;
      try {
        payload = app.jwt.verify<TokenPayload>(token);
      } catch {
        socket.close(4401, "Invalid or expired token");
        return;
      }
      app.fanout.addClient(payload.sub, socket);
    },
  );
}

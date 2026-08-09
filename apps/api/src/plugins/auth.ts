import jwt from "@fastify/jwt";
import fp from "fastify-plugin";
import type { FastifyReply, FastifyRequest } from "fastify";
import { errors } from "../lib/errors.js";

export interface TokenPayload {
  /** User id. */
  sub: string;
  email: string;
  orgId: string;
  role: string;
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: TokenPayload;
    user: TokenPayload;
  }
}

declare module "fastify" {
  interface FastifyInstance {
    /** onRequest hook that requires a valid Bearer token. */
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export interface AuthPluginOptions {
  secret: string;
}

export default fp<AuthPluginOptions>(
  async (app, opts) => {
    await app.register(jwt, { secret: opts.secret });
    app.decorate("authenticate", async (req: FastifyRequest, _reply: FastifyReply) => {
      try {
        await req.jwtVerify();
      } catch {
        throw errors.unauthorized();
      }
    });
  },
  { name: "auth" },
);

import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from "@flipsight/shared";
import { Prisma } from "@flipsight/db";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { errors } from "../lib/errors.js";
import { toOrgDTO, toUserDTO } from "../lib/serializers.js";

const RegisterBody = z.object({
  email: z.string().email().max(320),
  password: z.string().min(8).max(128),
  /** Org name for the new tenant; defaults to "Personal". */
  orgName: z.string().min(1).max(120).optional(),
});

const LoginBody = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(128),
});

/** Per-route limits on credential endpoints to slow brute-forcing. */
const authRateLimit = { rateLimit: { max: 20, timeWindow: "1 minute" } };

export default async function authRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    "/register",
    { config: authRateLimit, schema: { body: RegisterBody } },
    async (req, reply) => {
      const email = req.body.email.trim().toLowerCase();
      const passwordHash = await hashPassword(req.body.password);
      try {
        const user = await app.prisma.user.create({
          data: {
            email,
            passwordHash,
            role: "owner",
            org: { create: { name: req.body.orgName ?? "Personal" } },
          },
        });
        const token = app.jwt.sign(
          { sub: user.id, email: user.email, orgId: user.orgId, role: user.role },
          { expiresIn: app.config.JWT_EXPIRES_IN },
        );
        return reply.status(201).send({ token, user: toUserDTO(user) });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          throw errors.conflict("An account with this email already exists");
        }
        throw err;
      }
    },
  );

  r.post("/login", { config: authRateLimit, schema: { body: LoginBody } }, async (req, reply) => {
    const email = req.body.email.trim().toLowerCase();
    const user = await app.prisma.user.findUnique({ where: { email } });

    // Always run a hash verification so response timing doesn't reveal
    // whether the email exists.
    const ok = await verifyPassword(req.body.password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
    if (!user || !ok) {
      throw errors.unauthorized("Invalid email or password");
    }

    const token = app.jwt.sign(
      { sub: user.id, email: user.email, orgId: user.orgId, role: user.role },
      { expiresIn: app.config.JWT_EXPIRES_IN },
    );
    return reply.send({ token, user: toUserDTO(user) });
  });

  r.get("/me", { onRequest: [app.authenticate] }, async (req) => {
    const user = await app.prisma.user.findUnique({
      where: { id: req.user.sub },
      include: { org: true },
    });
    if (!user) throw errors.unauthorized("Account no longer exists");
    return { user: toUserDTO(user), org: toOrgDTO(user.org) };
  });
}

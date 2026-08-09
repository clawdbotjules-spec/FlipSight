import { createPrismaClient, type PrismaClient } from "@flipsight/db";
import fp from "fastify-plugin";

declare module "fastify" {
  interface FastifyInstance {
    prisma: PrismaClient;
  }
}

export default fp(
  async (app) => {
    const prisma = createPrismaClient();
    await prisma.$connect();
    app.decorate("prisma", prisma);
    app.addHook("onClose", async () => {
      await prisma.$disconnect();
    });
  },
  { name: "prisma" },
);

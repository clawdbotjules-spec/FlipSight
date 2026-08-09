export * from "@prisma/client";

import { PrismaClient, Prisma } from "@prisma/client";

export interface CreatePrismaClientOptions {
  /** Overrides DATABASE_URL from the environment. */
  datasourceUrl?: string;
  log?: Prisma.LogLevel[];
}

export function createPrismaClient(options: CreatePrismaClientOptions = {}): PrismaClient {
  return new PrismaClient({
    ...(options.datasourceUrl ? { datasourceUrl: options.datasourceUrl } : {}),
    log: options.log ?? ["warn", "error"],
  });
}

/** Convert a Prisma Decimal (or null) to a plain number for DTOs/JSON. */
export function dec(value: Prisma.Decimal | null | undefined): number | null {
  return value == null ? null : value.toNumber();
}

/** Non-nullable variant of {@link dec}. */
export function decN(value: Prisma.Decimal): number {
  return value.toNumber();
}

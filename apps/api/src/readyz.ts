import { loadConfig } from "@queuehouse/core";
import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";

const DEP_CHECK_MS = 2000;

export async function checkPostgres(databaseUrl: string): Promise<void> {
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("Postgres check timed out")), DEP_CHECK_MS),
  );
  try {
    await Promise.race([prisma.$queryRaw`SELECT 1`, timeout]);
  } finally {
    await prisma.$disconnect();
  }
}

export async function checkRedis(redisUrl: string): Promise<void> {
  const client = new Redis(redisUrl, {
    connectTimeout: DEP_CHECK_MS,
    commandTimeout: DEP_CHECK_MS,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });
  try {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Redis check timed out")), DEP_CHECK_MS),
    );
    await Promise.race([client.ping(), timeout]);
  } finally {
    client.disconnect();
  }
}

/**
 * Re-reads config from the current process env (so readiness tests can override env per request).
 */
export async function runReadinessFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const { databaseUrl, redisUrl } = loadConfig(env);
  if (!databaseUrl) {
    throw new Error("DATABASE_URL not available for readiness (required when not disabled)");
  }
  if (!redisUrl) {
    throw new Error("REDIS_URL not available for readiness (required when not disabled)");
  }
  await checkPostgres(databaseUrl);
  await checkRedis(redisUrl);
}

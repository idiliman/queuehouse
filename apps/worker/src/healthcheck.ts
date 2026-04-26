import Redis from "ioredis";
import { loadConfig } from "@queuehouse/core";

const PING_MS = 2000;

async function main() {
  try {
    const config = loadConfig(process.env, {
      requireSessionSecret: false,
      requireDatabaseUrl: false,
    });
    const client = new Redis(config.redisUrl!, {
      connectTimeout: PING_MS,
      commandTimeout: PING_MS,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    try {
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Redis ping timed out")), PING_MS),
      );
      await Promise.race([client.ping(), timeout]);
    } finally {
      client.disconnect();
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}

if (import.meta.main) {
  void main();
}

import { describe, expect, it } from "bun:test";
import { DEFAULT_WORKER_SHUTDOWN_GRACE_MS, EXAMPLE_DATABASE_URL, loadConfig } from "../src/config";

const baseEnv = {
  DATABASE_URL: EXAMPLE_DATABASE_URL,
  REDIS_URL: "redis://localhost:6379",
};

describe("loadConfig", () => {
  it("loads development config with required URLs", () => {
    const c = loadConfig({ ...baseEnv, NODE_ENV: "development" });
    expect(c.nodeEnv).toBe("development");
    expect(c.databaseUrl).toBe(EXAMPLE_DATABASE_URL);
    expect(c.redisUrl).toBe("redis://localhost:6379");
    expect(c.namespace).toBe("queuehouse");
    expect(c.port).toBe(3000);
    expect(c.workerShutdownGraceMs).toBe(DEFAULT_WORKER_SHUTDOWN_GRACE_MS);
    expect(c.retention.completedJobMs).toBe(7 * 86_400_000);
    expect(c.retention.failedJobMs).toBe(30 * 86_400_000);
    expect(c.retention.systemQueueMs).toBe(14 * 86_400_000);
  });

  it("parses WORKER_SHUTDOWN_GRACE_MS", () => {
    const c = loadConfig({ ...baseEnv, NODE_ENV: "development", WORKER_SHUTDOWN_GRACE_MS: "5000" });
    expect(c.workerShutdownGraceMs).toBe(5000);
  });

  it("rejects invalid WORKER_SHUTDOWN_GRACE_MS", () => {
    expect(() => loadConfig({ ...baseEnv, WORKER_SHUTDOWN_GRACE_MS: "-1" })).toThrow(
      /WORKER_SHUTDOWN_GRACE_MS/,
    );
  });

  it("uses APP_NAMESPACE when set", () => {
    const c = loadConfig({
      ...baseEnv,
      NODE_ENV: "development",
      APP_NAMESPACE: "staging-eu",
    });
    expect(c.namespace).toBe("staging-eu");
  });

  it("parses PORT", () => {
    const c = loadConfig({ ...baseEnv, NODE_ENV: "development", PORT: "4000" });
    expect(c.port).toBe(4000);
  });

  it("throws on missing DATABASE_URL when required", () => {
    expect(() =>
      loadConfig({ NODE_ENV: "development", REDIS_URL: "redis://localhost:6379" }),
    ).toThrow(/DATABASE_URL/);
  });

  it("throws on missing REDIS_URL when required", () => {
    expect(() =>
      loadConfig({ NODE_ENV: "development", DATABASE_URL: EXAMPLE_DATABASE_URL }),
    ).toThrow(/REDIS_URL/);
  });

  it("throws on invalid PORT", () => {
    expect(() => loadConfig({ ...baseEnv, PORT: "0" })).toThrow(/PORT/);
  });

  it("allows missing DATABASE_URL for worker-style options", () => {
    const c = loadConfig(
      { NODE_ENV: "development", REDIS_URL: "redis://localhost:6379" },
      { requireDatabaseUrl: false },
    );
    expect(c.databaseUrl).toBeUndefined();
    expect(c.redisUrl).toBe("redis://localhost:6379");
  });

  it("rejects example DATABASE_URL in production", () => {
    expect(() =>
      loadConfig(
        {
          NODE_ENV: "production",
          DATABASE_URL: EXAMPLE_DATABASE_URL,
          REDIS_URL: "redis://cache.internal:6379",
          SESSION_SECRET: "0123456789abcdef0123456789abcdef",
        },
        { requireSessionSecret: false },
      ),
    ).toThrow(/Production DATABASE_URL/);
  });

  it("rejects missing SESSION_SECRET in production for API mode", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        DATABASE_URL: "postgresql://app:real@db.internal:5432/queuehouse",
        REDIS_URL: "redis://cache.internal:6379",
      }),
    ).toThrow(/SESSION_SECRET/);
  });

  it("rejects short SESSION_SECRET in production", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        DATABASE_URL: "postgresql://app:real@db.internal:5432/queuehouse",
        REDIS_URL: "redis://cache.internal:6379",
        SESSION_SECRET: "tooshort",
      }),
    ).toThrow(/32/);
  });

  it("rejects weak SESSION_SECRET in production", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        DATABASE_URL: "postgresql://app:real@db.internal:5432/queuehouse",
        REDIS_URL: "redis://cache.internal:6379",
        /** Exact match against documented dev placeholder; length meets production minimum. */
        SESSION_SECRET: "local-dev-session-secret-change-me",
      }),
    ).toThrow(/weak/);
  });

  it("accepts production config with strong secret and non-example DB URL", () => {
    const c = loadConfig({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://app:real@db.internal:5432/queuehouse",
      REDIS_URL: "redis://cache.internal:6379",
      SESSION_SECRET: "0123456789abcdef0123456789abcdef0123456789abcdef",
    });
    expect(c.nodeEnv).toBe("production");
    expect(c.sessionSecret).toBeDefined();
  });
});

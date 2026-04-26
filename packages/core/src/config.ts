/** Documented dev default; production must not use this exact URL. */
export const EXAMPLE_DATABASE_URL =
  "postgresql://queuehouse:queuehouse@localhost:5432/queuehouse";

export type NodeEnv = "development" | "production" | "test";

export type LoadConfigOptions = {
  /** When false, `DATABASE_URL` is optional (e.g. worker before DB use). Default true. */
  requireDatabaseUrl?: boolean;
  /** When false, `REDIS_URL` is optional. Default true. */
  requireRedisUrl?: boolean;
  /** When false, `SESSION_SECRET` is not required in production (e.g. worker). Default true. */
  requireSessionSecret?: boolean;
};

export type QueuehouseConfig = {
  nodeEnv: NodeEnv;
  /** Logical deployment / tenant namespace for logs and health payloads. */
  namespace: string;
  port: number;
  databaseUrl?: string;
  redisUrl?: string;
  /** Present when set; required in production for API processes when `requireSessionSecret` is true. */
  sessionSecret?: string;
};

const WEAK_SESSION_SECRETS = new Set(
  [
    "changeme",
    "secret",
    "queuehouse",
    "development",
    "dev-secret",
    "local-dev-session-secret-change-me",
    "session-secret",
  ].map((s) => s.toLowerCase()),
);

function parseNodeEnv(raw: string | undefined): NodeEnv {
  if (raw === "production") return "production";
  if (raw === "test") return "test";
  return "development";
}

function required(
  env: Record<string, string | undefined>,
  key: string,
): string {
  const v = env[key]?.trim();
  if (!v) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return v;
}

function optional(env: Record<string, string | undefined>, key: string): string | undefined {
  const v = env[key]?.trim();
  return v || undefined;
}

/**
 * Load and validate Queuehouse configuration. Throws with a clear message on invalid or unsafe values.
 */
export function loadConfig(
  env: Record<string, string | undefined>,
  options: LoadConfigOptions = {},
): QueuehouseConfig {
  const requireDatabaseUrl = options.requireDatabaseUrl !== false;
  const requireRedisUrl = options.requireRedisUrl !== false;
  const requireSessionSecret = options.requireSessionSecret !== false;

  const nodeEnv = parseNodeEnv(env.NODE_ENV);
  const namespace =
    optional(env, "APP_NAMESPACE") ?? optional(env, "QUEUEHOUSE_NAMESPACE") ?? "queuehouse";

  const portRaw = env.PORT;
  const port = portRaw ? Number(portRaw) : 3000;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${portRaw ?? "(unset)"} — expected integer 1–65535`);
  }

  const databaseUrl = requireDatabaseUrl ? required(env, "DATABASE_URL") : optional(env, "DATABASE_URL");
  const redisUrl = requireRedisUrl ? required(env, "REDIS_URL") : optional(env, "REDIS_URL");
  const sessionSecret = optional(env, "SESSION_SECRET");

  if (nodeEnv === "production") {
    if (databaseUrl !== undefined && databaseUrl === EXAMPLE_DATABASE_URL) {
      throw new Error(
        "Production DATABASE_URL must not use the documented local dev default (queuehouse:queuehouse@localhost). Set a dedicated database URL and credentials.",
      );
    }
    if (requireSessionSecret) {
      if (!sessionSecret) {
        throw new Error(
          "Production requires SESSION_SECRET — set a high-entropy secret (at least 32 characters).",
        );
      }
      if (sessionSecret.length < 32) {
        throw new Error(
          `Production SESSION_SECRET must be at least 32 characters (got ${sessionSecret.length}).`,
        );
      }
      if (WEAK_SESSION_SECRETS.has(sessionSecret.toLowerCase())) {
        throw new Error("Production SESSION_SECRET is a known weak placeholder; use a random secret.");
      }
    }
  }

  return {
    nodeEnv,
    namespace,
    port,
    databaseUrl,
    redisUrl,
    sessionSecret,
  };
}

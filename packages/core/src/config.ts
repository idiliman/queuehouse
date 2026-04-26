/** Documented dev default; production must not use this exact URL. */
export const EXAMPLE_DATABASE_URL =
  "postgresql://queuehouse:queuehouse@localhost:5432/queuehouse";

export type NodeEnv = "development" | "production" | "test";

/** Time-based BullMQ retention: jobs older than these windows are eligible for `queue.clean`. */
export type RetentionPolicy = {
  /** Product queues: completed jobs at least this old are removed. */
  completedJobMs: number;
  /** Product queues: failed jobs at least this old are removed. */
  failedJobMs: number;
  /** `queuehouse-system` completed + failed jobs use this window. */
  systemQueueMs: number;
};

export type LoadConfigOptions = {
  /** When false, `DATABASE_URL` is optional (e.g. worker before DB use). Default true. */
  requireDatabaseUrl?: boolean;
  /** When false, `REDIS_URL` is optional. Default true. */
  requireRedisUrl?: boolean;
  /** When false, `SESSION_SECRET` is not required in production (e.g. worker). Default true. */
  requireSessionSecret?: boolean;
};

/** Default for worker `WORKER_SHUTDOWN_GRACE_MS` when unset (SIGTERM / SIGINT). */
export const DEFAULT_WORKER_SHUTDOWN_GRACE_MS = 30_000;

export type QueuehouseConfig = {
  nodeEnv: NodeEnv;
  /** Logical deployment / tenant namespace for logs and health payloads. */
  namespace: string;
  port: number;
  databaseUrl?: string;
  redisUrl?: string;
  /** Present when set; required in production for API processes when `requireSessionSecret` is true. */
  sessionSecret?: string;
  /**
   * Max time the worker process waits for in-flight jobs after pause before forcing close.
   * Zero means do not wait beyond pause/cancel. Parsed from `WORKER_SHUTDOWN_GRACE_MS`.
   */
  workerShutdownGraceMs: number;
  /** Parsed from `RETENTION_*_DAYS` env; defaults match queuehouse spec (completed brief, failed longer, system mid). */
  retention: RetentionPolicy;
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

const MS_PER_DAY = 86_400_000;

function parseDaysEnv(
  env: Record<string, string | undefined>,
  key: string,
  defaultDays: number,
): number {
  const raw = optional(env, key);
  if (raw === undefined) return defaultDays;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(
      `Invalid ${key}: ${raw} — expected non-negative integer days (0 disables time-based removal for that category).`,
    );
  }
  if (n > 3650) {
    throw new Error(`Invalid ${key} — at most 3650 days`);
  }
  return n;
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

  const graceRaw = optional(env, "WORKER_SHUTDOWN_GRACE_MS");
  let workerShutdownGraceMs = DEFAULT_WORKER_SHUTDOWN_GRACE_MS;
  if (graceRaw !== undefined) {
    const n = Number(graceRaw);
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(
        `Invalid WORKER_SHUTDOWN_GRACE_MS: ${graceRaw} — expected non-negative integer milliseconds`,
      );
    }
    if (n > 3_600_000) {
      throw new Error(
        "Invalid WORKER_SHUTDOWN_GRACE_MS — must be at most 3600000 (1 hour).",
      );
    }
    workerShutdownGraceMs = n;
  }

  const completedDays = parseDaysEnv(
    env,
    "RETENTION_COMPLETED_DAYS",
    7,
  );
  const failedDays = parseDaysEnv(env, "RETENTION_FAILED_DAYS", 30);
  const systemQueueDays = parseDaysEnv(
    env,
    "RETENTION_SYSTEM_QUEUE_DAYS",
    14,
  );
  const retention: RetentionPolicy = {
    completedJobMs: completedDays * MS_PER_DAY,
    failedJobMs: failedDays * MS_PER_DAY,
    systemQueueMs: systemQueueDays * MS_PER_DAY,
  };

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
    workerShutdownGraceMs,
    retention,
  };
}

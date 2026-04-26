import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import {
  bullmqPrefix,
  isJobUnrecoverableError,
  listRegisteredJobs,
  loadConfig,
  QUEUEHOUSE_VERSION,
  runJobFromQueueData,
  structuredLog,
  WORKER_HEARTBEAT_REFRESH_MS,
  WORKER_HEARTBEAT_TTL_SEC,
  workerHeartbeatRedisKey,
  type WorkerHeartbeatPayload,
} from "@queuehouse/core";
import { UnrecoverableError, Worker } from "bullmq";
import IORedis from "ioredis";
import { bullmqWorkerGracefulShutdown } from "./bullmq-graceful-shutdown";
import {
  recordJobProcessing,
  renderWorkerPrometheusText,
  workerPrometheusContentType,
} from "./worker-prometheus";

const WORKER_CONCURRENCY = 5;

const config = loadConfig(process.env, {
  requireSessionSecret: false,
  requireDatabaseUrl: false,
});

const connection = new IORedis(config.redisUrl!, { maxRetriesPerRequest: null });
const prefix = bullmqPrefix(config.namespace);
const uniqueQueues = [...new Set(listRegisteredJobs().map((j) => j.queue))];

const workers = uniqueQueues.map(
  (queueName) =>
    new Worker(
      queueName,
      async (job) => {
        const data = job.data as { jobName?: string };
        const jobName = data.jobName ?? "unknown";
        const t0 = performance.now();
        try {
          const out = await runJobFromQueueData(job.data);
          recordJobProcessing({
            queue: queueName,
            jobName,
            durationSeconds: (performance.now() - t0) / 1000,
            result: "success",
          });
          return out;
        } catch (e) {
          recordJobProcessing({
            queue: queueName,
            jobName,
            durationSeconds: (performance.now() - t0) / 1000,
            result: "error",
          });
          if (isJobUnrecoverableError(e)) {
            throw new UnrecoverableError(e.message);
          }
          throw e;
        }
      },
      { connection, prefix, concurrency: WORKER_CONCURRENCY },
    ),
);

structuredLog(config, "queuehouse-worker", "info", "worker started", {
  queues: uniqueQueues,
  coreVersion: QUEUEHOUSE_VERSION,
  bullPrefix: prefix,
});

function parseWorkerMetricsPort(): number | undefined {
  const raw = process.env.WORKER_METRICS_PORT?.trim();
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    structuredLog(config, "queuehouse-worker", "warn", "invalid WORKER_METRICS_PORT; metrics disabled", {
      WORKER_METRICS_PORT: raw,
    });
    return undefined;
  }
  return n;
}

if (import.meta.main) {
  const metricsPort = parseWorkerMetricsPort();
  if (metricsPort !== undefined) {
    Bun.serve({
      port: metricsPort,
      fetch: async () => {
        const body = await renderWorkerPrometheusText(config);
        return new Response(body, {
          headers: { "Content-Type": workerPrometheusContentType() },
        });
      },
    });
    structuredLog(config, "queuehouse-worker", "info", "worker metrics listening", {
      port: metricsPort,
    });
  }

  const instanceId = randomUUID();
  const heartbeatKey = workerHeartbeatRedisKey(config.namespace, instanceId);
  const startedAt = new Date().toISOString();

  async function publishHeartbeat(): Promise<void> {
    const payload: WorkerHeartbeatPayload = {
      instanceId,
      coreVersion: QUEUEHOUSE_VERSION,
      queues: [...uniqueQueues].sort(),
      concurrency: WORKER_CONCURRENCY,
      hostname: hostname(),
      pid: process.pid,
      startedAt,
    };
    await connection.set(heartbeatKey, JSON.stringify(payload), "EX", WORKER_HEARTBEAT_TTL_SEC);
  }

  await publishHeartbeat();
  const hbInterval = setInterval(() => {
    void publishHeartbeat().catch((err) => {
      structuredLog(config, "queuehouse-worker", "error", "heartbeat failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, WORKER_HEARTBEAT_REFRESH_MS);

  let isShuttingDown = false;
  const graceMs = config.workerShutdownGraceMs;

  async function shutdown(signal: string): Promise<void> {
    if (isShuttingDown) {
      return;
    }
    isShuttingDown = true;
    clearInterval(hbInterval);
    structuredLog(config, "queuehouse-worker", "info", "shutdown: signal received", {
      signal,
      graceMs,
    });
    try {
      await connection.del(heartbeatKey);
    } catch {
      /* ignore */
    }
    try {
      await bullmqWorkerGracefulShutdown(workers, {
        graceMs,
        onLog: (line) => {
          structuredLog(config, "queuehouse-worker", "info", line);
        },
        cancelReason: `signal:${signal}`,
      });
    } catch (err) {
      structuredLog(config, "queuehouse-worker", "error", "error during worker shutdown", {
        error: err instanceof Error ? err.message : String(err),
      });
      try {
        await connection.quit();
      } catch {
        /* ignore */
      }
      process.exit(1);
    }
    try {
      await connection.quit();
    } catch (err) {
      structuredLog(config, "queuehouse-worker", "error", "error closing Redis", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    process.exit(0);
  }

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

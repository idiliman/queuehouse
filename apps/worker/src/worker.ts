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
        try {
          return runJobFromQueueData(job.data);
        } catch (e) {
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

if (import.meta.main) {
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

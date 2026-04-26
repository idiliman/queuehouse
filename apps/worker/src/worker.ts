import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import {
  bullmqPrefix,
  isJobUnrecoverableError,
  listRegisteredJobs,
  loadConfig,
  QUEUEHOUSE_VERSION,
  runJobFromQueueData,
  WORKER_HEARTBEAT_REFRESH_MS,
  WORKER_HEARTBEAT_TTL_SEC,
  workerHeartbeatRedisKey,
  type WorkerHeartbeatPayload,
} from "@queuehouse/core";
import { UnrecoverableError, Worker } from "bullmq";
import IORedis from "ioredis";

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

console.log(
  `[queuehouse-worker] [${config.namespace}] listening on queues: ${uniqueQueues.join(", ")} (core ${QUEUEHOUSE_VERSION}, bull prefix "${prefix}")`,
);

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
      console.error(
        "[queuehouse-worker] heartbeat failed",
        err instanceof Error ? err.message : err,
      );
    });
  }, WORKER_HEARTBEAT_REFRESH_MS);

  async function shutdown(signal: string): Promise<void> {
    clearInterval(hbInterval);
    console.log(`[queuehouse-worker] ${signal} received, closing workers…`);
    try {
      await connection.del(heartbeatKey);
    } catch {
      /* ignore */
    }
    await Promise.all(workers.map((w) => w.close()));
    await connection.quit();
    process.exit(0);
  }

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

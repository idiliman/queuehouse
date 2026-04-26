import {
  bullmqPrefix,
  isJobUnrecoverableError,
  listRegisteredJobs,
  loadConfig,
  QUEUEHOUSE_VERSION,
  runJobFromQueueData,
} from "@queuehouse/core";
import { UnrecoverableError, Worker } from "bullmq";
import IORedis from "ioredis";

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
      { connection, prefix, concurrency: 5 },
    ),
);

async function shutdown(signal: string): Promise<void> {
  console.log(`[queuehouse-worker] ${signal} received, closing workers…`);
  await Promise.all(workers.map((w) => w.close()));
  await connection.quit();
  process.exit(0);
}

console.log(
  `[queuehouse-worker] [${config.namespace}] listening on queues: ${uniqueQueues.join(", ")} (core ${QUEUEHOUSE_VERSION}, bull prefix "${prefix}")`,
);

if (import.meta.main) {
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

import IORedis from "ioredis";
import type { QueuehouseConfig } from "@queuehouse/core";

let shared: IORedis | null = null;

/** Single Redis connection for BullMQ queues (API process). */
export function getQueuehouseRedis(config: QueuehouseConfig): IORedis {
  if (!shared) {
    shared = new IORedis(config.redisUrl!, { maxRetriesPerRequest: null });
    shared.on("error", (err) => {
      console.error("[queuehouse-redis]", err instanceof Error ? err.message : err);
    });
  }
  return shared;
}

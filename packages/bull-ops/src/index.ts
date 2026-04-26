import { Queue, type Job } from "bullmq";
import type IORedis from "ioredis";
import { bullmqPrefix, listRegisteredJobs, type QueuehouseConfig } from "@queuehouse/core";

const queueInstances = new Map<string, Queue>();

function queueCacheKey(prefix: string, queueName: string): string {
  return `${prefix}\0${queueName}`;
}

export function getOrCreateQueue(redis: IORedis, config: QueuehouseConfig, queueName: string): Queue {
  const prefix = bullmqPrefix(config.namespace);
  const key = queueCacheKey(prefix, queueName);
  let q = queueInstances.get(key);
  if (!q) {
    q = new Queue(queueName, { connection: redis, prefix });
    queueInstances.set(key, q);
  }
  return q;
}

/**
 * Retry a failed job in place (BullMQ moves it back to waiting). Admin-only at route layer.
 */
export async function retryFailedJobInPlace(
  redis: IORedis,
  config: QueuehouseConfig,
  queueName: string,
  jobId: string,
): Promise<{ ok: true } | { error: "job_not_found" | "forbidden_queue" | "invalid_state" }> {
  const regQueues = new Set(listRegisteredJobs().map((j) => j.queue));
  if (!regQueues.has(queueName)) {
    return { error: "forbidden_queue" };
  }
  const queue = getOrCreateQueue(redis, config, queueName);
  const job: Job | undefined = await queue.getJob(jobId);
  if (!job) return { error: "job_not_found" };
  const state = await job.getState();
  if (state !== "failed") {
    return { error: "invalid_state" };
  }
  await job.retry("failed");
  return { ok: true };
}

/**
 * Remove a failed job from Redis. Admin-only at route layer.
 */
export async function removeFailedJob(
  redis: IORedis,
  config: QueuehouseConfig,
  queueName: string,
  jobId: string,
): Promise<{ ok: true } | { error: "job_not_found" | "forbidden_queue" | "invalid_state" }> {
  const regQueues = new Set(listRegisteredJobs().map((j) => j.queue));
  if (!regQueues.has(queueName)) {
    return { error: "forbidden_queue" };
  }
  const queue = getOrCreateQueue(redis, config, queueName);
  const job: Job | undefined = await queue.getJob(jobId);
  if (!job) return { error: "job_not_found" };
  const state = await job.getState();
  if (state !== "failed") {
    return { error: "invalid_state" };
  }
  await job.remove();
  return { ok: true };
}

export type BulkDlqAction = "retry" | "remove";

/**
 * Run bulk DLQ recovery for explicit queue/job id targets (system job processor).
 */
export async function runBulkDlqOperation(
  redis: IORedis,
  config: QueuehouseConfig,
  input: { action: BulkDlqAction; targets: { queueName: string; jobId: string }[] },
  onProgress?: (current: number, total: number) => void | Promise<void>,
): Promise<{
  requested: number;
  executed: number;
  skipped: number;
  failed: number;
}> {
  let executed = 0;
  let skipped = 0;
  let failed = 0;
  const total = input.targets.length;
  for (let i = 0; i < input.targets.length; i++) {
    const t = input.targets[i]!;
    const r =
      input.action === "retry"
        ? await retryFailedJobInPlace(redis, config, t.queueName, t.jobId)
        : await removeFailedJob(redis, config, t.queueName, t.jobId);
    if ("ok" in r && r.ok) {
      executed += 1;
    } else if ("error" in r && r.error === "forbidden_queue") {
      failed += 1;
    } else {
      skipped += 1;
    }
    if (onProgress) {
      await onProgress(i + 1, total);
    }
  }
  return { requested: total, executed, skipped, failed };
}

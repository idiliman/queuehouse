import type { JobSchedule } from "@prisma/client";
import type IORedis from "ioredis";
import {
  getRegisteredJob,
  JOB_CAPABILITY,
  mergePayloadWithRetryForEnqueue,
  type QueuehouseConfig,
  resolveBullmqRetryForEnqueue,
  splitJobEnqueueBody,
} from "@queuehouse/core";
import { getOrCreateQueue } from "./queuehouse-queue";

function assertSchedulableJob(jobName: string) {
  const job = getRegisteredJob(jobName);
  if (!job) {
    const e = new Error("unknown_job") as Error & { code?: string };
    e.code = "unknown_job";
    throw e;
  }
  if (!job.capabilities.includes(JOB_CAPABILITY.SCHEDULABLE)) {
    const e = new Error("job_not_schedulable") as Error & { code?: string };
    e.code = "job_not_schedulable";
    throw e;
  }
  return job;
}

function parsePayloadAndRetry(
  jobName: string,
  payload: unknown,
  retryJson: unknown,
): { payload: unknown; eff: ReturnType<typeof resolveBullmqRetryForEnqueue> } {
  const job = assertSchedulableJob(jobName);
  const override = retryJson === null || retryJson === undefined ? undefined : retryJson;
  const merged = mergePayloadWithRetryForEnqueue(payload, override);
  const { payload: pl, retryOverride } = splitJobEnqueueBody(job, merged);
  job.inputSchema.parse(pl);
  const eff = resolveBullmqRetryForEnqueue(job, retryOverride);
  return { payload: pl, eff };
}

/** Apply schedule row to BullMQ: upsert when enabled, remove when disabled. */
export async function syncJobScheduleToBull(
  redis: IORedis,
  config: QueuehouseConfig,
  row: JobSchedule,
): Promise<void> {
  const job = assertSchedulableJob(row.jobName);
  const queue = getOrCreateQueue(redis, config, job.queue);
  if (!row.enabled) {
    await queue.removeJobScheduler(row.id);
    return;
  }
  const { payload, eff } = parsePayloadAndRetry(
    row.jobName,
    row.payload,
    row.retryOverride,
  );
  const data = {
    jobName: job.name,
    payload,
    requestId: `schedule:${row.id}`,
    source: "schedule" as const,
    scheduleId: row.id,
  };
  await queue.upsertJobScheduler(
    row.id,
    { pattern: row.cronPattern, tz: row.timeZone },
    {
      name: job.name,
      data,
      opts: {
        attempts: eff.maxAttempts,
        backoff: eff.backoffMs
          ? { type: "fixed" as const, delay: eff.backoffMs }
          : undefined,
        removeOnComplete: { count: 10_000 },
        removeOnFail: false,
        ...(row.priority != null ? { priority: row.priority } : {}),
      },
    },
  );
}

/** Remove schedulers for rows missing from DB or before delete. */
export async function removeJobScheduleFromBull(
  redis: IORedis,
  config: QueuehouseConfig,
  jobName: string,
  scheduleId: string,
): Promise<void> {
  const job = getRegisteredJob(jobName);
  if (!job) return;
  const queue = getOrCreateQueue(redis, config, job.queue);
  await queue.removeJobScheduler(scheduleId);
}

export async function reconcileAllEnabledJobSchedules(
  redis: IORedis,
  config: QueuehouseConfig,
  rows: JobSchedule[],
): Promise<void> {
  for (const row of rows) {
    if (!row.enabled) continue;
    await syncJobScheduleToBull(redis, config, row);
  }
}

export async function getNextRunForSchedule(
  redis: IORedis,
  config: QueuehouseConfig,
  jobName: string,
  scheduleId: string,
): Promise<number | null> {
  const job = getRegisteredJob(jobName);
  if (!job) return null;
  const queue = getOrCreateQueue(redis, config, job.queue);
  const js = await queue.getJobScheduler(scheduleId);
  return js?.next ?? null;
}

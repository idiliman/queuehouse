import { Queue, type Job } from "bullmq";
import type IORedis from "ioredis";
import {
  bullmqPrefix,
  getRegisteredJob,
  JOB_CAPABILITY,
  type QueuehouseConfig,
} from "@queuehouse/core";

const queueInstances = new Map<string, Queue>();

function queueCacheKey(prefix: string, queueName: string): string {
  return `${prefix}\0${queueName}`;
}

export function getOrCreateQueue(
  redis: IORedis,
  config: QueuehouseConfig,
  queueName: string,
): Queue {
  const prefix = bullmqPrefix(config.namespace);
  const key = queueCacheKey(prefix, queueName);
  let q = queueInstances.get(key);
  if (!q) {
    q = new Queue(queueName, { connection: redis, prefix });
    queueInstances.set(key, q);
  }
  return q;
}

export type EnqueueAccepted = {
  jobId: string;
  queueName: string;
};

export async function enqueueAuthenticatedJob(
  redis: IORedis,
  config: QueuehouseConfig,
  params: {
    jobName: string;
    payload: unknown;
    requestId: string;
    user: { id: string; role: string };
  },
): Promise<EnqueueAccepted> {
  const job = getRegisteredJob(params.jobName);
  if (!job) {
    const e = new Error("unknown_job") as Error & { code?: string };
    e.code = "unknown_job";
    throw e;
  }
  if (!job.capabilities.includes(JOB_CAPABILITY.ENQUEUE_API)) {
    const e = new Error("enqueue_not_allowed") as Error & { code?: string };
    e.code = "enqueue_not_allowed";
    throw e;
  }
  job.inputSchema.parse(params.payload);

  const queue = getOrCreateQueue(redis, config, job.queue);
  const bullJob = await queue.add(
    params.jobName,
    {
      jobName: params.jobName,
      payload: params.payload,
      requestId: params.requestId,
      enqueuedBy: { userId: params.user.id, role: params.user.role },
    },
    {
      attempts: job.retry.maxAttempts ?? 1,
      backoff: job.retry.backoffMs
        ? { type: "fixed" as const, delay: job.retry.backoffMs }
        : undefined,
      removeOnComplete: { count: 10_000 },
      removeOnFail: false,
    },
  );
  if (bullJob.id === undefined || bullJob.id === null) {
    throw new Error("bullmq_missing_job_id");
  }
  return { jobId: String(bullJob.id), queueName: job.queue };
}

export async function getJobDetail(
  redis: IORedis,
  config: QueuehouseConfig,
  queueName: string,
  jobId: string,
): Promise<{
  jobId: string;
  queueName: string;
  state: string;
  jobName?: string;
  payload: unknown;
  result: unknown;
  failedReason?: string;
  timestamps: { created?: number; processed?: number; finished?: number };
  requestId?: string;
} | null> {
  const queue = getOrCreateQueue(redis, config, queueName);
  const job: Job | undefined = await queue.getJob(jobId);
  if (!job) return null;
  const state = await job.getState();
  const data = job.data as {
    jobName?: string;
    payload?: unknown;
    requestId?: string;
  };
  return {
    jobId: String(job.id),
    queueName,
    state,
    jobName: data.jobName,
    payload: data.payload,
    result: job.returnvalue,
    failedReason: job.failedReason,
    timestamps: {
      created: job.timestamp,
      processed: job.processedOn ?? undefined,
      finished: job.finishedOn ?? undefined,
    },
    requestId: data.requestId,
  };
}

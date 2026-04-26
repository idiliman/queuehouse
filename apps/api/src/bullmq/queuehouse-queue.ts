import { Queue, type Job, type JobType } from "bullmq";
import type IORedis from "ioredis";
import {
  bullmqPrefix,
  getRegisteredJob,
  JOB_CAPABILITY,
  listRegisteredJobs,
  redactObjectAtPaths,
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

const DEFAULT_LIST_JOB_TYPES: JobType[] = [
  "active",
  "completed",
  "delayed",
  "failed",
  "prioritized",
  "waiting",
  "waiting-children",
];

function parseListStates(param: string | undefined): JobType[] | undefined {
  if (!param?.trim()) return undefined;
  const parts = param
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const map: Record<string, JobType | undefined> = {
    active: "active",
    completed: "completed",
    delayed: "delayed",
    failed: "failed",
    paused: "paused",
    prioritized: "prioritized",
    waiting: "waiting",
    "waiting-children": "waiting-children",
  };
  const out: JobType[] = [];
  for (const p of parts) {
    const t = map[p];
    if (t) out.push(t);
  }
  return out.length > 0 ? [...new Set(out)] : undefined;
}

function redactForRegisteredJob(
  jobName: string | undefined,
  payload: unknown,
  result: unknown,
): { payload: unknown; result: unknown } {
  const reg = jobName ? getRegisteredJob(jobName) : undefined;
  const meta = reg?.redaction;
  return {
    payload: redactObjectAtPaths(payload, meta?.payloadPaths),
    result: redactObjectAtPaths(result, meta?.resultPaths),
  };
}

export type ListJobsQuery = {
  /** Limit one queue; when omitted, all registered queues are scanned. */
  queue?: string;
  /** Comma-separated BullMQ list states. */
  state?: string;
  jobName?: string;
  jobId?: string;
  schedulerId?: string;
  from?: number;
  to?: number;
  minAttempts?: number;
  maxAttempts?: number;
  limit: number;
};

export type JobListItem = {
  jobId: string;
  queueName: string;
  state: string;
  jobName?: string;
  created?: number;
  processedOn?: number;
  finishedOn?: number;
  attemptsMade: number;
  maxAttempts?: number;
  priority: number;
  failedReason?: string;
  schedulerId?: string;
};

/**
 * List recent jobs from BullMQ across registered operator queues, with server-side filters.
 * Does not return raw payload (detail page only).
 */
export async function listJobs(
  redis: IORedis,
  config: QueuehouseConfig,
  q: ListJobsQuery,
): Promise<JobListItem[]> {
  const regQueues = new Set<string>();
  for (const j of listRegisteredJobs()) {
    regQueues.add(j.queue);
  }
  const targetQueues: string[] = [];
  if (q.queue?.trim()) {
    if (!regQueues.has(q.queue.trim())) {
      return [];
    }
    targetQueues.push(q.queue.trim());
  } else {
    targetQueues.push(...[...regQueues].sort());
  }

  const types = parseListStates(q.state) ?? DEFAULT_LIST_JOB_TYPES;
  const end = Math.min(499, Math.max(q.limit * 4, q.limit) - 1);
  const collected: Job[] = [];
  for (const queueName of targetQueues) {
    const queue = getOrCreateQueue(redis, config, queueName);
    const batch = await queue.getJobs(types, 0, end, false);
    for (const j of batch) {
      if (j?.id) collected.push(j);
    }
  }

  const seen = new Set<string>();
  const rows: JobListItem[] = [];
  for (const job of collected) {
    const queueName = job.queueName;
    const id = String(job.id);
    const dedupe = `${queueName}\0${id}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    const data = job.data as { jobName?: string };
    const jn = data.jobName;
    if (q.jobName && jn !== q.jobName) continue;
    if (q.jobId && id !== q.jobId) continue;
    if (q.schedulerId && (job.repeatJobKey ?? "") !== q.schedulerId) continue;
    if (q.from != null && job.timestamp < q.from) continue;
    if (q.to != null && job.timestamp > q.to) continue;
    if (q.minAttempts != null && job.attemptsMade < q.minAttempts) continue;
    if (q.maxAttempts != null && job.attemptsMade > q.maxAttempts) continue;
    const state = await job.getState();
    rows.push({
      jobId: id,
      queueName,
      state,
      jobName: jn,
      created: job.timestamp,
      processedOn: job.processedOn ?? undefined,
      finishedOn: job.finishedOn ?? undefined,
      attemptsMade: job.attemptsMade,
      maxAttempts: job.opts?.attempts,
      priority: job.priority,
      failedReason: job.failedReason,
      schedulerId: job.repeatJobKey,
    });
  }

  rows.sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
  return rows.slice(0, q.limit);
}

export type JobDetailResult = {
  jobId: string;
  queueName: string;
  state: string;
  jobName?: string;
  payload: unknown;
  result: unknown;
  failedReason?: string;
  stacktrace?: string[];
  progress: unknown;
  logs: string[];
  metadata: {
    requestId?: string;
    enqueuedBy?: { userId: string; role: string };
    priority: number;
    delay: number;
    attemptsMade: number;
    maxAttempts?: number;
    repeatJobKey?: string;
    deduplicationId?: string;
  };
  timestamps: { created?: number; processed?: number; finished?: number };
  requestId?: string;
};

export async function getJobDetail(
  redis: IORedis,
  config: QueuehouseConfig,
  queueName: string,
  jobId: string,
): Promise<JobDetailResult | null> {
  const queue = getOrCreateQueue(redis, config, queueName);
  const job: Job | undefined = await queue.getJob(jobId);
  if (!job) return null;
  const state = await job.getState();
  const data = job.data as {
    jobName?: string;
    payload?: unknown;
    requestId?: string;
    enqueuedBy?: { userId: string; role: string };
  };
  const { payload: redactedPayload, result: redactedResult } = redactForRegisteredJob(
    data.jobName,
    data.payload,
    job.returnvalue,
  );
  let logs: string[] = [];
  try {
    const logRes = await queue.getJobLogs(jobId, 0, 199, true);
    logs = logRes.logs;
  } catch {
    logs = [];
  }
  return {
    jobId: String(job.id),
    queueName,
    state,
    jobName: data.jobName,
    payload: redactedPayload,
    result: redactedResult,
    failedReason: job.failedReason,
    stacktrace: job.stacktrace ?? undefined,
    progress: job.progress,
    logs,
    metadata: {
      requestId: data.requestId,
      enqueuedBy: data.enqueuedBy,
      priority: job.priority,
      delay: job.delay,
      attemptsMade: job.attemptsMade,
      maxAttempts: job.opts?.attempts,
      repeatJobKey: job.repeatJobKey,
      deduplicationId: job.deduplicationId,
    },
    timestamps: {
      created: job.timestamp,
      processed: job.processedOn ?? undefined,
      finished: job.finishedOn ?? undefined,
    },
    requestId: data.requestId,
  };
}

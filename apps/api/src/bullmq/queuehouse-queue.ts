import { Queue, QueueEvents, type Job, type JobType } from "bullmq";
import type IORedis from "ioredis";
import {
  bullmqPrefix,
  getEffectiveRetryOptions,
  getRegisteredJob,
  JOB_CAPABILITY,
  listRegisteredJobs,
  mergePayloadWithRetryForEnqueue,
  redactObjectAtPaths,
  resolveBullmqRetryForEnqueue,
  splitJobEnqueueBody,
  WORKER_HEARTBEAT_REFRESH_MS,
  workerHeartbeatKeyPattern,
  type QueuehouseConfig,
  type WorkerHeartbeatPayload,
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

async function addQueueJob(
  redis: IORedis,
  config: QueuehouseConfig,
  params: {
    job: { name: string; queue: string };
    payload: unknown;
    eff: { maxAttempts: number; backoffMs?: number };
    requestId: string;
    user: { id: string; role: string };
    retriedAsNewFrom?: { queueName: string; jobId: string };
    /** BullMQ job options: delay (ms from now), custom id, priority (0 = highest). */
    schedule?: { delay?: number; jobId?: string; priority?: number };
  },
): Promise<{ jobId: string; queueName: string; bullJob: Job }> {
  const { job, payload, eff, requestId, user, retriedAsNewFrom, schedule } = params;
  const queue = getOrCreateQueue(redis, config, job.queue);
  const data: {
    jobName: string;
    payload: unknown;
    requestId: string;
    enqueuedBy: { userId: string; role: string };
    retriedAsNewFrom?: { queueName: string; jobId: string };
  } = {
    jobName: job.name,
    payload,
    requestId,
    enqueuedBy: { userId: user.id, role: user.role },
  };
  if (retriedAsNewFrom) {
    data.retriedAsNewFrom = retriedAsNewFrom;
  }
  const addOpts: Parameters<Queue["add"]>[2] = {
    attempts: eff.maxAttempts,
    backoff: eff.backoffMs
      ? { type: "fixed" as const, delay: eff.backoffMs }
      : undefined,
    removeOnComplete: { count: 10_000 },
    removeOnFail: false,
  };
  if (schedule?.delay != null && schedule.delay > 0) {
    addOpts.delay = schedule.delay;
  }
  if (schedule?.jobId) {
    addOpts.jobId = schedule.jobId;
  }
  if (schedule?.priority != null) {
    addOpts.priority = schedule.priority;
  }
  let bullJob: Job;
  try {
    bullJob = await queue.add(job.name, data, addOpts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (schedule?.jobId && /exist|Exist|Duplicate|duplicate|collision/i.test(msg)) {
      const e = new Error("dedupe_job_id_conflict") as Error & { code?: string };
      e.code = "dedupe_job_id_conflict";
      throw e;
    }
    throw err;
  }
  if (bullJob.id === undefined || bullJob.id === null) {
    throw new Error("bullmq_missing_job_id");
  }
  return { jobId: String(bullJob.id), queueName: job.queue, bullJob };
}

export async function enqueueAuthenticatedJob(
  redis: IORedis,
  config: QueuehouseConfig,
  params: {
    jobName: string;
    body: unknown;
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
  const { payload, retryOverride } = splitJobEnqueueBody(job, params.body);
  job.inputSchema.parse(payload);

  const eff = resolveBullmqRetryForEnqueue(job, retryOverride);
  const r = await addQueueJob(redis, config, {
    job: { name: job.name, queue: job.queue },
    payload,
    eff,
    requestId: params.requestId,
    user: params.user,
  });
  return { jobId: r.jobId, queueName: r.queueName };
}

export type ManualEnqueueAccepted = EnqueueAccepted & {
  result?: unknown;
};

/**
 * Admin manual-enqueue path: requires `manual.ui` on the job (not `enqueue.api`).
 * Supports delay, dedupe id, priority, and optional wait-for-completion.
 */
export async function enqueueManualUiJob(
  redis: IORedis,
  config: QueuehouseConfig,
  params: {
    jobName: string;
    body: unknown;
    delayMs: number;
    jobId?: string;
    priority?: number;
    waitTimeoutMs: number;
    requestId: string;
    user: { id: string; role: string };
  },
): Promise<ManualEnqueueAccepted> {
  const job = getRegisteredJob(params.jobName);
  if (!job) {
    const e = new Error("unknown_job") as Error & { code?: string };
    e.code = "unknown_job";
    throw e;
  }
  if (!job.capabilities.includes(JOB_CAPABILITY.MANUAL_UI)) {
    const e = new Error("manual_enqueue_not_allowed") as Error & { code?: string };
    e.code = "manual_enqueue_not_allowed";
    throw e;
  }
  const { payload, retryOverride } = splitJobEnqueueBody(job, params.body);
  job.inputSchema.parse(payload);
  const eff = resolveBullmqRetryForEnqueue(job, retryOverride);
  const schedule: { delay?: number; jobId?: string; priority?: number } = {};
  if (params.delayMs > 0) schedule.delay = params.delayMs;
  if (params.jobId) schedule.jobId = params.jobId;
  if (params.priority != null) schedule.priority = params.priority;

  const prefix = bullmqPrefix(config.namespace);
  const { bullJob, jobId, queueName } = await addQueueJob(redis, config, {
    job: { name: job.name, queue: job.queue },
    payload,
    eff,
    requestId: params.requestId,
    user: params.user,
    schedule,
  });

  if (params.waitTimeoutMs <= 0) {
    return { jobId, queueName };
  }

  const queueEvents = new QueueEvents(job.queue, { connection: redis, prefix });
  try {
    await queueEvents.waitUntilReady();
    let result: unknown;
    try {
      result = await bullJob.waitUntilFinished(queueEvents, params.waitTimeoutMs);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/timed out|timeout/i.test(msg)) {
        const e = new Error("wait_timeout") as Error & { code?: string };
        e.code = "wait_timeout";
        throw e;
      }
      throw err;
    }
    return { jobId, queueName, result };
  } finally {
    await queueEvents.close();
  }
}

/**
 * Enqueue a new job with an optional edited payload, linked to a source failed job (admin recovery).
 * Does not require ENQUEUE_API on the job type.
 */
export async function retryFailedJobAsNew(
  redis: IORedis,
  config: QueuehouseConfig,
  params: {
    sourceQueueName: string;
    sourceJobId: string;
    /**
     * Body from the client. Use `splitJobEnqueueBody`-compatible shape: optional `payload`
     * (omitted or absent key → use source job stored payload) and optional `retry` for overrides.
     */
    body: unknown;
    requestId: string;
    user: { id: string; role: string };
  },
): Promise<
  | EnqueueAccepted
  | { error: "job_not_found" | "forbidden_queue" | "invalid_state" | "unknown_job" }
> {
  const regQueues = new Set(listRegisteredJobs().map((j) => j.queue));
  if (!regQueues.has(params.sourceQueueName)) {
    return { error: "forbidden_queue" };
  }
  const queue = getOrCreateQueue(redis, config, params.sourceQueueName);
  const bull: Job | undefined = await queue.getJob(params.sourceJobId);
  if (!bull) return { error: "job_not_found" };
  const state = await bull.getState();
  if (state !== "failed") {
    return { error: "invalid_state" };
  }
  const sourceData = bull.data as {
    jobName?: string;
    payload?: unknown;
  };
  const jobName = sourceData.jobName;
  if (!jobName) {
    return { error: "invalid_state" };
  }
  const reg = getRegisteredJob(jobName);
  if (!reg) {
    return { error: "unknown_job" };
  }
  const bodyObj = params.body;
  if (bodyObj === null || typeof bodyObj !== "object" || Array.isArray(bodyObj)) {
    const e = new Error("invalid_body") as Error & { code?: string };
    e.code = "invalid_body";
    throw e;
  }
  const rec = bodyObj as Record<string, unknown>;
  const hasPayloadKey = Object.prototype.hasOwnProperty.call(rec, "payload");
  const base = sourceData.payload;
  const chosenPayload = hasPayloadKey
    ? (rec as { payload?: unknown }).payload === undefined
      ? base
      : (rec as { payload: unknown }).payload
    : base;
  const forSplit = mergePayloadWithRetryForEnqueue(chosenPayload, rec.retry);
  const { payload, retryOverride } = splitJobEnqueueBody(reg, forSplit);
  reg.inputSchema.parse(payload);
  const eff = resolveBullmqRetryForEnqueue(reg, retryOverride);
  const r = await addQueueJob(redis, config, {
    job: { name: reg.name, queue: reg.queue },
    payload,
    eff,
    requestId: params.requestId,
    user: params.user,
    retriedAsNewFrom: {
      queueName: params.sourceQueueName,
      jobId: params.sourceJobId,
    },
  });
  return { jobId: r.jobId, queueName: r.queueName };
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
    retriedAsNewFrom?: { queueName: string; jobId: string };
  };
  timestamps: { created?: number; processed?: number; finished?: number };
  requestId?: string;
  /** Registry retry policy for the job type; omitted when `jobName` is unknown. */
  resolvedRetry?: { maxAttempts: number; backoffMs?: number };
};

/**
 * Resolves the registry `jobName` stored in Bull data (for API key allow-list checks).
 */
export async function getBullJobName(
  redis: IORedis,
  config: QueuehouseConfig,
  queueName: string,
  jobId: string,
): Promise<string | undefined> {
  const queue = getOrCreateQueue(redis, config, queueName);
  const job: Job | undefined = await queue.getJob(jobId);
  if (!job) return undefined;
  const data = job.data as { jobName?: string };
  return data.jobName;
}

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
    retriedAsNewFrom?: { queueName: string; jobId: string };
  };
  const { payload: redactedPayload, result: redactedResult } = redactForRegisteredJob(
    data.jobName,
    data.payload,
    job.returnvalue,
  );
  const reg = data.jobName ? getRegisteredJob(data.jobName) : undefined;
  const resolvedRetry = reg ? getEffectiveRetryOptions(reg) : undefined;
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
      retriedAsNewFrom: data.retriedAsNewFrom,
    },
    timestamps: {
      created: job.timestamp,
      processed: job.processedOn ?? undefined,
      finished: job.finishedOn ?? undefined,
    },
    requestId: data.requestId,
    resolvedRetry,
  };
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

async function scanRedisKeys(redis: IORedis, pattern: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [next, batch] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 128);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== "0");
  return keys;
}

function parseWorkerHeartbeatPayload(raw: string): WorkerHeartbeatPayload | null {
  try {
    const o = JSON.parse(raw) as unknown;
    if (typeof o !== "object" || o === null) return null;
    const p = o as Record<string, unknown>;
    if (typeof p.instanceId !== "string" || typeof p.coreVersion !== "string") return null;
    if (!Array.isArray(p.queues) || !p.queues.every((q) => typeof q === "string")) return null;
    if (typeof p.concurrency !== "number" || !Number.isFinite(p.concurrency)) return null;
    if (typeof p.hostname !== "string" || typeof p.pid !== "number") return null;
    if (typeof p.startedAt !== "string") return null;
    return {
      instanceId: p.instanceId,
      coreVersion: p.coreVersion,
      queues: p.queues,
      concurrency: p.concurrency,
      hostname: p.hostname,
      pid: p.pid,
      startedAt: p.startedAt,
    };
  } catch {
    return null;
  }
}

export type QueueOperationalStats = {
  name: string;
  paused: boolean;
  counts: {
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
    paused: number;
  };
};

export type WorkerHeartbeatRow = {
  instanceId: string;
  coreVersion: string;
  queues: string[];
  concurrency: number;
  hostname: string;
  pid: number;
  startedAt: string;
  heartbeatTtlSec: number;
  stale: boolean;
};

export async function listQueueOperationalStats(
  redis: IORedis,
  config: QueuehouseConfig,
): Promise<QueueOperationalStats[]> {
  const names = [...new Set(listRegisteredJobs().map((j) => j.queue))].sort();
  const out: QueueOperationalStats[] = [];
  for (const name of names) {
    const queue = getOrCreateQueue(redis, config, name);
    const [counts, paused] = await Promise.all([queue.getJobCounts(), queue.isPaused()]);
    out.push({
      name,
      paused,
      counts: {
        waiting: counts.waiting,
        active: counts.active,
        completed: counts.completed,
        failed: counts.failed,
        delayed: counts.delayed,
        paused: counts.paused,
      },
    });
  }
  return out;
}

export async function listWorkerHeartbeats(
  redis: IORedis,
  config: QueuehouseConfig,
): Promise<WorkerHeartbeatRow[]> {
  const pattern = workerHeartbeatKeyPattern(config.namespace);
  const keys = await scanRedisKeys(redis, pattern);
  const staleThresholdSec = Math.max(1, Math.ceil(WORKER_HEARTBEAT_REFRESH_MS / 1000));
  const rows: WorkerHeartbeatRow[] = [];
  for (const key of keys) {
    const [raw, ttl] = await Promise.all([redis.get(key), redis.ttl(key)]);
    if (raw == null || ttl == null || ttl < 0) continue;
    const parsed = parseWorkerHeartbeatPayload(raw);
    if (!parsed) continue;
    rows.push({
      instanceId: parsed.instanceId,
      coreVersion: parsed.coreVersion,
      queues: parsed.queues,
      concurrency: parsed.concurrency,
      hostname: parsed.hostname,
      pid: parsed.pid,
      startedAt: parsed.startedAt,
      heartbeatTtlSec: ttl,
      stale: ttl <= staleThresholdSec,
    });
  }
  rows.sort((a, b) => a.instanceId.localeCompare(b.instanceId));
  return rows;
}

export async function listQueuesAndWorkers(
  redis: IORedis,
  config: QueuehouseConfig,
): Promise<{ queues: QueueOperationalStats[]; workers: WorkerHeartbeatRow[] }> {
  const [queues, workers] = await Promise.all([
    listQueueOperationalStats(redis, config),
    listWorkerHeartbeats(redis, config),
  ]);
  return { queues, workers };
}

export async function pauseRegisteredQueue(
  redis: IORedis,
  config: QueuehouseConfig,
  queueName: string,
): Promise<{ ok: true } | { error: "unknown_queue" }> {
  const reg = new Set(listRegisteredJobs().map((j) => j.queue));
  if (!reg.has(queueName)) return { error: "unknown_queue" };
  const queue = getOrCreateQueue(redis, config, queueName);
  await queue.pause();
  return { ok: true };
}

export async function resumeRegisteredQueue(
  redis: IORedis,
  config: QueuehouseConfig,
  queueName: string,
): Promise<{ ok: true } | { error: "unknown_queue" }> {
  const reg = new Set(listRegisteredJobs().map((j) => j.queue));
  if (!reg.has(queueName)) return { error: "unknown_queue" };
  const queue = getOrCreateQueue(redis, config, queueName);
  await queue.resume();
  return { ok: true };
}

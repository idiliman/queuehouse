import {
  QUEUEHOUSE_VERSION,
  listRegisteredJobs,
  type QueuehouseConfig,
} from "@queuehouse/core";
import { prisma } from "@queuehouse/db";
import type IORedis from "ioredis";
import { Counter, Gauge, Histogram, Registry } from "prom-client";
import {
  listQueueOperationalStats,
  listWorkerHeartbeats,
} from "../bullmq/queuehouse-queue";
import { checkPostgres, checkRedis } from "../readyz";

const promRegistry = new Registry();

const buildInfo = new Gauge({
  name: "queuehouse_build_info",
  help: "Queuehouse version and deployment namespace (info metric, value is always 1).",
  labelNames: ["version", "namespace", "service"] as const,
  registers: [promRegistry],
});

const queueJobs = new Gauge({
  name: "queuehouse_queue_jobs",
  help: "BullMQ job counts by registered queue and state.",
  labelNames: ["queue", "state"] as const,
  registers: [promRegistry],
});

const queuePaused = new Gauge({
  name: "queuehouse_queue_paused",
  help: "Whether the queue is paused (1) or not (0).",
  labelNames: ["queue"] as const,
  registers: [promRegistry],
});

const workersAlive = new Gauge({
  name: "queuehouse_worker_heartbeats",
  help: "Number of worker instances that recently published a Redis heartbeat.",
  registers: [promRegistry],
});

const workersSubscribedQueue = new Gauge({
  name: "queuehouse_workers_subscribed_queue",
  help: "Non-stale worker heartbeats that include this registered queue.",
  labelNames: ["queue"] as const,
  registers: [promRegistry],
});

const dependencyUp = new Gauge({
  name: "queuehouse_dependency_up",
  help: "Whether the last dependency probe for Postgres or Redis succeeded (1) or not (0).",
  labelNames: ["dependency"] as const,
  registers: [promRegistry],
});

const registeredJobInfo = new Gauge({
  name: "queuehouse_registered_job_info",
  help: "Registered job types (info metric, value is always 1).",
  labelNames: ["queue", "job"] as const,
  registers: [promRegistry],
});

const schedulesTotal = new Gauge({
  name: "queuehouse_schedules_total",
  help: "Job schedule rows in Postgres.",
  registers: [promRegistry],
});

const schedulesEnabled = new Gauge({
  name: "queuehouse_schedules_enabled",
  help: "Enabled job schedules in Postgres.",
  registers: [promRegistry],
});

const schedulesNeedsReview = new Gauge({
  name: "queuehouse_schedules_needs_review",
  help: "Job schedules flagged for operator review.",
  registers: [promRegistry],
});

const httpRequestDuration = new Histogram({
  name: "queuehouse_http_request_duration_seconds",
  help: "API HTTP request duration in seconds.",
  labelNames: ["method", "route", "status_class"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [promRegistry],
});

const httpRequestsTotal = new Counter({
  name: "queuehouse_http_requests_total",
  help: "API HTTP requests processed.",
  labelNames: ["method", "route", "status_class"] as const,
  registers: [promRegistry],
});

const COUNT_STATES = [
  "waiting",
  "active",
  "completed",
  "failed",
  "delayed",
  "paused",
] as const;

function refreshBuildInfo(cfg: QueuehouseConfig) {
  buildInfo.reset();
  buildInfo.set(
    { version: QUEUEHOUSE_VERSION, namespace: cfg.namespace, service: "api" },
    1,
  );
}

function refreshRegisteredJobInfo() {
  registeredJobInfo.reset();
  for (const j of listRegisteredJobs()) {
    registeredJobInfo.set({ queue: j.queue, job: j.name }, 1);
  }
}

export type HttpRequestStatusClass = "2xx" | "3xx" | "4xx" | "5xx" | "other";

export function recordHttpServerRequest(params: {
  method: string;
  routeTemplate: string;
  statusClass: HttpRequestStatusClass;
  durationSeconds: number;
}): void {
  const method = params.method.toUpperCase();
  const labels = {
    method,
    route: params.routeTemplate,
    status_class: params.statusClass,
  };
  httpRequestDuration.observe(labels, params.durationSeconds);
  httpRequestsTotal.inc(labels);
}

/**
 * Renders Prometheus text exposition for a scrape, refreshing queue/worker gauges from Redis
 * and running lightweight Postgres/Redis probes for readiness-style gauges.
 */
export async function renderPrometheusText(
  redis: IORedis,
  cfg: QueuehouseConfig,
): Promise<string> {
  refreshBuildInfo(cfg);
  refreshRegisteredJobInfo();

  queueJobs.reset();
  queuePaused.reset();
  workersSubscribedQueue.reset();

  const stats = await listQueueOperationalStats(redis, cfg);
  for (const q of stats) {
    queuePaused.set({ queue: q.name }, q.paused ? 1 : 0);
    for (const state of COUNT_STATES) {
      queueJobs.set({ queue: q.name, state }, q.counts[state]);
    }
  }

  const heartbeats = await listWorkerHeartbeats(redis, cfg);
  workersAlive.set(heartbeats.length);

  const regQueues = [...new Set(listRegisteredJobs().map((j) => j.queue))].sort();
  for (const queueName of regQueues) {
    const n = heartbeats.filter((h) => !h.stale && h.queues.includes(queueName)).length;
    workersSubscribedQueue.set({ queue: queueName }, n);
  }

  schedulesTotal.set(0);
  schedulesEnabled.set(0);
  schedulesNeedsReview.set(0);
  if (cfg.databaseUrl) {
    try {
      const [total, enabled, needsReview] = await Promise.all([
        prisma.jobSchedule.count(),
        prisma.jobSchedule.count({ where: { enabled: true } }),
        prisma.jobSchedule.count({ where: { needsReview: true } }),
      ]);
      schedulesTotal.set(total);
      schedulesEnabled.set(enabled);
      schedulesNeedsReview.set(needsReview);
    } catch {
      schedulesTotal.set(0);
      schedulesEnabled.set(0);
      schedulesNeedsReview.set(0);
    }
  }

  dependencyUp.reset();
  if (cfg.databaseUrl) {
    try {
      await checkPostgres(cfg.databaseUrl);
      dependencyUp.set({ dependency: "postgres" }, 1);
    } catch {
      dependencyUp.set({ dependency: "postgres" }, 0);
    }
  } else {
    dependencyUp.set({ dependency: "postgres" }, 0);
  }

  if (cfg.redisUrl) {
    try {
      await checkRedis(cfg.redisUrl);
      dependencyUp.set({ dependency: "redis" }, 1);
    } catch {
      dependencyUp.set({ dependency: "redis" }, 0);
    }
  } else {
    dependencyUp.set({ dependency: "redis" }, 0);
  }

  return promRegistry.metrics();
}

export function prometheusContentType(): string {
  return promRegistry.contentType;
}

import { QUEUEHOUSE_VERSION, type QueuehouseConfig } from "@queuehouse/core";
import type IORedis from "ioredis";
import { Registry, Gauge } from "prom-client";
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

const dependencyUp = new Gauge({
  name: "queuehouse_dependency_up",
  help: "Whether the last dependency probe for Postgres or Redis succeeded (1) or not (0).",
  labelNames: ["dependency"] as const,
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

/**
 * Renders Prometheus text exposition for a scrape, refreshing queue/worker gauges from Redis
 * and running lightweight Postgres/Redis probes for readiness-style gauges.
 */
export async function renderPrometheusText(
  redis: IORedis,
  cfg: QueuehouseConfig,
): Promise<string> {
  refreshBuildInfo(cfg);

  queueJobs.reset();
  queuePaused.reset();

  const stats = await listQueueOperationalStats(redis, cfg);
  for (const q of stats) {
    queuePaused.set({ queue: q.name }, q.paused ? 1 : 0);
    for (const state of COUNT_STATES) {
      queueJobs.set({ queue: q.name, state }, q.counts[state]);
    }
  }

  const heartbeats = await listWorkerHeartbeats(redis, cfg);
  workersAlive.set(heartbeats.length);

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

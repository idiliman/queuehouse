import { QUEUEHOUSE_VERSION, type QueuehouseConfig } from "@queuehouse/core";
import { Counter, Gauge, Histogram, Registry } from "prom-client";

const promRegistry = new Registry();

const buildInfo = new Gauge({
  name: "queuehouse_build_info",
  help: "Queuehouse version and deployment namespace (info metric, value is always 1).",
  labelNames: ["version", "namespace", "service"] as const,
  registers: [promRegistry],
});

const jobProcessingDuration = new Histogram({
  name: "queuehouse_job_processing_duration_seconds",
  help: "Time spent in one worker invocation (success or thrown error before BullMQ retry logic).",
  labelNames: ["queue", "job", "result"] as const,
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 30, 120],
  registers: [promRegistry],
});

const jobProcessingTotal = new Counter({
  name: "queuehouse_job_processing_total",
  help: "Worker job invocations completed (result success) or threw before retry handling (result error).",
  labelNames: ["queue", "job", "result"] as const,
  registers: [promRegistry],
});

const retentionRemovals = new Counter({
  name: "queuehouse_retention_removals_total",
  help: "Jobs removed by the queuehouse.retention_cleanup system job (Bull queue.clean).",
  labelNames: ["kind"] as const,
  registers: [promRegistry],
});

export type JobProcessingResult = "success" | "error";

export function recordRetentionRemovals(removedCompleted: number, removedFailed: number): void {
  if (removedCompleted > 0) {
    retentionRemovals.inc({ kind: "completed" }, removedCompleted);
  }
  if (removedFailed > 0) {
    retentionRemovals.inc({ kind: "failed" }, removedFailed);
  }
}

export function recordJobProcessing(params: {
  queue: string;
  jobName: string;
  durationSeconds: number;
  result: JobProcessingResult;
}): void {
  const labels = {
    queue: params.queue,
    job: params.jobName,
    result: params.result,
  };
  jobProcessingDuration.observe(labels, params.durationSeconds);
  jobProcessingTotal.inc(labels);
}

export async function renderWorkerPrometheusText(cfg: QueuehouseConfig): Promise<string> {
  buildInfo.reset();
  buildInfo.set(
    { version: QUEUEHOUSE_VERSION, namespace: cfg.namespace, service: "worker" },
    1,
  );
  return promRegistry.metrics();
}

export function workerPrometheusContentType(): string {
  return promRegistry.contentType;
}

/** Test helper: reset sample counts between tests. */
export function resetWorkerMetricsForTests(): void {
  promRegistry.resetMetrics();
}

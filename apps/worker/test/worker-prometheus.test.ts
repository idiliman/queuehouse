import { describe, expect, it, beforeEach } from "bun:test";
import { loadConfig } from "@queuehouse/core";
import {
  recordJobProcessing,
  renderWorkerPrometheusText,
  resetWorkerMetricsForTests,
} from "../src/worker-prometheus";

describe("worker prometheus", () => {
  const cfg = loadConfig({ NODE_ENV: "test", REDIS_URL: "redis://localhost:6379" } as Record<
    string,
    string | undefined
  >, {
    requireDatabaseUrl: false,
    requireSessionSecret: false,
  });

  beforeEach(() => {
    resetWorkerMetricsForTests();
  });

  it("exposes job processing histogram and counter with bounded labels", async () => {
    recordJobProcessing({
      queue: "default",
      jobName: "example.success",
      durationSeconds: 0.012,
      result: "success",
    });
    recordJobProcessing({
      queue: "default",
      jobName: "example.fail",
      durationSeconds: 0.05,
      result: "error",
    });

    const body = await renderWorkerPrometheusText(cfg);
    expect(body).toContain("queuehouse_job_processing_duration_seconds");
    expect(body).toContain("queuehouse_job_processing_total");
    expect(body).toContain('queue="default"');
    expect(body).toContain('job="example.success"');
    expect(body).toContain('job="example.fail"');
    expect(body).toContain('result="success"');
    expect(body).toContain('result="error"');
    expect(body).toContain('service="worker"');
  });
});

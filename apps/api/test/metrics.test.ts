import "./test-setup";
import { QUEUEHOUSE_VERSION } from "@queuehouse/core";
import { describe, expect, it } from "bun:test";
import app from "../src/server";

describe("GET /metrics", () => {
  it("returns Prometheus text with queue, worker, dependency, schedule, registry, and HTTP series", async () => {
    await app.request("/healthz");
    const res = await app.request("/metrics");
    expect(res.status).toBe(200);
    const ct = res.headers.get("Content-Type") ?? "";
    expect(ct).toContain("text/plain");

    const body = await res.text();
    expect(body).toContain(`version="${QUEUEHOUSE_VERSION}"`);
    expect(body).toContain("queuehouse_build_info");
    expect(body).toContain("queuehouse_queue_jobs");
    expect(body).toContain('state="failed"');
    expect(body).toContain("queuehouse_queue_paused");
    expect(body).toContain("queuehouse_worker_heartbeats");
    expect(body).toContain("queuehouse_workers_subscribed_queue");
    expect(body).toContain("queuehouse_dependency_up");
    expect(body).toContain('dependency="postgres"');
    expect(body).toContain('dependency="redis"');
    expect(body).toContain("queuehouse_registered_job_info");
    expect(body).toContain("queuehouse_schedules_total");
    expect(body).toContain("queuehouse_schedules_enabled");
    expect(body).toContain("queuehouse_schedules_needs_review");
    expect(body).toContain("queuehouse_http_request_duration_seconds");
    expect(body).toContain("queuehouse_http_requests_total");
    expect(body).toContain('route="/healthz"');
  });
});

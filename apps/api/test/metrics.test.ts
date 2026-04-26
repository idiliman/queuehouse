import "./test-setup";
import { describe, expect, it } from "bun:test";
import app from "../src/server";

describe("GET /metrics", () => {
  it("returns Prometheus text with queue, worker, and dependency series", async () => {
    const res = await app.request("/metrics");
    expect(res.status).toBe(200);
    const ct = res.headers.get("Content-Type") ?? "";
    expect(ct).toContain("text/plain");
    expect(ct).toContain("version=0.0.4");

    const body = await res.text();
    expect(body).toContain("queuehouse_build_info");
    expect(body).toContain("queuehouse_queue_jobs");
    expect(body).toContain('state="failed"');
    expect(body).toContain("queuehouse_queue_paused");
    expect(body).toContain("queuehouse_worker_heartbeats");
    expect(body).toContain("queuehouse_dependency_up");
    expect(body).toContain('dependency="postgres"');
    expect(body).toContain('dependency="redis"');
  });
});

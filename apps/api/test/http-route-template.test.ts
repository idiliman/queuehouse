import { describe, expect, it } from "bun:test";
import { httpRouteTemplate, httpStatusClass } from "../src/metrics/http-route-template";

describe("httpRouteTemplate", () => {
  it("normalizes dynamic API segments", () => {
    expect(httpRouteTemplate("/api/v1/jobs/q/abc/retry")).toBe(
      "/api/v1/jobs/:queueName/:jobId/retry",
    );
    expect(httpRouteTemplate("/api/v1/jobs/q/abc/raw-reveal")).toBe(
      "/api/v1/jobs/:queueName/:jobId/raw-reveal",
    );
    expect(httpRouteTemplate("/api/v1/queues/foo/pause")).toBe(
      "/api/v1/queues/:queueName/pause",
    );
    expect(httpRouteTemplate("/api/v1/schedules/clxyz123")).toBe("/api/v1/schedules/:id");
  });

  it("leaves static paths unchanged", () => {
    expect(httpRouteTemplate("/healthz")).toBe("/healthz");
    expect(httpRouteTemplate("/api/v1/jobs")).toBe("/api/v1/jobs");
  });
});

describe("httpStatusClass", () => {
  it("buckets status codes", () => {
    expect(httpStatusClass(200)).toBe("2xx");
    expect(httpStatusClass(404)).toBe("4xx");
    expect(httpStatusClass(503)).toBe("5xx");
  });
});

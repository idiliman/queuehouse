import "./test-setup";
import { describe, expect, it } from "bun:test";
import app from "../src/server";

describe("API health", () => {
  it("GET /healthz returns ok with namespace", async () => {
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      service: string;
      version: string;
      namespace: string;
    };
    expect(body.status).toBe("ok");
    expect(body.service).toBe("queuehouse-api");
    expect(body.version).toBeDefined();
    expect(body.namespace).toBe("queuehouse");
  });

  it("GET /health remains an alias for /healthz", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const h = (await res.json()) as { status: string };
    expect(h.status).toBe("ok");
  });

  it("generates and returns X-Request-Id when missing", async () => {
    const res = await app.request("/healthz");
    const id = res.headers.get("X-Request-Id");
    expect(id).toBeTruthy();
    expect(id!.length).toBeGreaterThan(4);
  });

  it("echoes incoming X-Request-Id", async () => {
    const res = await app.request("/healthz", {
      headers: { "X-Request-Id": "req_test_123" },
    });
    expect(res.headers.get("X-Request-Id")).toBe("req_test_123");
  });
});

describe("API readyz", () => {
  it("returns 503 when Redis is unreachable", async () => {
    const prev = process.env.REDIS_URL;
    process.env.REDIS_URL = "redis://127.0.0.1:1";
    try {
      const res = await app.request("/readyz");
      expect(res.status).toBe(503);
      const body = (await res.json()) as { status: string };
      expect(body.status).toBe("not_ready");
    } finally {
      process.env.REDIS_URL = prev;
    }
  });

  it("returns 503 when Postgres is unreachable", async () => {
    const prev = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgresql://nope:nope@127.0.0.1:1/nope";
    try {
      const res = await app.request("/readyz");
      expect(res.status).toBe(503);
      const body = (await res.json()) as { status: string };
      expect(body.status).toBe("not_ready");
    } finally {
      process.env.DATABASE_URL = prev;
    }
  });
});

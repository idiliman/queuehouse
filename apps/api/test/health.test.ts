import { describe, expect, it } from "bun:test";
import app from "../src/server";

describe("API health", () => {
  it("GET /health returns ok", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      service: string;
      version: string;
    };
    expect(body.status).toBe("ok");
    expect(body.service).toBe("queuehouse-api");
    expect(body.version).toBeDefined();
  });
});

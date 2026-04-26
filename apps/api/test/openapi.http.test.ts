import "./test-setup";
import { describe, expect, it } from "bun:test";
import app from "../src/server";

describe("OpenAPI and Scalar (auth)", () => {
  it("GET /api/v1/openapi.json returns 401 when unauthenticated", async () => {
    const res = await app.request("/api/v1/openapi.json");
    expect(res.status).toBe(401);
  });

  it("GET /api/v1/docs returns 401 when unauthenticated", async () => {
    const res = await app.request("/api/v1/docs");
    expect(res.status).toBe(401);
  });
});

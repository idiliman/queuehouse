import { describe, expect, it } from "bun:test";
import { redactObjectAtPaths } from "../../src/jobs/redaction";

describe("redactObjectAtPaths", () => {
  it("redacts top-level and nested keys", () => {
    const out = redactObjectAtPaths(
      { message: "x", a: { b: 1, email: "e@x.com" } },
      ["message", "a.email"],
    ) as { message: string; a: { b: number; email: string } };
    expect(out.message).toBe("[REDACTED]");
    expect(out.a.b).toBe(1);
    expect(out.a.email).toBe("[REDACTED]");
  });

  it("is a no-op for empty or missing paths", () => {
    const o = { x: 1 };
    expect(redactObjectAtPaths(o, [])).toEqual({ x: 1 });
    expect(redactObjectAtPaths(o, undefined)).toEqual({ x: 1 });
  });
});

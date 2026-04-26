import { describe, expect, it } from "bun:test";
import { QUEUEHOUSE_VERSION } from "../src/index";

describe("@queuehouse/core", () => {
  it("exposes a version string", () => {
    expect(typeof QUEUEHOUSE_VERSION).toBe("string");
    expect(QUEUEHOUSE_VERSION.length).toBeGreaterThan(0);
  });
});

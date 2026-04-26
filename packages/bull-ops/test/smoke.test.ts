import { describe, expect, it } from "bun:test";
import { getOrCreateQueue } from "../src/index";

describe("@queuehouse/bull-ops", () => {
  it("exports getOrCreateQueue", () => {
    expect(typeof getOrCreateQueue).toBe("function");
  });
});

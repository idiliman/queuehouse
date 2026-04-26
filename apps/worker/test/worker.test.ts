import { describe, expect, it } from "bun:test";
import { QUEUEHOUSE_VERSION } from "@queuehouse/core";

describe("@queuehouse/worker", () => {
  it("links core version constant", () => {
    expect(QUEUEHOUSE_VERSION).toBeDefined();
  });
});

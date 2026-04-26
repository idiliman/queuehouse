import { describe, expect, it } from "bun:test";
import { createQueuehouseClient } from "../src/index";

describe("@queuehouse/client", () => {
  it("createQueuehouseClient returns config", () => {
    const c = createQueuehouseClient({ baseUrl: "http://localhost:3000" });
    expect(c.baseUrl).toBe("http://localhost:3000");
  });
});

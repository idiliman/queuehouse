import { describe, expect, it, beforeEach } from "bun:test";
import { z } from "zod";
import {
  clearJobRegistryForTests,
  defineJob,
  getEffectiveRetryOptions,
  getRegisteredJob,
  JOB_CAPABILITY,
  registerExampleJobs,
  registerJob,
} from "../../src/jobs";

beforeEach(() => {
  clearJobRegistryForTests();
  registerExampleJobs();
});

describe("getEffectiveRetryOptions", () => {
  it("uses registry maxAttempts and backoff for example.success", () => {
    const j = getRegisteredJob("example.success");
    expect(j).toBeDefined();
    expect(getEffectiveRetryOptions(j!)).toEqual({ maxAttempts: 3, backoffMs: 500 });
  });

  it("defaults maxAttempts to 1 when not set on defineJob", () => {
    clearJobRegistryForTests();
    const j = defineJob({
      name: "retry.default.test",
      schemaVersion: 1,
      queue: "q:r",
      capabilities: [JOB_CAPABILITY.ENQUEUE_INTERNAL],
      input: z.object({}),
      output: z.object({}),
    });
    registerJob(j);
    expect(getEffectiveRetryOptions(j).maxAttempts).toBe(1);
  });
});

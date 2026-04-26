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
  resolveBullmqRetryForEnqueue,
  splitJobEnqueueBody,
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

describe("splitJobEnqueueBody + resolveBullmqRetryForEnqueue", () => {
  it("strips retry from payload when overrides are configured", () => {
    const j = getRegisteredJob("example.success")!;
    const { payload, retryOverride } = splitJobEnqueueBody(j, {
      message: "hi",
      retry: { maxAttempts: 2 },
    });
    expect(payload).toEqual({ message: "hi" });
    expect(retryOverride).toEqual({ maxAttempts: 2 });
    expect(resolveBullmqRetryForEnqueue(j, retryOverride)).toEqual({
      maxAttempts: 2,
      backoffMs: 500,
    });
  });

  it("rejects retry when job does not allow overrides", () => {
    const j = getRegisteredJob("example.deprecated")!;
    expect(() =>
      splitJobEnqueueBody(j, { legacy: true, retry: { maxAttempts: 1 } }),
    ).toThrow();
  });

  it("rejects out-of-range maxAttempts", () => {
    const j = getRegisteredJob("example.dlq")!;
    expect(() => resolveBullmqRetryForEnqueue(j, { maxAttempts: 99 })).toThrow();
  });
});

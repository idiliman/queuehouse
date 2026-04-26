import { describe, expect, it } from "bun:test";
import { z } from "zod";
import {
  clearJobRegistryForTests,
  defineJob,
  registerJob,
  JOB_CAPABILITY,
} from "../../src/jobs";

describe("job definition validation", () => {
  it("rejects invalid job names", () => {
    clearJobRegistryForTests();
    const j = defineJob({
      name: "BadName",
      schemaVersion: 1,
      queue: "q:t",
      capabilities: [],
      input: z.object({}),
      output: z.object({}),
    });
    expect(() => registerJob(j)).toThrow(/Invalid job name/);
  });

  it("rejects schemaVersion below 1", () => {
    const j = defineJob({
      name: "bad.version",
      schemaVersion: 0,
      queue: "q:t",
      capabilities: [],
      input: z.object({}),
      output: z.object({}),
    });
    clearJobRegistryForTests();
    expect(() => registerJob(j)).toThrow(/schemaVersion/);
  });

  it("rejects invalid retry maxAttempts", () => {
    const j = defineJob({
      name: "bad.retry",
      schemaVersion: 1,
      queue: "q:t",
      capabilities: [JOB_CAPABILITY.ENQUEUE_INTERNAL],
      input: z.object({}),
      output: z.object({}),
      retry: { maxAttempts: 0 },
    });
    clearJobRegistryForTests();
    expect(() => registerJob(j)).toThrow(/maxAttempts/);
  });

  it("rejects empty queue", () => {
    const j = defineJob({
      name: "bad.queue",
      schemaVersion: 1,
      queue: "  ",
      capabilities: [],
      input: z.object({}),
      output: z.object({}),
    });
    clearJobRegistryForTests();
    expect(() => registerJob(j)).toThrow(/Invalid queue/);
  });
});

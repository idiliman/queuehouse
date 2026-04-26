import { describe, expect, it, beforeEach } from "bun:test";
import { z } from "zod";
import {
  clearJobRegistryForTests,
  defineJob,
  getRegisteredJob,
  JOB_CAPABILITY,
  listRegisteredJobs,
  registerExampleJobs,
  registerJob,
} from "../../src/jobs";

beforeEach(() => {
  clearJobRegistryForTests();
  registerExampleJobs();
});

describe("job registry", () => {
  it("rejects duplicate job names", () => {
    clearJobRegistryForTests();
    const j = defineJob({
      name: "dup.test",
      schemaVersion: 1,
      queue: "q:test",
      capabilities: [JOB_CAPABILITY.ENQUEUE_INTERNAL],
      input: z.object({}),
      output: z.object({}),
    });
    registerJob(j);
    expect(() => registerJob(j)).toThrow(/Duplicate job name/);
  });

  it("lists jobs in stable sorted order", () => {
    const names = listRegisteredJobs().map((j) => j.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(names).toEqual([
      "example.deprecated",
      "example.fail",
      "example.progress",
      "example.success",
    ]);
  });

  it("exposes lookup metadata for example.success", () => {
    const j = getRegisteredJob("example.success");
    expect(j).toBeDefined();
    expect(j!.queue).toBe("queuehouse:example");
    expect(j!.schemaVersion).toBe(1);
    expect(j!.timeoutMs).toBe(30_000);
    expect(j!.retry.maxAttempts).toBe(3);
    expect(j!.retry.backoffMs).toBe(500);
    expect(j!.capabilities).toContain(JOB_CAPABILITY.ENQUEUE_API);
    expect(j!.capabilities).toContain(JOB_CAPABILITY.MANUAL_UI);
    expect(j!.redaction.payloadPaths).toContain("message");
  });
});

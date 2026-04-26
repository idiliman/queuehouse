import { beforeEach, describe, expect, it } from "bun:test";
import {
  clearJobRegistryForTests,
  exampleSuccessJob,
  registerExampleJobs,
} from "../../src/jobs";
import { runJobFromQueueData } from "../../src/jobs/queue-data";

beforeEach(() => {
  clearJobRegistryForTests();
  registerExampleJobs();
});

describe("runJobFromQueueData", () => {
  it("runs example.success and returns validated output", () => {
    const out = runJobFromQueueData({
      jobName: exampleSuccessJob.name,
      payload: { message: "hello" },
      requestId: "req_1",
    });
    expect(out).toEqual({ echoed: "hello" });
  });

  it("allows retriedAsNewFrom metadata on the envelope", () => {
    const out = runJobFromQueueData({
      jobName: exampleSuccessJob.name,
      payload: { message: "hello" },
      retriedAsNewFrom: { queueName: "queuehouse-example", jobId: "99" },
    });
    expect(out).toEqual({ echoed: "hello" });
  });

  it("accepts schedule-sourced run metadata on the envelope", () => {
    const out = runJobFromQueueData({
      jobName: exampleSuccessJob.name,
      payload: { message: "hi" },
      requestId: "schedule:clxyz",
      source: "schedule",
      scheduleId: "clxyz",
    });
    expect(out).toEqual({ echoed: "hi" });
  });

  it("rejects unknown job names", () => {
    expect(() =>
      runJobFromQueueData({
        jobName: "nope.missing",
        payload: {},
      }),
    ).toThrow(/Unknown job/);
  });

  it("rejects malformed envelopes", () => {
    expect(() => runJobFromQueueData({})).toThrow();
  });
});

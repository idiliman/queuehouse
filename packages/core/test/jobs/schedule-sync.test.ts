import { describe, expect, it } from "bun:test";
import {
  getJobScheduleSyncBlocker,
  JOB_SCHEDULE_SYNC_BLOCKER,
} from "../../src/jobs/schedule-sync";

describe("getJobScheduleSyncBlocker", () => {
  it("returns null for a valid schedulable row", () => {
    expect(
      getJobScheduleSyncBlocker({
        jobName: "example.success",
        schemaVersion: 1,
        payload: { message: "ok" },
        retryOverride: null,
      }),
    ).toBeNull();
  });

  it("flags schema version mismatch", () => {
    expect(
      getJobScheduleSyncBlocker({
        jobName: "example.success",
        schemaVersion: 99,
        payload: { message: "ok" },
        retryOverride: null,
      }),
    ).toBe(JOB_SCHEDULE_SYNC_BLOCKER.SCHEMA_VERSION_MISMATCH);
  });

  it("flags invalid payload for current schema", () => {
    expect(
      getJobScheduleSyncBlocker({
        jobName: "example.success",
        schemaVersion: 1,
        payload: { message: "" },
        retryOverride: null,
      }),
    ).toBe(JOB_SCHEDULE_SYNC_BLOCKER.INVALID_PAYLOAD);
  });

  it("flags unknown job", () => {
    expect(
      getJobScheduleSyncBlocker({
        jobName: "no.such.job",
        schemaVersion: 1,
        payload: {},
        retryOverride: null,
      }),
    ).toBe(JOB_SCHEDULE_SYNC_BLOCKER.UNKNOWN_JOB);
  });
});

import { ZodError } from "zod";
import { mergePayloadWithRetryForEnqueue } from "./manual-enqueue";
import { resolveBullmqRetryForEnqueue, splitJobEnqueueBody } from "./retry-options";
import { getRegisteredJob } from "./registry";
import { JOB_CAPABILITY } from "./types";

export const JOB_SCHEDULE_SYNC_BLOCKER = {
  UNKNOWN_JOB: "unknown_job",
  JOB_NOT_SCHEDULABLE: "job_not_schedulable",
  SCHEMA_VERSION_MISMATCH: "schema_version_mismatch",
  INVALID_PAYLOAD: "invalid_payload",
} as const;

export type JobScheduleSyncBlocker =
  (typeof JOB_SCHEDULE_SYNC_BLOCKER)[keyof typeof JOB_SCHEDULE_SYNC_BLOCKER];

export type JobScheduleSyncInput = {
  jobName: string;
  schemaVersion: number;
  payload: unknown;
  /** DB column `retryOverride`; null/undefined treated like absent. */
  retryOverride: unknown;
};

/** Returns a blocker code when this row must not run in BullMQ until an admin fixes it. */
export function getJobScheduleSyncBlocker(row: JobScheduleSyncInput): JobScheduleSyncBlocker | null {
  const job = getRegisteredJob(row.jobName);
  if (!job) {
    return JOB_SCHEDULE_SYNC_BLOCKER.UNKNOWN_JOB;
  }
  if (!job.capabilities.includes(JOB_CAPABILITY.SCHEDULABLE)) {
    return JOB_SCHEDULE_SYNC_BLOCKER.JOB_NOT_SCHEDULABLE;
  }
  if (row.schemaVersion !== job.schemaVersion) {
    return JOB_SCHEDULE_SYNC_BLOCKER.SCHEMA_VERSION_MISMATCH;
  }
  try {
    const override =
      row.retryOverride === null || row.retryOverride === undefined ? undefined : row.retryOverride;
    const merged = mergePayloadWithRetryForEnqueue(row.payload, override);
    const { payload: pl, retryOverride } = splitJobEnqueueBody(job, merged);
    job.inputSchema.parse(pl);
    resolveBullmqRetryForEnqueue(job, retryOverride);
  } catch (err) {
    if (err instanceof ZodError) {
      return JOB_SCHEDULE_SYNC_BLOCKER.INVALID_PAYLOAD;
    }
    const code = (err as { code?: string }).code;
    if (
      code === "retry_with_non_object_payload" ||
      code === "retry_override_not_allowed" ||
      code === "retry_override_invalid" ||
      code === "retry_override_out_of_range"
    ) {
      return JOB_SCHEDULE_SYNC_BLOCKER.INVALID_PAYLOAD;
    }
    return JOB_SCHEDULE_SYNC_BLOCKER.INVALID_PAYLOAD;
  }
  return null;
}

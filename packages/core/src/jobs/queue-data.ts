import { z } from "zod";
import { runExampleJobSync } from "./example-runtime";
import { getRegisteredJob } from "./registry";

/** Payload stored on each BullMQ job and read by workers. */
export const queueJobDataSchema = z.object({
  jobName: z.string().min(1),
  payload: z.unknown(),
  requestId: z.string().optional(),
  enqueuedBy: z
    .object({
      userId: z.string(),
      role: z.string(),
    })
    .optional(),
  /** How the run was enqueued; omitted on legacy jobs. */
  source: z.enum(["api", "ui", "schedule", "system"]).optional(),
  /** Stable JobSchedule id when `source` is `schedule`. */
  scheduleId: z.string().min(1).optional(),
  /** Set when an admin enqueues a replacement job from a failed job (DLQ recovery). */
  retriedAsNewFrom: z
    .object({
      queueName: z.string().min(1),
      jobId: z.string().min(1),
    })
    .optional(),
});

export type QueueJobData = z.infer<typeof queueJobDataSchema>;

/**
 * Parse queue payload and run the registered processor synchronously.
 * Used by BullMQ workers; throws on invalid data or processor failure.
 */
export function runJobFromQueueData(raw: unknown): unknown {
  const data = queueJobDataSchema.parse(raw);
  const job = getRegisteredJob(data.jobName);
  if (!job) {
    throw new Error(`Unknown job: ${data.jobName}`);
  }
  return runExampleJobSync(job, data.payload);
}

export function bullmqPrefix(namespace: string): string {
  const ns = namespace.trim() || "queuehouse";
  return `${ns}:qh`;
}

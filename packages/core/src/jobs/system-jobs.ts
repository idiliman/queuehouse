import { z } from "zod";
import { defineJob } from "./defineJob";
import { JOB_CAPABILITY } from "./types";

export const BULK_DLQ_MAX_TARGETS = 500;

const systemQueue = "queuehouse-system";

/** System-only bulk DLQ recovery (enqueued with ENQUEUE_INTERNAL). */
export const queuehouseBulkDlqJob = defineJob({
  name: "queuehouse.bulk_dlq",
  schemaVersion: 1,
  queue: systemQueue,
  capabilities: [JOB_CAPABILITY.ENQUEUE_INTERNAL],
  input: z.object({
    action: z.enum(["retry", "remove"]),
    targets: z
      .array(
        z.object({
          queueName: z.string().min(1),
          jobId: z.string().min(1),
        }),
      )
      .min(1)
      .max(BULK_DLQ_MAX_TARGETS),
    bulkRequestId: z.string().min(1).optional(),
  }),
  output: z.object({
    requested: z.number().int().nonnegative(),
    executed: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }),
  retry: { maxAttempts: 1, backoffMs: 1_000 },
  timeoutMs: 600_000,
  redaction: {},
  description: "Applies admin bulk DLQ actions (retry in place or remove) for explicit failed job ids.",
});

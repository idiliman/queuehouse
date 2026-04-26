import { runBulkDlqOperation } from "@queuehouse/bull-ops";
import {
  AUDIT_ACTION,
  getRegisteredJob,
  runJobFromQueueData,
  type QueuehouseConfig,
} from "@queuehouse/core";
import { appendAuditLogBestEffort } from "@queuehouse/db";
import type { Job } from "bullmq";
import type IORedis from "ioredis";

type QueueJobEnvelope = {
  jobName?: string;
  payload?: unknown;
  requestId?: string;
  enqueuedBy?: { userId: string; role: string };
};

export function createBullJobProcessor(redis: IORedis, config: QueuehouseConfig) {
  return async (job: Job): Promise<unknown> => {
    const data = job.data as QueueJobEnvelope;
    if (data.jobName === "queuehouse.bulk_dlq") {
      const reg = getRegisteredJob("queuehouse.bulk_dlq");
      if (!reg) {
        throw new Error("queuehouse.bulk_dlq not registered");
      }
      const payload = reg.inputSchema.parse(data.payload);
      const out = await runBulkDlqOperation(redis, config, payload, (current, total) =>
        job.updateProgress({ current, total }),
      );
      const parsed = reg.outputSchema.parse(out);
      const userId = data.enqueuedBy?.userId;
      const requestId = data.requestId;
      if (userId && requestId) {
        await appendAuditLogBestEffort({
          requestId,
          userId,
          action: AUDIT_ACTION.BULK_DLQ_COMPLETE,
          summary: {
            action: payload.action,
            requested: parsed.requested,
            executed: parsed.executed,
            skipped: parsed.skipped,
            failed: parsed.failed,
            systemJobId: String(job.id),
            systemQueueName: job.queueName ?? "queuehouse-system",
            bulkRequestId: payload.bulkRequestId ?? null,
          },
          result: "SUCCESS",
        });
      }
      return parsed;
    }
    return runJobFromQueueData(job.data);
  };
}

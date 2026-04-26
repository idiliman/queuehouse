import { runBulkDlqOperation, runRetentionCleanup } from "@queuehouse/bull-ops";
import {
  AUDIT_ACTION,
  getRegisteredJob,
  runJobFromQueueData,
  runWithJobTraceContext,
  structuredLog,
  type QueuehouseConfig,
} from "@queuehouse/core";
import { appendAuditLogBestEffort } from "@queuehouse/db";
import type { Job } from "bullmq";
import type IORedis from "ioredis";
import { isQueuehouseOtlpTracingEnabled } from "./otel/register-tracing";
import { recordRetentionRemovals } from "./worker-prometheus";

type QueueJobEnvelope = {
  jobName?: string;
  payload?: unknown;
  requestId?: string;
  enqueuedBy?: { userId: string; role: string };
  source?: "api" | "ui" | "schedule" | "system";
  scheduleId?: string;
};

export function createBullJobProcessor(redis: IORedis, config: QueuehouseConfig) {
  return async (job: Job): Promise<unknown> => {
    const run = async (): Promise<unknown> => {
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
      if (data.jobName === "queuehouse.retention_cleanup") {
        const reg = getRegisteredJob("queuehouse.retention_cleanup");
        if (!reg) {
          throw new Error("queuehouse.retention_cleanup not registered");
        }
        reg.inputSchema.parse(data.payload);
        const out = await runRetentionCleanup(redis, config, (current, cap) =>
          job.updateProgress({ current, cap }),
        );
        if (out.removedCompleted + out.removedFailed > 0) {
          recordRetentionRemovals(out.removedCompleted, out.removedFailed);
        }
        if (config.nodeEnv === "production") {
          structuredLog(config, "queuehouse-worker", "info", "retention_cleanup_done", {
            requestId: data.requestId,
            removedCompleted: out.removedCompleted,
            removedFailed: out.removedFailed,
            stoppedDueToCap: out.stoppedDueToCap,
            systemJobId: String(job.id),
            scheduleId: data.source === "schedule" ? data.scheduleId : undefined,
            actor: data.enqueuedBy ? `${data.enqueuedBy.role}:${data.enqueuedBy.userId}` : "schedule",
          });
        }
        const userId = data.enqueuedBy?.userId;
        const requestId = data.requestId;
        if (userId && requestId) {
          await appendAuditLogBestEffort({
            requestId,
            userId,
            action: AUDIT_ACTION.RETENTION_CLEANUP_COMPLETE,
            summary: {
              removedCompleted: out.removedCompleted,
              removedFailed: out.removedFailed,
              stoppedDueToCap: out.stoppedDueToCap,
              systemJobId: String(job.id),
              systemQueueName: job.queueName ?? "queuehouse-system",
            },
            result: "SUCCESS",
          });
        }
        return reg.outputSchema.parse(out);
      }
      return runJobFromQueueData(job.data);
    };

    if (isQueuehouseOtlpTracingEnabled()) {
      return runWithJobTraceContext(job.data, "queuehouse.job.run", run);
    }
    return run();
  };
}

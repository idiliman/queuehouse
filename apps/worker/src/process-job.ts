import { getRegisteredJob, runJobFromQueueData, type QueuehouseConfig } from "@queuehouse/core";
import { runBulkDlqOperation } from "@queuehouse/bull-ops";
import type { Job } from "bullmq";
import type IORedis from "ioredis";

export function createBullJobProcessor(redis: IORedis, config: QueuehouseConfig) {
  return async (job: Job): Promise<unknown> => {
    const data = job.data as { jobName?: string; payload?: unknown };
    if (data.jobName === "queuehouse.bulk_dlq") {
      const reg = getRegisteredJob("queuehouse.bulk_dlq");
      if (!reg) {
        throw new Error("queuehouse.bulk_dlq not registered");
      }
      const payload = reg.inputSchema.parse(data.payload);
      const out = await runBulkDlqOperation(redis, config, payload, (current, total) =>
        job.updateProgress({ current, total }),
      );
      return reg.outputSchema.parse(out);
    }
    return runJobFromQueueData(job.data);
  };
}

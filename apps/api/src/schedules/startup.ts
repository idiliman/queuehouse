import { prisma } from "@queuehouse/db";
import { getQueuehouseRedis } from "../bullmq/redis";
import { reconcileAllEnabledJobSchedules } from "../bullmq/job-schedules";
import { config } from "../config";

/** Load enabled schedules from Postgres and upsert into BullMQ (API startup). */
export async function runScheduleStartupReconciliation(): Promise<void> {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl?.trim()) {
    return;
  }
  const rows = await prisma.jobSchedule.findMany({ where: { enabled: true } });
  if (rows.length === 0) {
    return;
  }
  const redis = getQueuehouseRedis(config);
  try {
    await reconcileAllEnabledJobSchedules(redis, config, rows);
  } finally {
    /* queue redis is shared singleton — do not quit here */
  }
}

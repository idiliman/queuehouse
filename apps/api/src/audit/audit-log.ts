import type { Prisma } from "@prisma/client";
import type { Context } from "hono";
import { prisma } from "@queuehouse/db";
import type { ApiVariables } from "../api-types";

export const AUDIT_ACTION = {
  JOB_ENQUEUE: "job.enqueue",
  JOB_RETRY: "job.retry",
  JOB_RETRY_AS_NEW: "job.retry_as_new",
  JOB_REMOVE: "job.remove",
  API_KEY_CREATE: "api_key.create",
  API_KEY_REVOKE: "api_key.revoke",
  SCHEDULE_CREATE: "schedule.create",
  SCHEDULE_UPDATE: "schedule.update",
  SCHEDULE_DELETE: "schedule.delete",
} as const;

export const AUDIT_RESULT = {
  SUCCESS: "SUCCESS",
  FAILURE: "FAILURE",
} as const;

type AuditSummary = Prisma.JsonObject;

/**
 * Appends to the audit log. Best-effort: logs and swallows errors so a busy DB does not break mutations.
 */
export async function recordAudit(
  c: Context<{ Variables: ApiVariables }>,
  params: {
    action: string;
    summary: AuditSummary;
    result: (typeof AUDIT_RESULT)[keyof typeof AUDIT_RESULT];
    errorCode?: string;
  },
): Promise<void> {
  const user = c.get("user");
  if (!user) return;
  const requestId = c.get("requestId");
  const apiKey = c.get("apiKey");
  try {
    await prisma.auditLog.create({
      data: {
        requestId,
        userId: user.id,
        apiKeyId: apiKey?.id,
        action: params.action,
        summary: params.summary,
        result: params.result,
        errorCode: params.errorCode,
      },
    });
  } catch (err) {
    console.error("[audit_log]", err instanceof Error ? err.message : err);
  }
}

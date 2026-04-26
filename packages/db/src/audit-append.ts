import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";

/**
 * Best-effort audit insert for non-HTTP actors (e.g. worker completing a system job).
 */
export async function appendAuditLogBestEffort(params: {
  requestId: string;
  userId: string;
  apiKeyId?: string | null;
  action: string;
  summary: Prisma.InputJsonValue;
  result: "SUCCESS" | "FAILURE";
  errorCode?: string | null;
}): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        requestId: params.requestId,
        userId: params.userId,
        apiKeyId: params.apiKeyId ?? undefined,
        action: params.action,
        summary: params.summary,
        result: params.result,
        errorCode: params.errorCode ?? undefined,
      },
    });
  } catch (err) {
    console.error("[audit_append]", err instanceof Error ? err.message : err);
  }
}

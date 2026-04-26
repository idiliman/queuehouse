import type { Context } from "hono";
import { prisma } from "@queuehouse/db";
import type { QueuehouseConfig } from "@queuehouse/core";
import type { ApiVariables } from "../api-types";
import {
  hashApiKeyToken,
  isQueuehouseApiKeyTokenShape,
  parseBearerToken,
} from "./api-key-crypto";
import { resolveSessionUser } from "./session";

export type ApplyAuthResult = "ok" | "invalid_bearer";

/**
 * Resolves the actor: `Authorization: Bearer qh_...` (API key) takes precedence; otherwise `qh_session` cookie.
 * On success, sets `user` to the key owner and `apiKey` when using a key; `apiKey` is cleared for cookie sessions.
 */
export async function applyAuth(
  c: Context<{ Variables: ApiVariables }>,
  config: QueuehouseConfig,
): Promise<ApplyAuthResult> {
  const raw = parseBearerToken(c.req.header("Authorization"));
  if (raw) {
    if (!isQueuehouseApiKeyTokenShape(raw)) {
      return "invalid_bearer";
    }
    const tokenHash = hashApiKeyToken(raw);
    const row = await prisma.apiKey.findUnique({
      where: { tokenHash },
      include: { user: true },
    });
    if (!row || row.revokedAt || row.user.disabledAt) {
      return "invalid_bearer";
    }
    c.set("user", {
      id: row.user.id,
      email: row.user.email,
      role: row.user.role,
    });
    c.set("apiKey", {
      id: row.id,
      scopes: row.scopes,
      allowedJobTypes: row.allowedJobTypes,
    });
    void prisma.apiKey
      .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
      .catch(() => {});
    return "ok";
  }

  c.set("apiKey", undefined);
  const sessionUser = await resolveSessionUser(c, config);
  c.set("user", sessionUser ?? undefined);
  return "ok";
}

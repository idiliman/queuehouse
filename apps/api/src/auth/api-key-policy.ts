import type { Context } from "hono";
import type { ApiKeyContext, ApiVariables } from "../api-types";

export const API_KEY_SCOPES = ["read", "enqueue", "admin"] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export function hasApiKeyScope(
  c: Context<{ Variables: ApiVariables }>,
  scope: ApiKeyScope,
): boolean {
  const key = c.get("apiKey");
  if (!key) return true;
  return key.scopes.includes(scope);
}

export function isApiKeyJobAllowed(
  c: Context<{ Variables: ApiVariables }>,
  jobName: string | undefined,
): boolean {
  const key = c.get("apiKey");
  if (!key) return true;
  if (!jobName) return false;
  return key.allowedJobTypes.includes(jobName);
}


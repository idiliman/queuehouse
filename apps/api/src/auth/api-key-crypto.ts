import { createHash, randomBytes } from "node:crypto";

const PREFIX = "qh_";

export function newApiKeyToken(): { token: string; tokenHash: string } {
  const secret = randomBytes(32).toString("base64url");
  const token = `${PREFIX}${secret}`;
  return { token, tokenHash: hashApiKeyToken(token) };
}

export function hashApiKeyToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function parseBearerToken(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const m = authorization.match(/^\s*Bearer\s+(\S+)\s*$/i);
  return m ? m[1]! : null;
}

export function isQueuehouseApiKeyTokenShape(raw: string): boolean {
  return raw.startsWith(PREFIX) && raw.length > PREFIX.length + 8;
}

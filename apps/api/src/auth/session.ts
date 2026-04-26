import { createHash, randomBytes } from "node:crypto";
import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { UserRole } from "@prisma/client";
import { prisma } from "@queuehouse/db";
import type { QueuehouseConfig } from "@queuehouse/core";

export const SESSION_COOKIE_NAME = "qh_session";

export const DEFAULT_SESSION_MAX_AGE_SEC = 60 * 60 * 24 * 30;

export type SessionUser = {
  id: string;
  email: string;
  role: UserRole;
};

export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function sessionCookieOptions(
  config: QueuehouseConfig,
  maxAgeSec: number,
) {
  return {
    httpOnly: true,
    secure: config.nodeEnv === "production",
    sameSite: "Lax" as const,
    path: "/",
    maxAge: maxAgeSec,
  };
}

export async function resolveSessionUser(
  c: Context,
  config: QueuehouseConfig,
): Promise<SessionUser | null> {
  const raw = getCookie(c, SESSION_COOKIE_NAME);
  if (!raw) return null;

  const tokenHash = hashSessionToken(raw);
  const session = await prisma.session.findUnique({
    where: { tokenHash },
    include: { user: true },
  });

  if (!session) return null;
  if (session.expiresAt.getTime() <= Date.now()) {
    await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
    return null;
  }
  if (session.user.disabledAt) return null;

  return {
    id: session.user.id,
    email: session.user.email,
    role: session.user.role,
  };
}

export async function createBrowserSession(
  c: Context,
  config: QueuehouseConfig,
  userId: string,
  maxAgeSec: number = DEFAULT_SESSION_MAX_AGE_SEC,
): Promise<void> {
  const token = newSessionToken();
  const tokenHash = hashSessionToken(token);
  const expiresAt = new Date(Date.now() + maxAgeSec * 1000);

  await prisma.session.create({
    data: { userId, tokenHash, expiresAt },
  });

  setCookie(c, SESSION_COOKIE_NAME, token, sessionCookieOptions(config, maxAgeSec));
}

export async function revokeBrowserSession(
  c: Context,
  config: QueuehouseConfig,
): Promise<void> {
  const raw = getCookie(c, SESSION_COOKIE_NAME);
  if (raw) {
    const tokenHash = hashSessionToken(raw);
    await prisma.session.deleteMany({ where: { tokenHash } });
  }
  setCookie(c, SESSION_COOKIE_NAME, "", {
    ...sessionCookieOptions(config, 0),
    maxAge: 0,
  });
}

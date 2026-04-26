import { Hono } from "hono";
import { cors } from "hono/cors";
import { prisma } from "@queuehouse/db";
import { config } from "../config";
import { corsAllowedOrigins } from "../cors";
import {
  createBrowserSession,
  DEFAULT_SESSION_MAX_AGE_SEC,
  revokeBrowserSession,
  resolveSessionUser,
} from "../auth/session";
import type { ApiVariables } from "../api-types";
import { getJobDetail } from "../bullmq/queuehouse-queue";
import { getQueuehouseRedis } from "../bullmq/redis";
import { createApiDocsApp } from "../openapi/api-docs";

export type { ApiVariables };

const allowedOrigins = corsAllowedOrigins(config);

export const v1 = new Hono<{ Variables: ApiVariables }>();

if (allowedOrigins.length > 0) {
  v1.use(
    "/*",
    cors({
      origin: allowedOrigins,
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Content-Type", "X-Request-Id"],
      credentials: true,
    }),
  );
}

v1.use(async (c, next) => {
  c.set("user", (await resolveSessionUser(c, config)) ?? undefined);
  await next();
});

v1.post("/auth/login", async (c) => {
  let body: { email?: string; password?: string };
  try {
    body = (await c.req.json()) as { email?: string; password?: string };
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!email || !password) {
    return c.json({ error: "email_and_password_required" }, 400);
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || user.disabledAt) {
    return c.json({ error: "invalid_credentials" }, 401);
  }

  const ok = await Bun.password.verify(password, user.passwordHash);
  if (!ok) {
    return c.json({ error: "invalid_credentials" }, 401);
  }

  await createBrowserSession(c, config, user.id, DEFAULT_SESSION_MAX_AGE_SEC);

  return c.json({
    user: { id: user.id, email: user.email, role: user.role },
  });
});

v1.post("/auth/logout", async (c) => {
  await revokeBrowserSession(c, config);
  return c.body(null, 204);
});

v1.get("/auth/session", async (c) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ error: "unauthenticated" }, 401);
  }
  return c.json({ user });
});

v1.get("/protected/viewer", async (c) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ error: "unauthenticated" }, 401);
  }
  return c.json({ ok: true, role: user.role });
});

v1.get("/protected/admin", async (c) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ error: "unauthenticated" }, 401);
  }
  if (user.role !== "ADMIN") {
    return c.json({ error: "forbidden" }, 403);
  }
  return c.json({ ok: true, role: user.role });
});

/**
 * BullMQ job status. `queueName` disambiguates job ids (ids are only unique per queue).
 */
v1.get("/jobs/:queueName/:jobId", async (c) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ error: "unauthenticated" }, 401);
  }
  const queueName = c.req.param("queueName");
  const jobId = c.req.param("jobId");
  const redis = getQueuehouseRedis(config);
  const detail = await getJobDetail(redis, config, queueName, jobId);
  if (!detail) {
    return c.json({ error: "job_not_found" }, 404);
  }
  return c.json(detail);
});

v1.route("/", createApiDocsApp(config));

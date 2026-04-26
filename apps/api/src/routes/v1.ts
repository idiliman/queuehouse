import { Hono } from "hono";
import { cors } from "hono/cors";
import { ZodError } from "zod";
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
import {
  getJobDetail,
  listJobs,
  removeFailedJob,
  retryFailedJobAsNew,
  retryFailedJobInPlace,
} from "../bullmq/queuehouse-queue";
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
      allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
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
 * List jobs (recent slice per queue/state). Requires auth. Does not return raw payload.
 * Query: queue, state (comma list), jobName, jobId, schedulerId, from, to, minAttempts, maxAttempts, limit
 */
v1.get("/jobs", async (c) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ error: "unauthenticated" }, 401);
  }
  const sp = c.req.query();
  const limitParsed = sp.limit != null && sp.limit !== "" ? parseInt(sp.limit, 10) : 50;
  const limit = Math.min(200, Math.max(1, Number.isNaN(limitParsed) ? 50 : limitParsed));
  const n = (v: string | undefined) =>
    v != null && v !== "" ? Number(v) : undefined;
  const from = n(sp.from);
  const to = n(sp.to);
  if (from != null && Number.isNaN(from)) {
    return c.json({ error: "invalid_from" }, 400);
  }
  if (to != null && Number.isNaN(to)) {
    return c.json({ error: "invalid_to" }, 400);
  }
  const minAttempts = n(sp.minAttempts);
  const maxAttempts = n(sp.maxAttempts);
  if (minAttempts != null && Number.isNaN(minAttempts)) {
    return c.json({ error: "invalid_minAttempts" }, 400);
  }
  if (maxAttempts != null && Number.isNaN(maxAttempts)) {
    return c.json({ error: "invalid_maxAttempts" }, 400);
  }
  const redis = getQueuehouseRedis(config);
  const jobs = await listJobs(redis, config, {
    queue: sp.queue,
    state: sp.state,
    jobName: sp.jobName,
    jobId: sp.jobId,
    schedulerId: sp.schedulerId,
    from,
    to,
    minAttempts,
    maxAttempts,
    limit,
  });
  return c.json({ jobs });
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

v1.post("/jobs/:queueName/:jobId/retry", async (c) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ error: "unauthenticated" }, 401);
  }
  if (user.role !== "ADMIN") {
    return c.json({ error: "forbidden" }, 403);
  }
  const queueName = c.req.param("queueName");
  const jobId = c.req.param("jobId");
  const redis = getQueuehouseRedis(config);
  const result = await retryFailedJobInPlace(redis, config, queueName, jobId);
  if ("error" in result) {
    if (result.error === "job_not_found") {
      return c.json({ error: "job_not_found" }, 404);
    }
    if (result.error === "forbidden_queue") {
      return c.json({ error: "forbidden_queue" }, 400);
    }
    return c.json({ error: "invalid_state" }, 400);
  }
  return c.json({ ok: true as const });
});

/**
 * Enqueue a new job from a failed one (admin DLQ recovery). Optional JSON body: `{ "payload"?: <job input>, "retry"?: { ... } }`.
 * Omitted `payload` reuses the failed job’s stored payload (use when redaction hid fields).
 */
v1.post("/jobs/:queueName/:jobId/retry-as-new", async (c) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ error: "unauthenticated" }, 401);
  }
  if (user.role !== "ADMIN") {
    return c.json({ error: "forbidden" }, 403);
  }
  const queueName = c.req.param("queueName");
  const jobId = c.req.param("jobId");
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" as const }, 400);
  }
  const requestId = c.get("requestId");
  const redis = getQueuehouseRedis(config);
  function isZodIssuesError(err: unknown): err is { issues: unknown } {
    return (
      typeof err === "object" &&
      err !== null &&
      "issues" in err &&
      Array.isArray((err as { issues: unknown }).issues)
    );
  }
  try {
    const result = await retryFailedJobAsNew(redis, config, {
      sourceQueueName: queueName,
      sourceJobId: jobId,
      body: body === undefined || body === null ? {} : body,
      requestId,
      user: { id: user.id, role: user.role },
    });
    if ("error" in result) {
      if (result.error === "job_not_found") {
        return c.json({ error: "job_not_found" as const }, 404);
      }
      if (result.error === "forbidden_queue") {
        return c.json({ error: "forbidden_queue" as const }, 400);
      }
      if (result.error === "unknown_job") {
        return c.json({ error: "unknown_job" as const }, 400);
      }
      return c.json({ error: "invalid_state" as const }, 400);
    }
    return c.json({ ...result, requestId });
  } catch (err) {
    if (err instanceof ZodError || isZodIssuesError(err)) {
      const issues = err instanceof ZodError ? err.issues : (err as { issues: unknown }).issues;
      return c.json({ error: "validation_failed" as const, issues }, 400);
    }
    const code = (err as { code?: string }).code;
    if (code === "invalid_body") {
      return c.json({ error: "invalid_json" as const }, 400);
    }
    if (code === "retry_override_not_allowed") {
      return c.json({ error: "retry_override_not_allowed" as const }, 400);
    }
    if (code === "retry_override_invalid") {
      return c.json({ error: "retry_override_invalid" as const }, 400);
    }
    if (code === "retry_override_out_of_range") {
      return c.json({ error: "retry_override_out_of_range" as const }, 400);
    }
    if (code === "retry_with_non_object_payload") {
      return c.json({ error: "retry_with_non_object_payload" as const }, 400);
    }
    throw err;
  }
});

v1.delete("/jobs/:queueName/:jobId", async (c) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ error: "unauthenticated" }, 401);
  }
  if (user.role !== "ADMIN") {
    return c.json({ error: "forbidden" }, 403);
  }
  const queueName = c.req.param("queueName");
  const jobId = c.req.param("jobId");
  const redis = getQueuehouseRedis(config);
  const result = await removeFailedJob(redis, config, queueName, jobId);
  if ("error" in result) {
    if (result.error === "job_not_found") {
      return c.json({ error: "job_not_found" }, 404);
    }
    if (result.error === "forbidden_queue") {
      return c.json({ error: "forbidden_queue" }, 400);
    }
    return c.json({ error: "invalid_state" }, 400);
  }
  return c.body(null, 204);
});

v1.route("/", createApiDocsApp(config));

import { Hono } from "hono";
import { cors } from "hono/cors";
import { z, ZodError } from "zod";
import {
  JOB_CAPABILITY,
  listRegisteredJobs,
  MANUAL_ENQUEUE_LIMITS,
  mergePayloadWithRetryForEnqueue,
  resolveManualEnqueueDelayMs,
} from "@queuehouse/core";
import { prisma } from "@queuehouse/db";
import { config } from "../config";
import { corsAllowedOrigins } from "../cors";
import { newApiKeyToken } from "../auth/api-key-crypto";
import { hasApiKeyScope, isApiKeyJobAllowed } from "../auth/api-key-policy";
import { applyAuth } from "../auth/resolve-auth";
import { AUDIT_ACTION, AUDIT_RESULT, recordAudit } from "../audit/audit-log";
import {
  createBrowserSession,
  DEFAULT_SESSION_MAX_AGE_SEC,
  revokeBrowserSession,
} from "../auth/session";
import type { ApiVariables } from "../api-types";
import {
  enqueueManualUiJob,
  getBullJobName,
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
      allowHeaders: ["Content-Type", "X-Request-Id", "Authorization"],
      credentials: true,
    }),
  );
}

v1.use(async (c, next) => {
  const r = await applyAuth(c, config);
  if (r === "invalid_bearer") {
    return c.json({ error: "invalid_token" as const }, 401);
  }
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

const createApiKeyBody = z
  .object({
    name: z.string().min(1).max(200).optional(),
    scopes: z.array(z.enum(["read", "enqueue", "admin"])).min(1),
    allowedJobTypes: z.array(z.string().min(1)).min(0),
  })
  .strict();

/** Build UI picklists: registered job names and descriptions. Admin session only. */
v1.get("/meta/registered-jobs", async (c) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ error: "unauthenticated" }, 401);
  }
  if (c.get("apiKey")) {
    return c.json({ error: "forbidden" }, 403);
  }
  if (user.role !== "ADMIN") {
    return c.json({ error: "forbidden" }, 403);
  }
  return c.json({
    jobs: listRegisteredJobs().map((j) => ({
      name: j.name,
      description: j.description,
      manualUi: j.capabilities.includes(JOB_CAPABILITY.MANUAL_UI),
    })),
  });
});

const manualEnqueueBody = z
  .object({
    jobName: z.string().min(1).max(200),
    payload: z.unknown(),
    delay: z.number().int().min(0).max(MANUAL_ENQUEUE_LIMITS.maxDelayMs).optional(),
    runAt: z.string().max(80).optional(),
    dedupeKey: z
      .string()
      .min(1)
      .max(200)
      .refine((k) => k !== "0" && !k.startsWith("0:"), { message: "invalid_dedupeKey" })
      .optional(),
    priority: z
      .number()
      .int()
      .min(MANUAL_ENQUEUE_LIMITS.minPriority)
      .max(MANUAL_ENQUEUE_LIMITS.maxPriority)
      .optional(),
    waitTimeoutMs: z
      .number()
      .int()
      .min(0)
      .max(MANUAL_ENQUEUE_LIMITS.maxWaitTimeoutMs)
      .optional(),
    retry: z
      .object({
        maxAttempts: z.number().int().optional(),
        backoffMs: z.number().int().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((b) => !(b.delay != null && b.runAt != null && b.runAt.trim() !== ""), {
    message: "manual_delay_runAt_exclusive",
  });

/**
 * Admin session only: enqueue jobs marked `manual.ui` (includes jobs without public `enqueue.api`).
 * Supports delay / runAt, dedupe id, priority, retry overrides, optional wait for completion.
 */
v1.post("/manual-enqueue", async (c) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ error: "unauthenticated" as const }, 401);
  }
  if (c.get("apiKey")) {
    return c.json({ error: "forbidden" as const }, 403);
  }
  if (user.role !== "ADMIN") {
    return c.json({ error: "forbidden" as const }, 403);
  }
  let body: z.infer<typeof manualEnqueueBody>;
  try {
    const raw = await c.req.json();
    body = manualEnqueueBody.parse(raw);
  } catch (err) {
    if (err instanceof ZodError) {
      await recordAudit(c, {
        action: AUDIT_ACTION.JOB_ENQUEUE,
        summary: { path: "manual" },
        result: AUDIT_RESULT.FAILURE,
        errorCode: "validation_failed",
      });
      return c.json({ error: "validation_failed" as const, issues: err.issues }, 400);
    }
    await recordAudit(c, {
      action: AUDIT_ACTION.JOB_ENQUEUE,
      summary: { path: "manual" },
      result: AUDIT_RESULT.FAILURE,
      errorCode: "invalid_json",
    });
    return c.json({ error: "invalid_json" as const }, 400);
  }

  const requestId = c.get("requestId")!;
  const redis = getQueuehouseRedis(config);

  let delayMs: number;
  try {
    delayMs = resolveManualEnqueueDelayMs({
      delay: body.delay,
      runAt: body.runAt && body.runAt.trim() !== "" ? body.runAt : undefined,
    });
  } catch (metaErr) {
    const code = (metaErr as { code?: string }).code;
    if (code === "manual_delay_runAt_exclusive" || code === "invalid_runAt" || code === "invalid_delay") {
      await recordAudit(c, {
        action: AUDIT_ACTION.JOB_ENQUEUE,
        summary: { path: "manual", jobName: body.jobName },
        result: AUDIT_RESULT.FAILURE,
        errorCode: code,
      });
      return c.json({ error: (code ?? "invalid_schedule") as "manual_delay_runAt_exclusive" | "invalid_runAt" | "invalid_delay" }, 400);
    }
    throw metaErr;
  }

  let inner: unknown;
  try {
    inner = mergePayloadWithRetryForEnqueue(body.payload, body.retry);
  } catch (mergeErr) {
    const code = (mergeErr as { code?: string }).code;
    if (code === "retry_with_non_object_payload") {
      await recordAudit(c, {
        action: AUDIT_ACTION.JOB_ENQUEUE,
        summary: { path: "manual", jobName: body.jobName },
        result: AUDIT_RESULT.FAILURE,
        errorCode: code,
      });
      return c.json({ error: "retry_with_non_object_payload" as const }, 400);
    }
    throw mergeErr;
  }

  const waitTimeoutMs = body.waitTimeoutMs ?? 0;

  try {
    const out = await enqueueManualUiJob(redis, config, {
      jobName: body.jobName,
      body: inner,
      delayMs,
      jobId: body.dedupeKey,
      priority: body.priority,
      waitTimeoutMs,
      requestId,
      user: { id: user.id, role: user.role },
    });
    await recordAudit(c, {
      action: AUDIT_ACTION.JOB_ENQUEUE,
      summary: {
        path: "manual",
        jobName: body.jobName,
        newJobId: out.jobId,
        queueName: out.queueName,
        delayMs,
        dedupeKey: body.dedupeKey ?? null,
        waitUsed: waitTimeoutMs > 0,
        waitCompleted: waitTimeoutMs > 0 && out.result !== undefined,
      },
      result: AUDIT_RESULT.SUCCESS,
    });
    return c.json({
      jobId: out.jobId,
      queueName: out.queueName,
      requestId,
      ...(out.result !== undefined ? { result: out.result } : {}),
    });
  } catch (err) {
    if (err instanceof ZodError) {
      await recordAudit(c, {
        action: AUDIT_ACTION.JOB_ENQUEUE,
        summary: { path: "manual", jobName: body.jobName },
        result: AUDIT_RESULT.FAILURE,
        errorCode: "validation_failed",
      });
      return c.json({ error: "validation_failed" as const, issues: err.issues }, 400);
    }
    const code = (err as { code?: string }).code;
    if (code === "unknown_job") {
      await recordAudit(c, {
        action: AUDIT_ACTION.JOB_ENQUEUE,
        summary: { path: "manual" },
        result: AUDIT_RESULT.FAILURE,
        errorCode: code,
      });
      return c.json({ error: "unknown_job" as const }, 400);
    }
    if (code === "manual_enqueue_not_allowed") {
      await recordAudit(c, {
        action: AUDIT_ACTION.JOB_ENQUEUE,
        summary: { path: "manual", jobName: body.jobName },
        result: AUDIT_RESULT.FAILURE,
        errorCode: code,
      });
      return c.json({ error: "manual_enqueue_not_allowed" as const }, 403);
    }
    if (code === "dedupe_job_id_conflict") {
      await recordAudit(c, {
        action: AUDIT_ACTION.JOB_ENQUEUE,
        summary: { path: "manual", jobName: body.jobName, dedupeKey: body.dedupeKey },
        result: AUDIT_RESULT.FAILURE,
        errorCode: code,
      });
      return c.json({ error: "dedupe_job_id_conflict" as const }, 409);
    }
    if (code === "wait_timeout") {
      await recordAudit(c, {
        action: AUDIT_ACTION.JOB_ENQUEUE,
        summary: { path: "manual", jobName: body.jobName },
        result: AUDIT_RESULT.FAILURE,
        errorCode: code,
      });
      return c.json({ error: "wait_timeout" as const }, 504);
    }
    if (code === "retry_override_not_allowed") {
      await recordAudit(c, {
        action: AUDIT_ACTION.JOB_ENQUEUE,
        summary: { path: "manual", jobName: body.jobName },
        result: AUDIT_RESULT.FAILURE,
        errorCode: code,
      });
      return c.json({ error: "retry_override_not_allowed" as const }, 400);
    }
    if (code === "retry_override_invalid") {
      await recordAudit(c, {
        action: AUDIT_ACTION.JOB_ENQUEUE,
        summary: { path: "manual", jobName: body.jobName },
        result: AUDIT_RESULT.FAILURE,
        errorCode: code,
      });
      return c.json({ error: "retry_override_invalid" as const }, 400);
    }
    if (code === "retry_override_out_of_range") {
      await recordAudit(c, {
        action: AUDIT_ACTION.JOB_ENQUEUE,
        summary: { path: "manual", jobName: body.jobName },
        result: AUDIT_RESULT.FAILURE,
        errorCode: code,
      });
      return c.json({ error: "retry_override_out_of_range" as const }, 400);
    }
    if (code === "retry_with_non_object_payload") {
      await recordAudit(c, {
        action: AUDIT_ACTION.JOB_ENQUEUE,
        summary: { path: "manual", jobName: body.jobName },
        result: AUDIT_RESULT.FAILURE,
        errorCode: code,
      });
      return c.json({ error: "retry_with_non_object_payload" as const }, 400);
    }
    if (isZodIssuesError(err)) {
      await recordAudit(c, {
        action: AUDIT_ACTION.JOB_ENQUEUE,
        summary: { path: "manual", jobName: body.jobName },
        result: AUDIT_RESULT.FAILURE,
        errorCode: "validation_failed",
      });
      return c.json({ error: "validation_failed" as const, issues: (err as { issues: unknown }).issues }, 400);
    }
    throw err;
  }
});

function isZodIssuesError(err: unknown): err is { issues: unknown } {
  return (
    typeof err === "object" &&
    err !== null &&
    "issues" in err &&
    Array.isArray((err as { issues: unknown }).issues)
  );
}

/**
 * Admin-only, browser session only: paginated audit log (mutations with redacted summaries).
 * Query: `limit` (1–100), `offset`, `action` (optional exact match)
 */
v1.get("/audit-logs", async (c) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ error: "unauthenticated" }, 401);
  }
  if (c.get("apiKey")) {
    return c.json({ error: "forbidden" }, 403);
  }
  if (user.role !== "ADMIN") {
    return c.json({ error: "forbidden" }, 403);
  }
  const sp = c.req.query();
  const limitRaw = sp.limit != null && sp.limit !== "" ? parseInt(sp.limit, 10) : 50;
  const limit = Math.min(100, Math.max(1, Number.isNaN(limitRaw) ? 50 : limitRaw));
  const offsetRaw = sp.offset != null && sp.offset !== "" ? parseInt(sp.offset, 10) : 0;
  const offset = Math.min(10_000, Math.max(0, Number.isNaN(offsetRaw) ? 0 : offsetRaw));
  const action = sp.action?.trim() || undefined;
  const where = action ? { action } : undefined;
  const [rows, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: offset,
      take: limit,
      select: {
        id: true,
        createdAt: true,
        requestId: true,
        action: true,
        summary: true,
        result: true,
        errorCode: true,
        userId: true,
        apiKeyId: true,
        user: { select: { email: true } },
        apiKey: { select: { id: true, name: true } },
      },
    }),
    prisma.auditLog.count({ where }),
  ]);
  return c.json({
    items: rows.map((r) => ({
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      requestId: r.requestId,
      action: r.action,
      summary: r.summary,
      result: r.result,
      errorCode: r.errorCode,
      actor: {
        type: r.apiKeyId ? ("api_key" as const) : ("user" as const),
        userEmail: r.user.email,
        apiKeyName: r.apiKey?.name ?? null,
        apiKeyId: r.apiKeyId,
      },
    })),
    total,
  });
});

v1.post("/api-keys", async (c) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ error: "unauthenticated" }, 401);
  }
  if (c.get("apiKey")) {
    return c.json({ error: "forbidden" }, 403);
  }
  if (user.role !== "ADMIN") {
    return c.json({ error: "forbidden" }, 403);
  }
  let body: z.infer<typeof createApiKeyBody>;
  try {
    const raw = await c.req.json();
    body = createApiKeyBody.parse(raw);
  } catch (err) {
    if (err instanceof ZodError) {
      return c.json({ error: "validation_failed" as const, issues: err.issues }, 400);
    }
    return c.json({ error: "invalid_json" }, 400);
  }
  const { token, tokenHash } = newApiKeyToken();
  const row = await prisma.apiKey.create({
    data: {
      userId: user.id,
      name: body.name,
      tokenHash,
      scopes: body.scopes,
      allowedJobTypes: body.allowedJobTypes,
    },
  });
  await recordAudit(c, {
    action: AUDIT_ACTION.API_KEY_CREATE,
    summary: {
      apiKeyId: row.id,
      name: row.name,
      scopes: row.scopes,
      allowedJobTypes: row.allowedJobTypes,
    },
    result: AUDIT_RESULT.SUCCESS,
  });
  return c.json(
    {
      token,
      apiKey: {
        id: row.id,
        name: row.name,
        createdAt: row.createdAt,
        scopes: row.scopes,
        allowedJobTypes: row.allowedJobTypes,
      },
    },
    201,
  );
});

v1.get("/api-keys", async (c) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ error: "unauthenticated" }, 401);
  }
  if (c.get("apiKey")) {
    return c.json({ error: "forbidden" }, 403);
  }
  if (user.role !== "ADMIN") {
    return c.json({ error: "forbidden" }, 403);
  }
  const keys = await prisma.apiKey.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      createdAt: true,
      scopes: true,
      allowedJobTypes: true,
      revokedAt: true,
    },
  });
  return c.json({ apiKeys: keys });
});

v1.delete("/api-keys/:id", async (c) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ error: "unauthenticated" }, 401);
  }
  if (c.get("apiKey")) {
    return c.json({ error: "forbidden" }, 403);
  }
  if (user.role !== "ADMIN") {
    return c.json({ error: "forbidden" }, 403);
  }
  const id = c.req.param("id");
  const r = await prisma.apiKey.updateMany({
    where: { id, userId: user.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (r.count === 0) {
    return c.json({ error: "not_found" as const }, 404);
  }
  await recordAudit(c, {
    action: AUDIT_ACTION.API_KEY_REVOKE,
    summary: { apiKeyId: id },
    result: AUDIT_RESULT.SUCCESS,
  });
  return c.body(null, 204);
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
  if (!hasApiKeyScope(c, "read")) {
    return c.json({ error: "forbidden" }, 403);
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
  let jobs = await listJobs(redis, config, {
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
  const k = c.get("apiKey");
  if (k) {
    jobs = jobs.filter((j) => j.jobName && k.allowedJobTypes.includes(j.jobName));
  }
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
  if (!hasApiKeyScope(c, "read")) {
    return c.json({ error: "forbidden" }, 403);
  }
  const queueName = c.req.param("queueName");
  const jobId = c.req.param("jobId");
  const redis = getQueuehouseRedis(config);
  if (c.get("apiKey")) {
    const jn = await getBullJobName(redis, config, queueName, jobId);
    if (!jn) {
      return c.json({ error: "job_not_found" }, 404);
    }
    if (!isApiKeyJobAllowed(c, jn)) {
      return c.json({ error: "forbidden" }, 403);
    }
  }
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
  if (!hasApiKeyScope(c, "admin")) {
    return c.json({ error: "forbidden" }, 403);
  }
  const queueName = c.req.param("queueName");
  const jobId = c.req.param("jobId");
  const redis = getQueuehouseRedis(config);
  const jn = await getBullJobName(redis, config, queueName, jobId);
  if (jn && c.get("apiKey") && !isApiKeyJobAllowed(c, jn)) {
    return c.json({ error: "forbidden" }, 403);
  }
  const result = await retryFailedJobInPlace(redis, config, queueName, jobId);
  if ("error" in result) {
    await recordAudit(c, {
      action: AUDIT_ACTION.JOB_RETRY,
      summary: { queueName, jobId, jobName: jn ?? null },
      result: AUDIT_RESULT.FAILURE,
      errorCode: result.error,
    });
    if (result.error === "job_not_found") {
      return c.json({ error: "job_not_found" }, 404);
    }
    if (result.error === "forbidden_queue") {
      return c.json({ error: "forbidden_queue" }, 400);
    }
    return c.json({ error: "invalid_state" }, 400);
  }
  await recordAudit(c, {
    action: AUDIT_ACTION.JOB_RETRY,
    summary: { queueName, jobId, jobName: jn ?? null },
    result: AUDIT_RESULT.SUCCESS,
  });
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
  if (!hasApiKeyScope(c, "admin")) {
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
  const jn0 = await getBullJobName(redis, config, queueName, jobId);
  if (jn0 && c.get("apiKey") && !isApiKeyJobAllowed(c, jn0)) {
    return c.json({ error: "forbidden" }, 403);
  }
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
      await recordAudit(c, {
        action: AUDIT_ACTION.JOB_RETRY_AS_NEW,
        summary: { sourceQueueName: queueName, sourceJobId: jobId, jobName: jn0 ?? null },
        result: AUDIT_RESULT.FAILURE,
        errorCode: result.error,
      });
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
    await recordAudit(c, {
      action: AUDIT_ACTION.JOB_RETRY_AS_NEW,
      summary: {
        sourceQueueName: queueName,
        sourceJobId: jobId,
        newJobId: result.jobId,
        queueName: result.queueName,
        jobName: jn0 ?? null,
      },
      result: AUDIT_RESULT.SUCCESS,
    });
    return c.json({ ...result, requestId });
  } catch (err) {
    if (err instanceof ZodError || isZodIssuesError(err)) {
      const issues = err instanceof ZodError ? err.issues : (err as { issues: unknown }).issues;
      await recordAudit(c, {
        action: AUDIT_ACTION.JOB_RETRY_AS_NEW,
        summary: { sourceQueueName: queueName, sourceJobId: jobId, jobName: jn0 ?? null },
        result: AUDIT_RESULT.FAILURE,
        errorCode: "validation_failed",
      });
      return c.json({ error: "validation_failed" as const, issues }, 400);
    }
    const code = (err as { code?: string }).code;
    if (code === "invalid_body") {
      await recordAudit(c, {
        action: AUDIT_ACTION.JOB_RETRY_AS_NEW,
        summary: { sourceQueueName: queueName, sourceJobId: jobId, jobName: jn0 ?? null },
        result: AUDIT_RESULT.FAILURE,
        errorCode: "invalid_json",
      });
      return c.json({ error: "invalid_json" as const }, 400);
    }
    if (code === "retry_override_not_allowed") {
      await recordAudit(c, {
        action: AUDIT_ACTION.JOB_RETRY_AS_NEW,
        summary: { sourceQueueName: queueName, sourceJobId: jobId, jobName: jn0 ?? null },
        result: AUDIT_RESULT.FAILURE,
        errorCode: "retry_override_not_allowed",
      });
      return c.json({ error: "retry_override_not_allowed" as const }, 400);
    }
    if (code === "retry_override_invalid") {
      await recordAudit(c, {
        action: AUDIT_ACTION.JOB_RETRY_AS_NEW,
        summary: { sourceQueueName: queueName, sourceJobId: jobId, jobName: jn0 ?? null },
        result: AUDIT_RESULT.FAILURE,
        errorCode: "retry_override_invalid",
      });
      return c.json({ error: "retry_override_invalid" as const }, 400);
    }
    if (code === "retry_override_out_of_range") {
      await recordAudit(c, {
        action: AUDIT_ACTION.JOB_RETRY_AS_NEW,
        summary: { sourceQueueName: queueName, sourceJobId: jobId, jobName: jn0 ?? null },
        result: AUDIT_RESULT.FAILURE,
        errorCode: "retry_override_out_of_range",
      });
      return c.json({ error: "retry_override_out_of_range" as const }, 400);
    }
    if (code === "retry_with_non_object_payload") {
      await recordAudit(c, {
        action: AUDIT_ACTION.JOB_RETRY_AS_NEW,
        summary: { sourceQueueName: queueName, sourceJobId: jobId, jobName: jn0 ?? null },
        result: AUDIT_RESULT.FAILURE,
        errorCode: "retry_with_non_object_payload",
      });
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
  if (!hasApiKeyScope(c, "admin")) {
    return c.json({ error: "forbidden" }, 403);
  }
  const queueName = c.req.param("queueName");
  const jobId = c.req.param("jobId");
  const redis = getQueuehouseRedis(config);
  const jn = await getBullJobName(redis, config, queueName, jobId);
  if (jn && c.get("apiKey") && !isApiKeyJobAllowed(c, jn)) {
    return c.json({ error: "forbidden" }, 403);
  }
  const result = await removeFailedJob(redis, config, queueName, jobId);
  if ("error" in result) {
    await recordAudit(c, {
      action: AUDIT_ACTION.JOB_REMOVE,
      summary: { queueName, jobId, jobName: jn ?? null },
      result: AUDIT_RESULT.FAILURE,
      errorCode: result.error,
    });
    if (result.error === "job_not_found") {
      return c.json({ error: "job_not_found" }, 404);
    }
    if (result.error === "forbidden_queue") {
      return c.json({ error: "forbidden_queue" }, 400);
    }
    return c.json({ error: "invalid_state" }, 400);
  }
  await recordAudit(c, {
    action: AUDIT_ACTION.JOB_REMOVE,
    summary: { queueName, jobId, jobName: jn ?? null },
    result: AUDIT_RESULT.SUCCESS,
  });
  return c.body(null, 204);
});

v1.route("/", createApiDocsApp(config));

import "./zod-patch";
import { Scalar } from "@scalar/hono-api-reference";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { ZodError } from "zod";
import {
  EXAMPLE_DATABASE_URL,
  JOB_CAPABILITY,
  listRegisteredJobs,
  loadConfig,
  type QueuehouseConfig,
  type RegisteredJob,
} from "@queuehouse/core";
import type { ApiVariables } from "../api-types";
import { AUDIT_ACTION, AUDIT_RESULT, recordAudit } from "../audit/audit-log";
import { hasApiKeyScope, isApiKeyJobAllowed } from "../auth/api-key-policy";
import { enqueueAuthenticatedJob } from "../bullmq/queuehouse-queue";
import { getQueuehouseRedis } from "../bullmq/redis";

function hasEnqueueApi(job: { capabilities: readonly string[] }): boolean {
  return job.capabilities.includes(JOB_CAPABILITY.ENQUEUE_API);
}

/** OpenAPI field docs for per-job enqueue `retry` when the job declares `retryOverrides`. */
function retryOverrideRequestSchema(job: RegisteredJob): z.ZodTypeAny {
  const bounds = job.retryOverrides!;
  const ma = bounds.maxAttempts;
  const bo = bounds.backoffMs;
  return z
    .object({
      maxAttempts: z
        .number()
        .int()
        .optional()
        .describe(
          ma
            ? `Optional BullMQ attempt budget for this enqueue only (inclusive ${ma.min}–${ma.max}). Omitted: merged from registry defaults.`
            : "Optional maxAttempts override.",
        ),
      backoffMs: z
        .number()
        .int()
        .optional()
        .describe(
          bo
            ? `Optional base backoff in ms (inclusive ${bo.min}–${bo.max}). Omitted: merged from registry defaults.`
            : "Optional backoffMs override.",
        ),
    })
    .strict()
    .optional()
    .describe(
      "Per-request retry overrides merged with this job's registry defaults; values outside the ranges above return 400 `retry_override_out_of_range`. " +
        "Other cases: `retry_override_not_allowed` (field present but job disallows overrides), `retry_override_invalid` (bad shape).",
    );
}

function jobEnqueueRequestSchema(job: RegisteredJob): z.ZodTypeAny {
  const input = job.inputSchema as unknown as z.ZodTypeAny;
  if (job.retryOverrides && input instanceof z.ZodObject) {
    return (input as { merge: (s: z.ZodTypeAny) => z.ZodTypeAny }).merge(
      z.object({ retry: retryOverrideRequestSchema(job) }),
    );
  }
  return input;
}

function genericBodyToJobBody(payload: unknown, retry: unknown): unknown {
  if (retry === undefined) return payload;
  if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
    return { ...(payload as Record<string, unknown>), retry };
  }
  const e = new Error("retry_with_non_object_payload") as Error & { code?: string };
  e.code = "retry_with_non_object_payload";
  throw e;
}

const genericEnqueueBody = z.object({
  jobName: z
    .string()
    .min(1)
    .describe("Registered job name, e.g. `example.success`."),
  payload: z
    .unknown()
    .describe("JSON payload; must match the target job input schema."),
  retry: z
    .object({
      maxAttempts: z
        .number()
        .int()
        .optional()
        .describe(
          "Optional BullMQ attempt budget override; allowed range is defined per job in the registry (typical jobs: 1–10).",
        ),
      backoffMs: z
        .number()
        .int()
        .optional()
        .describe(
          "Optional base backoff in ms; allowed range is defined per job when overrides are supported.",
        ),
    })
    .strict()
    .optional()
    .describe(
      "Per-request retry overrides for the target job. Only jobs with `retryOverrides` accept this; others return 400 `retry_override_not_allowed`. " +
        "For object payloads, prefer top-level `retry` on per-job routes; for the generic route it is merged into the payload. " +
        "Out-of-range values → `retry_override_out_of_range`; non-object payload with retry → `retry_with_non_object_payload`.",
    ),
});

const enqueueAccepted = z.object({
  jobId: z.string(),
  queueName: z.string(),
  requestId: z.string(),
});

const enqueueClientError = z.object({
  error: z.enum([
    "unknown_job",
    "enqueue_not_allowed",
    "validation_failed",
    "invalid_json",
    "retry_override_not_allowed",
    "retry_override_invalid",
    "retry_override_out_of_range",
    "retry_with_non_object_payload",
  ]),
  issues: z.unknown().optional(),
});

function isZodIssuesError(err: unknown): err is { issues: unknown } {
  return (
    typeof err === "object" &&
    err !== null &&
    "issues" in err &&
    Array.isArray((err as { issues: unknown }).issues)
  );
}

async function readEnqueueJsonBody(c: {
  req: {
    valid: (k: "json") => unknown;
    json: () => Promise<unknown>;
  };
}): Promise<{ body: unknown } | { error: "invalid_json" }> {
  const validated = c.req.valid("json");
  if (validated !== undefined) {
    return { body: validated };
  }
  try {
    return { body: await c.req.json() };
  } catch {
    return { error: "invalid_json" };
  }
}

/**
 * Hono sub-app: protected OpenAPI document, Scalar UI, and typed enqueue routes.
 */
export function createApiDocsApp(
  cfg: QueuehouseConfig,
): OpenAPIHono<{ Variables: ApiVariables }> {
  const app = new OpenAPIHono<{ Variables: ApiVariables }>();

  app.use("*", async (c, next) => {
    if (!c.get("user")) {
      return c.json({ error: "unauthenticated" }, 401);
    }
    await next();
  });

  for (const job of listRegisteredJobs()) {
    if (!hasEnqueueApi(job)) continue;
    const path = `/jobs/${job.name}/enqueue` as const;
    const route = createRoute({
      method: "post",
      path,
      operationId: `enqueue_${job.name.replace(/[^a-zA-Z0-9]+/g, "_")}`,
      summary: `Enqueue: ${job.name}`,
      description: job.description,
      request: {
        body: {
          content: {
            "application/json": {
              schema: jobEnqueueRequestSchema(job) as unknown as import("zod").ZodType<
                unknown,
                import("zod").ZodTypeDef,
                unknown
              >,
            },
          },
          required: true,
        },
      },
      tags: job.deprecated ? ["enqueue", "deprecated"] : ["enqueue"],
      deprecated: job.deprecated === true,
      responses: {
        200: {
          description: "Job enqueued",
          content: { "application/json": { schema: enqueueAccepted } },
        },
        400: {
          description:
            "Invalid payload, validation, or retry override (see `error`: `retry_override_*`, `retry_with_non_object_payload`)",
          content: { "application/json": { schema: enqueueClientError } },
        },
        403: {
          description: "Job is not allowed for public API enqueue",
          content: { "application/json": { schema: enqueueClientError } },
        },
        401: {
          description: "Unauthenticated",
          content: {
            "application/json": {
              schema: z.object({ error: z.literal("unauthenticated") }),
            },
          },
        },
      },
    });
    app.openapi(route, async (c) => {
      const user = c.get("user")!;
      if (!hasApiKeyScope(c, "enqueue") || !isApiKeyJobAllowed(c, job.name)) {
        await recordAudit(c, {
          action: AUDIT_ACTION.JOB_ENQUEUE,
          summary: { jobName: job.name },
          result: AUDIT_RESULT.FAILURE,
          errorCode: "enqueue_not_allowed",
        });
        return c.json({ error: "enqueue_not_allowed" as const }, 403);
      }
      const parsed = await readEnqueueJsonBody(c);
      if ("error" in parsed) {
        await recordAudit(c, {
          action: AUDIT_ACTION.JOB_ENQUEUE,
          summary: { jobName: job.name },
          result: AUDIT_RESULT.FAILURE,
          errorCode: "invalid_json",
        });
        return c.json({ error: "invalid_json" as const }, 400);
      }
      const body = parsed.body;
      const requestId = c.get("requestId")!;
      const redis = getQueuehouseRedis(cfg);
      try {
        const { jobId, queueName } = await enqueueAuthenticatedJob(redis, cfg, {
          jobName: job.name,
          body,
          requestId,
          user: { id: user.id, role: user.role },
        });
        await recordAudit(c, {
          action: AUDIT_ACTION.JOB_ENQUEUE,
          summary: { jobName: job.name, newJobId: jobId, queueName },
          result: AUDIT_RESULT.SUCCESS,
        });
        return c.json({ jobId, queueName, requestId }, 200);
      } catch (err) {
        if (err instanceof ZodError || isZodIssuesError(err)) {
          const issues = err instanceof ZodError ? err.issues : (err as { issues: unknown }).issues;
          await recordAudit(c, {
            action: AUDIT_ACTION.JOB_ENQUEUE,
            summary: { jobName: job.name },
            result: AUDIT_RESULT.FAILURE,
            errorCode: "validation_failed",
          });
          return c.json({ error: "validation_failed" as const, issues }, 400);
        }
        const code = (err as { code?: string }).code;
        if (code === "unknown_job") {
          await recordAudit(c, {
            action: AUDIT_ACTION.JOB_ENQUEUE,
            summary: { jobName: job.name },
            result: AUDIT_RESULT.FAILURE,
            errorCode: "unknown_job",
          });
          return c.json({ error: "unknown_job" as const }, 400);
        }
        if (code === "enqueue_not_allowed") {
          await recordAudit(c, {
            action: AUDIT_ACTION.JOB_ENQUEUE,
            summary: { jobName: job.name },
            result: AUDIT_RESULT.FAILURE,
            errorCode: "enqueue_not_allowed",
          });
          return c.json({ error: "enqueue_not_allowed" as const }, 403);
        }
        if (code === "retry_override_not_allowed") {
          await recordAudit(c, {
            action: AUDIT_ACTION.JOB_ENQUEUE,
            summary: { jobName: job.name },
            result: AUDIT_RESULT.FAILURE,
            errorCode: "retry_override_not_allowed",
          });
          return c.json({ error: "retry_override_not_allowed" as const }, 400);
        }
        if (code === "retry_override_invalid") {
          await recordAudit(c, {
            action: AUDIT_ACTION.JOB_ENQUEUE,
            summary: { jobName: job.name },
            result: AUDIT_RESULT.FAILURE,
            errorCode: "retry_override_invalid",
          });
          return c.json({ error: "retry_override_invalid" as const }, 400);
        }
        if (code === "retry_override_out_of_range") {
          await recordAudit(c, {
            action: AUDIT_ACTION.JOB_ENQUEUE,
            summary: { jobName: job.name },
            result: AUDIT_RESULT.FAILURE,
            errorCode: "retry_override_out_of_range",
          });
          return c.json({ error: "retry_override_out_of_range" as const }, 400);
        }
        if (code === "retry_with_non_object_payload") {
          await recordAudit(c, {
            action: AUDIT_ACTION.JOB_ENQUEUE,
            summary: { jobName: job.name },
            result: AUDIT_RESULT.FAILURE,
            errorCode: "retry_with_non_object_payload",
          });
          return c.json({ error: "retry_with_non_object_payload" as const }, 400);
        }
        throw err;
      }
    });
  }

  const genericRoute = createRoute({
    method: "post",
    path: "/jobs/enqueue",
    operationId: "enqueue_generic",
    summary: "Generic enqueue (tooling)",
    description:
      "Tooling route: supply `jobName` and an untyped `payload` object. Prefer per-job paths when the job is externally enqueueable.",
    request: {
      body: {
        content: { "application/json": { schema: genericEnqueueBody } },
        required: true,
      },
    },
    tags: ["enqueue", "tooling"],
    responses: {
      200: {
        description: "Job enqueued",
        content: { "application/json": { schema: enqueueAccepted } },
      },
      400: {
        description:
          "Invalid payload, validation, or retry override (see `error`: `retry_override_*`, `retry_with_non_object_payload`)",
        content: { "application/json": { schema: enqueueClientError } },
      },
      403: {
        description: "Job is not allowed for public API enqueue",
        content: { "application/json": { schema: enqueueClientError } },
      },
      401: {
        description: "Unauthenticated",
        content: {
          "application/json": {
            schema: z.object({ error: z.literal("unauthenticated") }),
          },
        },
      },
    },
  });
  app.openapi(genericRoute, async (c) => {
    const user = c.get("user")!;
    const parsed = await readEnqueueJsonBody(c);
    if ("error" in parsed) {
      await recordAudit(c, {
        action: AUDIT_ACTION.JOB_ENQUEUE,
        summary: { path: "generic" },
        result: AUDIT_RESULT.FAILURE,
        errorCode: "invalid_json",
      });
      return c.json({ error: "invalid_json" as const }, 400);
    }
    const envelope = parsed.body as {
      jobName?: string;
      payload?: unknown;
      retry?: { maxAttempts?: number; backoffMs?: number };
    };
    const jobName = typeof envelope?.jobName === "string" ? envelope.jobName : "";
    if (!jobName) {
      await recordAudit(c, {
        action: AUDIT_ACTION.JOB_ENQUEUE,
        summary: { path: "generic" },
        result: AUDIT_RESULT.FAILURE,
        errorCode: "validation_failed",
      });
      return c.json({ error: "validation_failed" as const, issues: [{ message: "jobName required" }] }, 400);
    }
    if (!hasApiKeyScope(c, "enqueue") || !isApiKeyJobAllowed(c, jobName)) {
      await recordAudit(c, {
        action: AUDIT_ACTION.JOB_ENQUEUE,
        summary: { path: "generic", jobName },
        result: AUDIT_RESULT.FAILURE,
        errorCode: "enqueue_not_allowed",
      });
      return c.json({ error: "enqueue_not_allowed" as const }, 403);
    }
    const requestId = c.get("requestId")!;
    const redis = getQueuehouseRedis(cfg);
    try {
      const body = genericBodyToJobBody(envelope.payload, envelope.retry);
      const { jobId, queueName } = await enqueueAuthenticatedJob(redis, cfg, {
        jobName,
        body,
        requestId,
        user: { id: user.id, role: user.role },
      });
      await recordAudit(c, {
        action: AUDIT_ACTION.JOB_ENQUEUE,
        summary: { path: "generic", jobName, newJobId: jobId, queueName },
        result: AUDIT_RESULT.SUCCESS,
      });
      return c.json({ jobId, queueName, requestId }, 200);
    } catch (err) {
      if (err instanceof ZodError || isZodIssuesError(err)) {
        const issues = err instanceof ZodError ? err.issues : (err as { issues: unknown }).issues;
        await recordAudit(c, {
          action: AUDIT_ACTION.JOB_ENQUEUE,
          summary: { path: "generic", jobName },
          result: AUDIT_RESULT.FAILURE,
          errorCode: "validation_failed",
        });
        return c.json({ error: "validation_failed" as const, issues }, 400);
      }
      const code = (err as { code?: string }).code;
      if (code === "unknown_job") {
        await recordAudit(c, {
          action: AUDIT_ACTION.JOB_ENQUEUE,
          summary: { path: "generic", jobName },
          result: AUDIT_RESULT.FAILURE,
          errorCode: "unknown_job",
        });
        return c.json({ error: "unknown_job" as const }, 400);
      }
      if (code === "enqueue_not_allowed") {
        await recordAudit(c, {
          action: AUDIT_ACTION.JOB_ENQUEUE,
          summary: { path: "generic", jobName },
          result: AUDIT_RESULT.FAILURE,
          errorCode: "enqueue_not_allowed",
        });
        return c.json({ error: "enqueue_not_allowed" as const }, 403);
      }
      if (code === "retry_override_not_allowed") {
        await recordAudit(c, {
          action: AUDIT_ACTION.JOB_ENQUEUE,
          summary: { path: "generic", jobName },
          result: AUDIT_RESULT.FAILURE,
          errorCode: "retry_override_not_allowed",
        });
        return c.json({ error: "retry_override_not_allowed" as const }, 400);
      }
      if (code === "retry_override_invalid") {
        await recordAudit(c, {
          action: AUDIT_ACTION.JOB_ENQUEUE,
          summary: { path: "generic", jobName },
          result: AUDIT_RESULT.FAILURE,
          errorCode: "retry_override_invalid",
        });
        return c.json({ error: "retry_override_invalid" as const }, 400);
      }
      if (code === "retry_override_out_of_range") {
        await recordAudit(c, {
          action: AUDIT_ACTION.JOB_ENQUEUE,
          summary: { path: "generic", jobName },
          result: AUDIT_RESULT.FAILURE,
          errorCode: "retry_override_out_of_range",
        });
        return c.json({ error: "retry_override_out_of_range" as const }, 400);
      }
      if (code === "retry_with_non_object_payload") {
        await recordAudit(c, {
          action: AUDIT_ACTION.JOB_ENQUEUE,
          summary: { path: "generic", jobName },
          result: AUDIT_RESULT.FAILURE,
          errorCode: "retry_with_non_object_payload",
        });
        return c.json({ error: "retry_with_non_object_payload" as const }, 400);
      }
      throw err;
    }
  });

  app.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: { title: "Queuehouse API", version: "0.0.0" },
    servers: [{ url: "/api/v1" }],
    tags: [
      { name: "enqueue", description: "Typed enqueue-by-job paths from the registry" },
      { name: "tooling", description: "Generic contracts for scripts and integrators" },
      { name: "deprecated", description: "Scheduled for removal" },
    ],
  });

  app.get("/docs", Scalar({ url: "/api/v1/openapi.json" }));

  return app;
}

/** @internal Exposed for contract tests. */
export function getOpenApiDocumentForTests(): object {
  const cfg = loadConfig({
    NODE_ENV: process.env.NODE_ENV ?? "test",
    DATABASE_URL: process.env.DATABASE_URL ?? EXAMPLE_DATABASE_URL,
    REDIS_URL: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
    PORT: process.env.PORT ?? "3000",
  });
  return createApiDocsApp(cfg).getOpenAPIDocument({
    openapi: "3.0.0",
    info: { title: "Queuehouse API", version: "0.0.0" },
    servers: [{ url: "/api/v1" }],
  });
}

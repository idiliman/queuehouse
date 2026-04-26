import "./zod-patch";
import { Scalar } from "@scalar/hono-api-reference";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { JOB_CAPABILITY, listRegisteredJobs } from "@queuehouse/core";
import type { ApiVariables } from "../api-types";

const enqueueNotImplemented = z.object({
  error: z.literal("enqueue_not_implemented"),
});

function hasEnqueueApi(job: { capabilities: readonly string[] }): boolean {
  return job.capabilities.includes(JOB_CAPABILITY.ENQUEUE_API);
}

const genericEnqueueBody = z.object({
  jobName: z
    .string()
    .min(1)
    .describe("Registered job name, e.g. `example.success`."),
  payload: z
    .unknown()
    .describe(
      "JSON payload; must match the target job input schema (validated when enqueue is implemented).",
    ),
});

/**
 * Hono sub-app: protected OpenAPI document, Scalar UI, and documented enqueue
 * stub routes (BullMQ wiring lands in a later issue).
 */
export function createApiDocsApp(): OpenAPIHono<{ Variables: ApiVariables }> {
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
              // Registered at runtime after `extendZodWithOpenApi(z)`; TS cannot see the mixin.
              schema: job.inputSchema as unknown as import("zod").ZodType<
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
        501: {
          description:
            "Enqueue is not yet wired to BullMQ; reserved response shape for the next milestone.",
          content: { "application/json": { schema: enqueueNotImplemented } },
        },
      },
    });
    app.openapi(route, (c) =>
      c.json({ error: "enqueue_not_implemented" } as const, 501),
    );
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
      501: {
        description: "Same stub as per-job paths until the worker slice lands.",
        content: { "application/json": { schema: enqueueNotImplemented } },
      },
    },
  });
  app.openapi(genericRoute, (c) =>
    c.json({ error: "enqueue_not_implemented" } as const, 501),
  );

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
  return createApiDocsApp().getOpenAPIDocument({
    openapi: "3.0.0",
    info: { title: "Queuehouse API", version: "0.0.0" },
    servers: [{ url: "/api/v1" }],
  });
}

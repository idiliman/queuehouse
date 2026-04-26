import "./openapi/zod-patch";
import { config } from "./config";
import { Hono } from "hono";
import type { Context } from "hono";
import { randomBytes } from "node:crypto";
import { QUEUEHOUSE_VERSION, structuredLog } from "@queuehouse/core";
import { runReadinessFromEnv } from "./readyz";
import type { ApiVariables } from "./api-types";
import { getQueuehouseRedis } from "./bullmq/redis";
import { httpRouteTemplate, httpStatusClass } from "./metrics/http-route-template";
import {
  prometheusContentType,
  recordHttpServerRequest,
  renderPrometheusText,
} from "./metrics/prometheus";
import { honoIncomingTraceMiddleware, registerQueuehouseApiTracing } from "./otel/register-tracing";
import { v1 } from "./routes/v1";

const otlpTracingOn = registerQueuehouseApiTracing();

const app = new Hono<{ Variables: ApiVariables }>();

function describeActor(c: Context<{ Variables: ApiVariables }>): string | undefined {
  const user = c.get("user");
  if (user) return `${user.role}:${user.id}`;
  const apiKey = c.get("apiKey");
  if (apiKey) return `api_key:${apiKey.id}`;
  return undefined;
}

if (otlpTracingOn) {
  app.use(honoIncomingTraceMiddleware);
}

app.use(async (c, next) => {
  const fromHeader = c.req.header("X-Request-Id")?.trim();
  const id = fromHeader || `req_${randomBytes(12).toString("base64url")}`;
  c.set("requestId", id);
  await next();
  c.header("X-Request-Id", c.get("requestId")!);
});

app.use(async (c, next) => {
  const t0 = performance.now();
  await next();
  const durationSeconds = (performance.now() - t0) / 1000;
  const path = new URL(c.req.url).pathname;
  const route = httpRouteTemplate(path);
  const statusClass = httpStatusClass(c.res.status);
  recordHttpServerRequest({
    method: c.req.method,
    routeTemplate: route,
    statusClass,
    durationSeconds,
  });
  if (config.nodeEnv === "production") {
    structuredLog(config, "queuehouse-api", "info", "http_request", {
      requestId: c.get("requestId"),
      method: c.req.method,
      route,
      status: c.res.status,
      statusClass,
      durationMs: Math.round(durationSeconds * 1000),
      actor: describeActor(c),
    });
  }
});

const healthPayload = () => ({
  status: "ok" as const,
  service: "queuehouse-api",
  version: QUEUEHOUSE_VERSION,
  namespace: config.namespace,
});

app.get("/healthz", (c) => c.json(healthPayload()));
/** @deprecated use /healthz */
app.get("/health", (c) => c.json(healthPayload()));

app.get("/readyz", async (c) => {
  try {
    await runReadinessFromEnv();
    return c.json({ status: "ready", service: "queuehouse-api" }, 200);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return c.json(
      { status: "not_ready", service: "queuehouse-api", error: message },
      503,
    );
  }
});

app.get("/metrics", async (c) => {
  const redis = getQueuehouseRedis(config);
  const body = await renderPrometheusText(redis, config);
  return c.text(body, 200, { "Content-Type": prometheusContentType() });
});

app.route("/api/v1", v1);

export default app;

if (import.meta.main) {
  const port = config.port;
  structuredLog(
    config,
    "queuehouse-api",
    "info",
    `listening on http://localhost:${port}`,
    { port },
  );
  Bun.serve({ port, fetch: app.fetch });
  void import("./schedules/startup")
    .then((m) => m.runScheduleStartupReconciliation())
    .catch((e) => console.error("[schedules] startup reconcile failed:", e));
}

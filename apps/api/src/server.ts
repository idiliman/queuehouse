import { config } from "./config";
import { Hono } from "hono";
import { randomBytes } from "node:crypto";
import { QUEUEHOUSE_VERSION } from "@queuehouse/core";
import { runReadinessFromEnv } from "./readyz";

const app = new Hono<{
  Variables: { requestId: string };
}>();

app.use(async (c, next) => {
  const fromHeader = c.req.header("X-Request-Id")?.trim();
  const id = fromHeader || `req_${randomBytes(12).toString("base64url")}`;
  c.set("requestId", id);
  await next();
  c.header("X-Request-Id", c.get("requestId")!);
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

export default app;

if (import.meta.main) {
  const port = config.port;
  console.log(
    `Queuehouse API [${config.namespace}] listening on http://localhost:${port}`,
  );
  Bun.serve({ port, fetch: app.fetch });
}

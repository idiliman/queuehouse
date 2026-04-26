import { Hono } from "hono";
import { QUEUEHOUSE_VERSION } from "@queuehouse/core";

const app = new Hono();

app.get("/health", (c) =>
  c.json({ status: "ok", service: "queuehouse-api", version: QUEUEHOUSE_VERSION }),
);

export default app;

if (import.meta.main) {
  const port = Number(process.env.PORT) || 3000;
  console.log(`Queuehouse API listening on http://localhost:${port}`);
  Bun.serve({ port, fetch: app.fetch });
}

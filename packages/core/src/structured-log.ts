import type { QueuehouseConfig } from "./config";

export type StructuredLogLevel = "debug" | "info" | "warn" | "error";

export type QueuehouseServiceName = "queuehouse-api" | "queuehouse-worker";

/**
 * In production, writes one JSON object per line (no pretty printing).
 * In development/test, writes a short prefixed line for humans.
 */
export function structuredLog(
  cfg: Pick<QueuehouseConfig, "nodeEnv" | "namespace">,
  service: QueuehouseServiceName,
  level: StructuredLogLevel,
  message: string,
  fields?: Record<string, unknown>,
): void {
  const { nodeEnv, namespace } = cfg;
  if (nodeEnv === "production") {
    const line: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      msg: message,
      service,
      namespace,
    };
    if (fields) {
      for (const [k, v] of Object.entries(fields)) {
        if (v !== undefined) line[k] = v;
      }
    }
    const s = JSON.stringify(line);
    if (level === "error" || level === "warn") {
      console.error(s);
    } else {
      console.log(s);
    }
    return;
  }

  const extra =
    fields && Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : "";
  const prefix = `[${service}] [${namespace}]`;
  const out = `${prefix} ${message}${extra}`;
  if (level === "error" || level === "warn") {
    console.error(out);
  } else {
    console.log(out);
  }
}

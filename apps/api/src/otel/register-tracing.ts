import { context, propagation, ROOT_CONTEXT } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { MiddlewareHandler } from "hono";

let otlpTracingEnabled = false;

function otlpTracesUrl(): string | undefined {
  const traces = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
  const base = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  const raw = traces || base;
  if (!raw) {
    return undefined;
  }
  if (/\/v1\/traces$/i.test(raw)) {
    return raw;
  }
  return `${raw.replace(/\/$/, "")}/v1/traces`;
}

/**
 * Registers OTLP trace export and W3C propagation when `OTEL_EXPORTER_OTLP_*` is set.
 * Safe to call once at process startup; no-op when unset.
 */
export function registerQueuehouseApiTracing(): boolean {
  const url = otlpTracesUrl();
  if (!url) {
    return false;
  }
  context.setGlobalContextManager(new AsyncLocalStorageContextManager());
  const serviceName =
    process.env.OTEL_SERVICE_NAME?.trim() || process.env.QUEUEHOUSE_OTEL_SERVICE_NAME?.trim() || "queuehouse-api";
  const exporter = new OTLPTraceExporter({ url });
  const provider = new BasicTracerProvider({
    resource: new Resource({ "service.name": serviceName }),
  });
  provider.addSpanProcessor(new BatchSpanProcessor(exporter));
  provider.register();
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  otlpTracingEnabled = true;
  return true;
}

export function isQueuehouseOtlpTracingEnabled(): boolean {
  return otlpTracingEnabled;
}

const headerGetter = {
  get(carrier: Record<string, string | undefined>, key: string): string | undefined {
    const v = carrier[key];
    return typeof v === "string" && v.length > 0 ? v : undefined;
  },
  keys(carrier: Record<string, string | undefined>): string[] {
    return Object.keys(carrier).filter((k) => carrier[k] != null && carrier[k] !== "");
  },
};

/** Runs the request with parent context extracted from W3C trace headers when present. */
export const honoIncomingTraceMiddleware: MiddlewareHandler = async (c, next) => {
  const carrier: Record<string, string | undefined> = {
    traceparent: c.req.header("traceparent"),
    tracestate: c.req.header("tracestate"),
  };
  const ctx = propagation.extract(ROOT_CONTEXT, carrier, headerGetter);
  await context.with(ctx, async () => {
    await next();
  });
};

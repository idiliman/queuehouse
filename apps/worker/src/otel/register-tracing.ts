import { context, propagation } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";

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

export function registerQueuehouseWorkerTracing(): boolean {
  const url = otlpTracesUrl();
  if (!url) {
    return false;
  }
  context.setGlobalContextManager(new AsyncLocalStorageContextManager());
  const serviceName =
    process.env.OTEL_SERVICE_NAME?.trim() || process.env.QUEUEHOUSE_OTEL_SERVICE_NAME?.trim() || "queuehouse-worker";
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

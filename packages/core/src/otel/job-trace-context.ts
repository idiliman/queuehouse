import { context, propagation, ROOT_CONTEXT, SpanKind, trace } from "@opentelemetry/api";

const TP = "traceparent";
const TS = "tracestate";

const textMapSetter = {
  set(carrier: Record<string, string>, key: string, value: string): void {
    carrier[key] = value;
  },
};

const textMapGetter = {
  get(carrier: Record<string, string | undefined>, key: string): string | undefined {
    const v = carrier[key];
    return typeof v === "string" && v.length > 0 ? v : undefined;
  },
  keys(carrier: Record<string, string | undefined>): string[] {
    return Object.keys(carrier).filter((k) => carrier[k] != null && carrier[k] !== "");
  },
};

/**
 * Serialize the active trace context into Bull job `data.traceContext` using W3C Trace Context.
 * No-op when there is nothing to inject (default global propagator / no active span).
 */
export function injectTraceContextIntoJobData(data: Record<string, unknown>): void {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier, textMapSetter);
  if (!carrier[TP]) {
    return;
  }
  const traceContext: { traceparent: string; tracestate?: string } = {
    traceparent: carrier[TP]!,
  };
  if (carrier[TS]) {
    traceContext.tracestate = carrier[TS];
  }
  data.traceContext = traceContext;
}

export function parseTraceCarrierFromJobData(jobData: unknown): Record<string, string> | undefined {
  if (jobData === null || typeof jobData !== "object" || Array.isArray(jobData)) {
    return undefined;
  }
  const raw = (jobData as Record<string, unknown>).traceContext;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const o = raw as Record<string, unknown>;
  const traceparent = o.traceparent;
  if (typeof traceparent !== "string" || !traceparent.trim()) {
    return undefined;
  }
  const carrier: Record<string, string> = { traceparent: traceparent.trim() };
  const tracestate = o.tracestate;
  if (typeof tracestate === "string" && tracestate.trim()) {
    carrier.tracestate = tracestate.trim();
  }
  return carrier;
}

export function contextFromJobTraceCarrier(carrier: Record<string, string> | undefined) {
  if (!carrier) {
    return ROOT_CONTEXT;
  }
  const c: Record<string, string | undefined> = { ...carrier };
  return propagation.extract(ROOT_CONTEXT, c, textMapGetter);
}

/**
 * Run `fn` inside a consumer span, parent-linked from `jobData.traceContext` when present.
 */
export async function runWithJobTraceContext<T>(
  jobData: unknown,
  spanName: string,
  fn: () => Promise<T>,
): Promise<T> {
  const carrier = parseTraceCarrierFromJobData(jobData);
  const parentCtx = contextFromJobTraceCarrier(carrier);
  const tracer = trace.getTracer("queuehouse");
  return context.with(parentCtx, async () =>
    tracer.startActiveSpan(spanName, { kind: SpanKind.CONSUMER }, async (span) => {
      try {
        return await fn();
      } finally {
        span.end();
      }
    }),
  );
}

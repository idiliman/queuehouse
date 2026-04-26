import { describe, expect, it } from "bun:test";
import { context, propagation, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
  injectTraceContextIntoJobData,
  runWithJobTraceContext,
} from "../../src/otel/job-trace-context";

describe("job trace context (OpenTelemetry)", () => {
  it("injects W3C context on enqueue and links worker processing spans in the same trace", async () => {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager());
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider();
    provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
    provider.register();
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());

    const tracer = trace.getTracer("test");
    const job: Record<string, unknown> = { jobName: "example.success" };
    tracer.startActiveSpan("enqueue", (span) => {
      injectTraceContextIntoJobData(job);
      span.end();
    });
    await provider.forceFlush();

    const tc = job.traceContext as { traceparent: string; tracestate?: string } | undefined;
    expect(tc?.traceparent).toMatch(/^00-[a-f0-9]{32}-[a-f0-9]{16}-0[0-1]$/);

    await runWithJobTraceContext(job, "queuehouse.job.run", async () => "done");
    await provider.forceFlush();

    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBe(2);
    const traceIds = new Set(spans.map((s) => s.spanContext().traceId));
    expect(traceIds.size).toBe(1);

    const enqueue = spans.find((s) => s.name === "enqueue");
    const worker = spans.find((s) => s.name === "queuehouse.job.run");
    expect(enqueue).toBeDefined();
    expect(worker).toBeDefined();
    expect(worker!.spanContext().traceId).toBe(enqueue!.spanContext().traceId);
    expect(worker!.spanContext().spanId).not.toBe(enqueue!.spanContext().spanId);

    await provider.shutdown();
  });
});

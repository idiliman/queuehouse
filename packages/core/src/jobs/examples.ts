import { z } from "zod";
import { defineJob } from "./defineJob";
import { JOB_CAPABILITY } from "./types";

/** BullMQ disallows `:` in queue names; use a safe delimiter. */
const exampleQueue = "queuehouse-example";

/** Echoes input — happy-path reference job. */
export const exampleSuccessJob = defineJob({
  name: "example.success",
  schemaVersion: 1,
  queue: exampleQueue,
  capabilities: [
    JOB_CAPABILITY.ENQUEUE_API,
    JOB_CAPABILITY.ENQUEUE_INTERNAL,
    JOB_CAPABILITY.MANUAL_UI,
  ],
  input: z.object({
    message: z.string().min(1).max(4096),
  }),
  output: z.object({
    echoed: z.string(),
  }),
  retry: { maxAttempts: 3, backoffMs: 500 },
  timeoutMs: 30_000,
  redaction: {
    payloadPaths: ["message"],
  },
  description: "Validates input/output wiring; echoes message in the result.",
});

/** Simulates stepped work — use with worker progress updates in later slices. */
export const exampleProgressJob = defineJob({
  name: "example.progress",
  schemaVersion: 1,
  queue: exampleQueue,
  capabilities: [JOB_CAPABILITY.ENQUEUE_INTERNAL, JOB_CAPABILITY.MANUAL_UI],
  input: z.object({
    steps: z.number().int().min(1).max(100),
  }),
  output: z.object({
    completed: z.number().int(),
    log: z.array(z.string()).max(200),
  }),
  retry: { maxAttempts: 2, backoffMs: 1_000 },
  timeoutMs: 120_000,
  redaction: {},
  description: "Reference job for progress and structured logs once BullMQ progress lands.",
});

/** Marked deprecated in OpenAPI; kept for contract tests and migration demos. */
export const exampleDeprecatedJob = defineJob({
  name: "example.deprecated",
  schemaVersion: 1,
  queue: exampleQueue,
  capabilities: [JOB_CAPABILITY.ENQUEUE_API, JOB_CAPABILITY.ENQUEUE_INTERNAL],
  input: z.object({
    legacy: z.boolean().optional(),
  }),
  output: z.object({
    done: z.boolean(),
  }),
  retry: { maxAttempts: 1, backoffMs: 100 },
  timeoutMs: 5_000,
  redaction: {},
  description: "Demonstrates the deprecated OpenAPI flag for public enqueue paths.",
  deprecated: true,
});

/** Always fails — DLQ / retry policy tests in later slices. */
export const exampleFailJob = defineJob({
  name: "example.fail",
  schemaVersion: 1,
  queue: exampleQueue,
  capabilities: [JOB_CAPABILITY.ENQUEUE_INTERNAL, JOB_CAPABILITY.MANUAL_UI],
  input: z.object({
    errorMessage: z.string().max(512).optional(),
  }),
  /** Successful completion is invalid for this job; parsers reject any payload. */
  output: z.never(),
  retry: { maxAttempts: 5, backoffMs: 250 },
  timeoutMs: 10_000,
  redaction: {
    payloadPaths: ["errorMessage"],
  },
  description: "Throws after validating input; used to exercise failure and DLQ paths.",
});

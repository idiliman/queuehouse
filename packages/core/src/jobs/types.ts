import type { z } from "zod";

/** Suggested capability tokens; definitions may use these or app-specific strings. */
export const JOB_CAPABILITY = {
  /** Job may be enqueued via public HTTP API (when wired). */
  ENQUEUE_API: "enqueue.api",
  /** Internal / system-only enqueue. */
  ENQUEUE_INTERNAL: "enqueue.internal",
  /** Listed in operator manual-enqueue UI. */
  MANUAL_UI: "manual.ui",
  /** Eligible for cron / schedule UI. */
  SCHEDULABLE: "schedulable",
} as const;

export type JobCapability = (typeof JOB_CAPABILITY)[keyof typeof JOB_CAPABILITY];

export type JobRetryDefaults = {
  /** BullMQ-style attempt budget including the first run. */
  maxAttempts?: number;
  /** Base delay in ms before retry (linear/simple; worker may refine). */
  backoffMs?: number;
};

/** Declares which logical paths are treated as sensitive in operator surfaces. */
export type JobRedactionMeta = {
  /** Dot-paths or simple keys under payload to treat as sensitive (e.g. `user.email`). */
  payloadPaths?: string[];
  /** Dot-paths under job result / return value. */
  resultPaths?: string[];
};

export type RegisteredJob = {
  readonly name: string;
  readonly schemaVersion: number;
  readonly queue: string;
  readonly capabilities: readonly string[];
  readonly inputSchema: z.ZodTypeAny;
  readonly outputSchema: z.ZodTypeAny;
  readonly retry: JobRetryDefaults;
  readonly timeoutMs?: number;
  readonly redaction: JobRedactionMeta;
  readonly description?: string;
};

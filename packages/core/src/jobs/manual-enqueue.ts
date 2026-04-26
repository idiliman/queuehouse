/** Bounds for admin manual enqueue (web UI). */
export const MANUAL_ENQUEUE_LIMITS = {
  /** Max delay from now when using `delay` or `runAt` (30 days). */
  maxDelayMs: 30 * 24 * 60 * 60 * 1000,
  /** Max time the API will block waiting for job completion. */
  maxWaitTimeoutMs: 120_000,
  /** BullMQ priority: 0 = highest, 2_097_152 = lowest. */
  minPriority: 0,
  maxPriority: 2_097_152,
} as const;

function throwManualCode(code: string): never {
  const e = new Error(code) as Error & { code?: string };
  e.code = code;
  throw e;
}

/**
 * Merge optional per-request `retry` into an object payload for `splitJobEnqueueBody`.
 * Same rules as API generic enqueue.
 */
export function mergePayloadWithRetryForEnqueue(payload: unknown, retry: unknown): unknown {
  if (retry === undefined) return payload;
  if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
    return { ...(payload as Record<string, unknown>), retry };
  }
  throwManualCode("retry_with_non_object_payload");
}

/**
 * Resolve delay in ms for manual enqueue. `delay` and `runAt` are mutually exclusive.
 */
export function resolveManualEnqueueDelayMs(opts: { delay?: number; runAt?: string }): number {
  const hasDelay = opts.delay != null;
  const hasRunAt = opts.runAt != null && opts.runAt !== "";
  if (hasDelay && hasRunAt) {
    throwManualCode("manual_delay_runAt_exclusive");
  }
  if (hasRunAt) {
    const d = new Date(opts.runAt!);
    if (Number.isNaN(d.getTime())) {
      throwManualCode("invalid_runAt");
    }
    const ms = Math.max(0, d.getTime() - Date.now());
    return Math.min(ms, MANUAL_ENQUEUE_LIMITS.maxDelayMs);
  }
  if (hasDelay) {
    if (!Number.isInteger(opts.delay) || opts.delay! < 0) {
      throwManualCode("invalid_delay");
    }
    return Math.min(opts.delay!, MANUAL_ENQUEUE_LIMITS.maxDelayMs);
  }
  return 0;
}

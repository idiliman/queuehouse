import type { RegisteredJob } from "./types";

/**
 * Registry retry defaults for a job, merged with the defineJob default of maxAttempts: 1 when absent.
 * Used for enqueue opts and operator-facing detail.
 */
export function getEffectiveRetryOptions(job: RegisteredJob): {
  maxAttempts: number;
  backoffMs?: number;
} {
  const maxAttempts = job.retry.maxAttempts ?? 1;
  const backoffMs = job.retry.backoffMs;
  return backoffMs != null ? { maxAttempts, backoffMs } : { maxAttempts };
}

export type EnqueueRetryOverride = {
  maxAttempts?: number;
  backoffMs?: number;
};

function throwRetryCode(code: string): never {
  const e = new Error(code) as Error & { code?: string };
  e.code = code;
  throw e;
}

/**
 * Split optional `retry` from a per-job enqueue JSON body. When present, the job must declare `retryOverrides`.
 */
export function splitJobEnqueueBody(
  job: RegisteredJob,
  body: unknown,
): { payload: unknown; retryOverride?: EnqueueRetryOverride } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { payload: body };
  }
  const rec = body as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(rec, "retry")) {
    return { payload: body };
  }
  if (!job.retryOverrides) {
    throwRetryCode("retry_override_not_allowed");
  }
  const retryRaw = rec.retry;
  const { retry: _drop, ...rest } = rec;
  if (retryRaw === undefined) {
    return { payload: rest };
  }
  if (retryRaw !== null && (typeof retryRaw !== "object" || Array.isArray(retryRaw))) {
    throwRetryCode("retry_override_invalid");
  }
  if (retryRaw === null) {
    throwRetryCode("retry_override_invalid");
  }
  const r = retryRaw as Record<string, unknown>;
  const retryOverride: EnqueueRetryOverride = {};
  if ("maxAttempts" in r) {
    const v = r.maxAttempts;
    if (typeof v !== "number" || !Number.isInteger(v)) {
      throwRetryCode("retry_override_invalid");
    }
    retryOverride.maxAttempts = v;
  }
  if ("backoffMs" in r) {
    const v = r.backoffMs;
    if (typeof v !== "number" || !Number.isInteger(v)) {
      throwRetryCode("retry_override_invalid");
    }
    retryOverride.backoffMs = v;
  }
  const keys = Object.keys(r);
  const allowed = new Set(["maxAttempts", "backoffMs"]);
  if (keys.some((k) => !allowed.has(k))) {
    throwRetryCode("retry_override_invalid");
  }
  if (retryOverride.maxAttempts === undefined && retryOverride.backoffMs === undefined) {
    return { payload: rest };
  }
  return { payload: rest, retryOverride };
}

/**
 * Merge registry defaults with a validated enqueue override (bounded by `job.retryOverrides`).
 */
export function resolveBullmqRetryForEnqueue(
  job: RegisteredJob,
  override: EnqueueRetryOverride | undefined,
): { maxAttempts: number; backoffMs?: number } {
  const base = getEffectiveRetryOptions(job);
  if (!override) {
    return base;
  }
  if (!job.retryOverrides) {
    throwRetryCode("retry_override_not_allowed");
  }
  let maxAttempts = base.maxAttempts;
  let backoffMs = base.backoffMs;

  if (override.maxAttempts !== undefined) {
    const b = job.retryOverrides.maxAttempts;
    if (!b) {
      throwRetryCode("retry_override_out_of_range");
    }
    if (override.maxAttempts < b.min || override.maxAttempts > b.max) {
      throwRetryCode("retry_override_out_of_range");
    }
    maxAttempts = override.maxAttempts;
  }
  if (override.backoffMs !== undefined) {
    const b = job.retryOverrides.backoffMs;
    if (!b) {
      throwRetryCode("retry_override_out_of_range");
    }
    if (override.backoffMs < b.min || override.backoffMs > b.max) {
      throwRetryCode("retry_override_out_of_range");
    }
    backoffMs = override.backoffMs;
  }

  return backoffMs != null ? { maxAttempts, backoffMs } : { maxAttempts };
}

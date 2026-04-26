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

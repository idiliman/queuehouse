import type { JobRedactionMeta, JobRetryDefaults, RegisteredJob } from "./types";

const NAME_RE = /^[a-z][a-z0-9._-]{0,127}$/;

export function assertValidJobName(name: string): void {
  const n = name.trim();
  if (!NAME_RE.test(n)) {
    throw new Error(
      `Invalid job name "${name}": use lowercase start, [a-z0-9._-], max 128 chars.`,
    );
  }
}

export function assertValidQueueName(queue: string): void {
  const q = queue.trim();
  if (!q || q.length > 128) {
    throw new Error(`Invalid queue "${queue}": non-empty string, max 128 chars.`);
  }
  if (!/^[a-zA-Z0-9:_-]+$/.test(q)) {
    throw new Error(
      `Invalid queue "${queue}": use letters, digits, colon, underscore, hyphen.`,
    );
  }
}

function assertRetryDefaults(retry: JobRetryDefaults): void {
  const { maxAttempts, backoffMs } = retry;
  if (maxAttempts !== undefined) {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) {
      throw new Error(`retry.maxAttempts must be an integer 1–100 (got ${maxAttempts}).`);
    }
  }
  if (backoffMs !== undefined) {
    if (!Number.isInteger(backoffMs) || backoffMs < 0 || backoffMs > 86_400_000) {
      throw new Error(
        `retry.backoffMs must be an integer 0–86400000 ms (got ${backoffMs}).`,
      );
    }
  }
}

function assertRedaction(meta: JobRedactionMeta): void {
  const paths = [...(meta.payloadPaths ?? []), ...(meta.resultPaths ?? [])];
  for (const p of paths) {
    if (typeof p !== "string" || !p.trim()) {
      throw new Error("Redaction paths must be non-empty strings.");
    }
    if (p.length > 256) {
      throw new Error(`Redaction path too long: "${p.slice(0, 32)}…"`);
    }
  }
}

export function assertValidRegisteredJob(job: RegisteredJob): void {
  assertValidJobName(job.name);
  assertValidQueueName(job.queue);

  if (!Number.isInteger(job.schemaVersion) || job.schemaVersion < 1) {
    throw new Error(
      `Job "${job.name}": schemaVersion must be a positive integer (got ${job.schemaVersion}).`,
    );
  }

  if (!Array.isArray(job.capabilities)) {
    throw new Error(`Job "${job.name}": capabilities must be an array.`);
  }
  for (const c of job.capabilities) {
    if (typeof c !== "string" || !c.trim()) {
      throw new Error(`Job "${job.name}": capability entries must be non-empty strings.`);
    }
  }

  if (job.timeoutMs !== undefined) {
    if (!Number.isInteger(job.timeoutMs) || job.timeoutMs < 1 || job.timeoutMs > 86_400_000) {
      throw new Error(
        `Job "${job.name}": timeoutMs must be 1–86400000 (got ${job.timeoutMs}).`,
      );
    }
  }

  assertRetryDefaults(job.retry);
  assertRedaction(job.redaction);
}

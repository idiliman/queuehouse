import { z } from "zod";
import type {
  JobRedactionMeta,
  JobRetryDefaults,
  JobRetryOverrideBounds,
  RegisteredJob,
} from "./types";

export type DefineJobOptions = {
  name: string;
  schemaVersion: number;
  queue: string;
  capabilities: readonly string[];
  input: z.ZodTypeAny;
  output: z.ZodTypeAny;
  retry?: JobRetryDefaults;
  retryOverrides?: JobRetryOverrideBounds;
  timeoutMs?: number;
  redaction?: JobRedactionMeta;
  description?: string;
  deprecated?: boolean;
};

export function defineJob(opts: DefineJobOptions): RegisteredJob {
  if (opts.retryOverrides && !(opts.input instanceof z.ZodObject)) {
    throw new Error(`Job "${opts.name}": retryOverrides require a ZodObject input schema`);
  }
  const retry: JobRetryDefaults = opts.retry ?? {};
  const redaction: JobRedactionMeta = {
    payloadPaths: opts.redaction?.payloadPaths ? [...opts.redaction.payloadPaths] : [],
    resultPaths: opts.redaction?.resultPaths ? [...opts.redaction.resultPaths] : [],
  };

  const job: RegisteredJob = {
    name: opts.name.trim(),
    schemaVersion: opts.schemaVersion,
    queue: opts.queue.trim(),
    capabilities: [...opts.capabilities],
    inputSchema: opts.input,
    outputSchema: opts.output,
    retry,
    retryOverrides: opts.retryOverrides,
    timeoutMs: opts.timeoutMs,
    redaction,
    description: opts.description?.trim() || undefined,
    deprecated: opts.deprecated,
  };

  return job;
}

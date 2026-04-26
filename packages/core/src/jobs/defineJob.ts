import type { z } from "zod";
import type {
  JobRedactionMeta,
  JobRetryDefaults,
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
  timeoutMs?: number;
  redaction?: JobRedactionMeta;
  description?: string;
};

export function defineJob(opts: DefineJobOptions): RegisteredJob {
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
    timeoutMs: opts.timeoutMs,
    redaction,
    description: opts.description?.trim() || undefined,
  };

  return job;
}

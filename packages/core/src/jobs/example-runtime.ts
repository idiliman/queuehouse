import type { RegisteredJob } from "./types";
import { exampleFailJob, exampleProgressJob, exampleSuccessJob } from "./examples";

/**
 * Minimal synchronous handlers so tests (and future worker stubs) can exercise
 * success / progress-shaped output / failure without BullMQ.
 */
export function runExampleJobSync(job: RegisteredJob, rawInput: unknown): unknown {
  const input = job.inputSchema.parse(rawInput);

  if (job.name === exampleSuccessJob.name) {
    const { message } = input as { message: string };
    return job.outputSchema.parse({ echoed: message });
  }

  if (job.name === exampleProgressJob.name) {
    const { steps } = input as { steps: number };
    const log: string[] = [];
    for (let i = 1; i <= steps; i++) {
      log.push(`step ${i}/${steps}`);
    }
    return job.outputSchema.parse({ completed: steps, log });
  }

  if (job.name === exampleFailJob.name) {
    const { errorMessage } = input as { errorMessage?: string };
    throw new Error(errorMessage ?? "intentional failure");
  }

  throw new Error(`No example runtime for job "${job.name}"`);
}

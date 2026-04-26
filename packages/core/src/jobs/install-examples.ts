import {
  exampleDeprecatedJob,
  exampleDlqJob,
  exampleFailJob,
  exampleProgressJob,
  exampleSuccessJob,
} from "./examples";
import { registerJob } from "./registry";
import { queuehouseBulkDlqJob } from "./system-jobs";

/** Registers bundled example jobs (idempotent if registry was cleared first). */
export function registerExampleJobs(): void {
  registerJob(exampleSuccessJob);
  registerJob(exampleProgressJob);
  registerJob(exampleDeprecatedJob);
  registerJob(exampleFailJob);
  registerJob(exampleDlqJob);
  registerJob(queuehouseBulkDlqJob);
}

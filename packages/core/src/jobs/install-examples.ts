import { exampleFailJob, exampleProgressJob, exampleSuccessJob } from "./examples";
import { registerJob } from "./registry";

/** Registers bundled example jobs (idempotent if registry was cleared first). */
export function registerExampleJobs(): void {
  registerJob(exampleSuccessJob);
  registerJob(exampleProgressJob);
  registerJob(exampleFailJob);
}

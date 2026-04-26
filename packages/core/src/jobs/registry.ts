import type { RegisteredJob } from "./types";
import { assertValidRegisteredJob } from "./validation";

const byName = new Map<string, RegisteredJob>();

export function registerJob(job: RegisteredJob): void {
  if (byName.has(job.name)) {
    throw new Error(`Duplicate job name registered: ${job.name}`);
  }
  assertValidRegisteredJob(job);
  byName.set(job.name, job);
}

export function getRegisteredJob(name: string): RegisteredJob | undefined {
  return byName.get(name);
}

export function listRegisteredJobs(): RegisteredJob[] {
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** @internal Test helper */
export function clearJobRegistryForTests(): void {
  byName.clear();
}

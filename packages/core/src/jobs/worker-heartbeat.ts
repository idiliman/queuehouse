import { bullmqPrefix } from "./queue-data";

/** Redis key TTL for worker liveness; keys disappear if the process stops refreshing. */
export const WORKER_HEARTBEAT_TTL_SEC = 45;

/** How often the worker process refreshes its heartbeat key. */
export const WORKER_HEARTBEAT_REFRESH_MS = 15_000;

export type WorkerHeartbeatPayload = {
  instanceId: string;
  coreVersion: string;
  queues: string[];
  concurrency: number;
  hostname: string;
  pid: number;
  startedAt: string;
};

export function workerHeartbeatRedisKey(namespace: string, instanceId: string): string {
  return `${bullmqPrefix(namespace)}:workerhb:${instanceId}`;
}

/** Pattern for SCAN (e.g. `queuehouse:qh:workerhb:*`). */
export function workerHeartbeatKeyPattern(namespace: string): string {
  return `${bullmqPrefix(namespace)}:workerhb:*`;
}

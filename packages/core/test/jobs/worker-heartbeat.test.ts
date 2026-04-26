import { describe, expect, it } from "bun:test";
import {
  workerHeartbeatKeyPattern,
  workerHeartbeatRedisKey,
  WORKER_HEARTBEAT_REFRESH_MS,
  WORKER_HEARTBEAT_TTL_SEC,
} from "../../src/jobs/worker-heartbeat";

describe("worker heartbeat redis keys", () => {
  it("uses bullmq prefix and instance id", () => {
    expect(workerHeartbeatRedisKey("queuehouse", "abc")).toBe("queuehouse:qh:workerhb:abc");
  });

  it("pattern matches all instance keys for namespace", () => {
    expect(workerHeartbeatKeyPattern("queuehouse")).toBe("queuehouse:qh:workerhb:*");
  });

  it("exports sane timing constants", () => {
    expect(WORKER_HEARTBEAT_TTL_SEC).toBeGreaterThan(WORKER_HEARTBEAT_REFRESH_MS / 1000);
  });
});

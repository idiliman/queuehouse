import { describe, expect, it } from "bun:test";
import type { Worker } from "bullmq";
import { bullmqWorkerGracefulShutdown } from "../src/bullmq-graceful-shutdown";

describe("bullmqWorkerGracefulShutdown", () => {
  it("is a no-op for an empty list", async () => {
    await bullmqWorkerGracefulShutdown([], { graceMs: 5_000 });
  });

  it("uses close(false) when all workers are idle before grace elapses", async () => {
    const closes: boolean[] = [];
    const w = {
      pause: async (doNotWait?: boolean) => {
        expect(doNotWait).toBe(true);
      },
      close: async (force?: boolean) => {
        closes.push(force === true);
      },
      cancelAllJobs: () => undefined,
      lockManager: { getActiveJobCount: () => 0 },
    } as unknown as Worker;

    await bullmqWorkerGracefulShutdown([w], { graceMs: 20_000 });
    expect(closes).toEqual([false]);
  });

  it("after grace, calls cancelAllJobs and close(true) when work never drains", async () => {
    const closes: boolean[] = [];
    const cancels: number[] = [];
    let active = 1;
    const w = {
      pause: async () => undefined,
      close: async (force?: boolean) => {
        closes.push(force === true);
        if (force) {
          active = 0;
        } else {
          return new Promise(() => {
            /* unresponsive until force */
          });
        }
      },
      cancelAllJobs: () => {
        cancels.push(1);
      },
      lockManager: { getActiveJobCount: () => active },
    } as unknown as Worker;

    await bullmqWorkerGracefulShutdown([w], { graceMs: 2 });
    expect(cancels).toEqual([1]);
    expect(closes).toEqual([true]);
  });

  it("uses close(false) if cancelAllJobs leaves no active work", async () => {
    const closes: boolean[] = [];
    let active = 1;
    const w = {
      pause: async () => undefined,
      close: async (force?: boolean) => {
        closes.push(force === true);
      },
      cancelAllJobs: () => {
        active = 0;
      },
      lockManager: { getActiveJobCount: () => active },
    } as unknown as Worker;

    await bullmqWorkerGracefulShutdown([w], { graceMs: 1 });
    expect(closes).toEqual([false]);
  });
});

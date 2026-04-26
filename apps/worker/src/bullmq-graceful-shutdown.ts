import type { Worker } from "bullmq";

type LockManager = { getActiveJobCount: () => number };

function activeJobCount(w: Worker): number {
  const lm = (w as unknown as { lockManager: LockManager }).lockManager;
  return lm.getActiveJobCount();
}

const POLL_MS = 25;
const CANCEL_SETTLE_MS = 5;

/**
 * Stops new work, waits up to `graceMs` for in-flight jobs, then cancels
 * and closes workers. Uses a single `close(force)` per worker as required by BullMQ.
 */
export async function bullmqWorkerGracefulShutdown(
  workers: Worker[],
  options: { graceMs: number; onLog?: (line: string) => void; cancelReason?: string },
): Promise<void> {
  const log = options.onLog ?? (() => undefined);
  const reason = options.cancelReason ?? "queuehouse-shutdown";
  if (workers.length === 0) {
    return;
  }

  await Promise.all(workers.map((w) => w.pause(true)));
  const deadline = Date.now() + options.graceMs;
  const graceMs = options.graceMs;

  if (graceMs > 0) {
    while (Date.now() < deadline) {
      if (workers.every((w) => activeJobCount(w) === 0)) {
        log(
          "[queuehouse-worker] shutdown: all workers idle before grace elapsed, closing…",
        );
        await Promise.all(workers.map((w) => w.close(false)));
        return;
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  } else {
    if (workers.every((w) => activeJobCount(w) === 0)) {
      log("[queuehouse-worker] shutdown: no grace, idle, closing…");
      await Promise.all(workers.map((w) => w.close(false)));
      return;
    }
  }

  if (workers.some((w) => activeJobCount(w) > 0)) {
    log(
      "[queuehouse-worker] shutdown: grace elapsed or zero grace with active work, canceling in-flight…",
    );
    for (const w of workers) w.cancelAllJobs(reason);
    await new Promise((r) => setTimeout(r, CANCEL_SETTLE_MS));
  }

  await Promise.all(
    workers.map((w) => w.close(activeJobCount(w) > 0)),
  );
}

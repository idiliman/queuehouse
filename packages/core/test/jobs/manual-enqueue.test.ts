import { describe, expect, it } from "bun:test";
import {
  MANUAL_ENQUEUE_LIMITS,
  mergePayloadWithRetryForEnqueue,
  resolveManualEnqueueDelayMs,
} from "../../src/jobs/manual-enqueue";

describe("mergePayloadWithRetryForEnqueue", () => {
  it("merges retry into object payload", () => {
    expect(mergePayloadWithRetryForEnqueue({ a: 1 }, { maxAttempts: 2 })).toEqual({
      a: 1,
      retry: { maxAttempts: 2 },
    });
  });

  it("rejects retry with non-object payload", () => {
    expect(() => mergePayloadWithRetryForEnqueue("x", { maxAttempts: 2 })).toThrow();
  });
});

describe("resolveManualEnqueueDelayMs", () => {
  it("returns 0 when neither delay nor runAt", () => {
    expect(resolveManualEnqueueDelayMs({})).toBe(0);
  });

  it("throws when delay and runAt both set", () => {
    expect(() =>
      resolveManualEnqueueDelayMs({ delay: 1000, runAt: "2026-01-01T00:00:00.000Z" }),
    ).toThrow();
  });

  it("caps delay to max", () => {
    expect(
      resolveManualEnqueueDelayMs({ delay: MANUAL_ENQUEUE_LIMITS.maxDelayMs + 999 }),
    ).toBe(MANUAL_ENQUEUE_LIMITS.maxDelayMs);
  });
});

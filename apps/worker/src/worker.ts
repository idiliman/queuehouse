import { loadConfig, QUEUEHOUSE_VERSION } from "@queuehouse/core";

const _config = loadConfig(process.env, { requireSessionSecret: false });

console.log(
  `[queuehouse-worker] [${_config.namespace}] skeleton ready (core ${QUEUEHOUSE_VERSION}). BullMQ wiring comes in later slices.`,
);

if (import.meta.main) {
  console.log("Worker process idle (skeleton). Connect BullMQ in later slices.");
  void (async () => {
    await Bun.sleep(Number.POSITIVE_INFINITY);
  })();
}

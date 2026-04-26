import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";

const workerDir = path.join(import.meta.dir, "..");

describe("worker healthcheck", () => {
  it("exits 1 when REDIS_URL is missing", () => {
    const env = { ...process.env } as Record<string, string | undefined>;
    delete env.REDIS_URL;
    const r = spawnSync("bun", ["run", "src/healthcheck.ts"], {
      cwd: workerDir,
      env: env as NodeJS.ProcessEnv,
      encoding: "utf8",
    });
    expect(r.status).toBe(1);
  });
});

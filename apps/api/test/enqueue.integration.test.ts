import "./test-setup";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Hono } from "hono";
import { Worker } from "bullmq";
import IORedis from "ioredis";
import {
  bullmqPrefix,
  exampleSuccessJob,
  loadConfig,
  runJobFromQueueData,
} from "@queuehouse/core";
import { prisma } from "@queuehouse/db";
import type { ApiVariables } from "../src/api-types";

const repoRoot = path.join(fileURLToPath(new URL("../../..", import.meta.url)));
const dbPackageDir = path.join(repoRoot, "packages", "db");

function cookiePairFromSetCookie(setCookie: string): string {
  return setCookie.split(";")[0]!.trim();
}

function tryMigrateForIntegrationTests(): boolean {
  if (process.env.QUEUEHOUSE_REQUIRE_DB_TESTS === "1") {
    execSync("bunx prisma migrate deploy", {
      cwd: dbPackageDir,
      env: process.env,
      stdio: "inherit",
    });
    return true;
  }
  try {
    execSync("bunx prisma migrate deploy", {
      cwd: dbPackageDir,
      env: process.env,
      stdio: "pipe",
    });
    return true;
  } catch {
    console.warn(
      "Skipping enqueue integration tests: Postgres unreachable or migrate failed.",
    );
    return false;
  }
}

async function tryRedisPing(): Promise<boolean> {
  const url = process.env.REDIS_URL;
  if (!url) {
    console.warn("Skipping enqueue integration tests: REDIS_URL unset.");
    return false;
  }
  const r = new IORedis(url, { maxRetriesPerRequest: null });
  try {
    const pong = await r.ping();
    if (pong !== "PONG") return false;
    return true;
  } catch (e) {
    if (process.env.QUEUEHOUSE_REQUIRE_DB_TESTS === "1") {
      throw new Error(
        `Redis required for integration tests but unreachable: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    console.warn(
      "Skipping enqueue integration tests: Redis unreachable. Start redis (e.g. `docker compose up -d redis`).",
    );
    return false;
  } finally {
    await r.quit();
  }
}

const dbReady = tryMigrateForIntegrationTests();
const redisReady = await tryRedisPing();
const integrationDescribe = dbReady && redisReady ? describe : describe.skip;

integrationDescribe("Enqueue through worker (integration)", () => {
  let app: Hono<{ Variables: ApiVariables }>;
  let redis: IORedis | undefined;
  let worker: Worker | undefined;

  beforeAll(async () => {
    const apiConfig = (await import("../src/config")).config;
    app = (await import("../src/server")).default;
    redis = new IORedis(apiConfig.redisUrl!, { maxRetriesPerRequest: null });
    redis.on("error", (err) => {
      console.error("[enqueue-test-redis]", err instanceof Error ? err.message : err);
    });
    const prefix = bullmqPrefix(apiConfig.namespace);
    const workerCfg = loadConfig(process.env, {
      requireSessionSecret: false,
      requireDatabaseUrl: false,
    });
    expect(workerCfg.redisUrl).toBe(apiConfig.redisUrl);
    worker = new Worker(
      exampleSuccessJob.queue,
      async (job) => runJobFromQueueData(job.data),
      { connection: redis, prefix, concurrency: 2 },
    );
    await worker.waitUntilReady();
  });

  afterAll(async () => {
    await worker?.close();
    await redis?.quit();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.session.deleteMany();
    await prisma.user.deleteMany();
  });

  it("runs example.success from authenticated enqueue to job detail", async () => {
    await prisma.user.create({
      data: {
        email: "worker@example.com",
        passwordHash: await Bun.password.hash("pw", { algorithm: "bcrypt", cost: 4 }),
        role: "VIEWER",
      },
    });

    const login = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "worker@example.com", password: "pw" }),
    });
    expect(login.status).toBe(200);
    const cookieHeader = cookiePairFromSetCookie(login.headers.get("set-cookie")!);

    const reqId = "req_enqueue_integration_1";
    const enqueue = await app.request("/api/v1/jobs/example.success/enqueue", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookieHeader,
        "X-Request-Id": reqId,
      },
      body: JSON.stringify({ message: "integration" }),
    });
    expect(enqueue.status).toBe(200);
    const accepted = (await enqueue.json()) as {
      jobId: string;
      queueName: string;
      requestId: string;
    };
    expect(accepted.requestId).toBe(reqId);
    expect(accepted.queueName).toBe(exampleSuccessJob.queue);
    expect(accepted.jobId.length).toBeGreaterThan(0);

    let lastState = "";
    let detail: Record<string, unknown> | null = null;
    for (let i = 0; i < 80; i++) {
      const res = await app.request(
        `/api/v1/jobs/${encodeURIComponent(accepted.queueName)}/${encodeURIComponent(accepted.jobId)}`,
        { headers: { Cookie: cookieHeader } },
      );
      expect(res.status).toBe(200);
      detail = (await res.json()) as Record<string, unknown>;
      lastState = String(detail.state);
      if (lastState === "completed") break;
      if (lastState === "failed") {
        throw new Error(`job failed: ${JSON.stringify(detail)}`);
      }
      await Bun.sleep(50);
    }
    expect(lastState).toBe("completed");
    expect(detail?.result).toEqual({ echoed: "integration" });
    expect(detail?.jobName).toBe(exampleSuccessJob.name);
    expect(detail?.requestId).toBe(reqId);
    const pl = detail?.payload as { message?: string };
    expect(pl?.message).toBe("[REDACTED]");

    const list = await app.request(
      `/api/v1/jobs?queue=${encodeURIComponent(accepted.queueName)}&jobId=${encodeURIComponent(accepted.jobId)}&limit=20`,
      { headers: { Cookie: cookieHeader } },
    );
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { jobs: { jobId: string; queueName: string }[] };
    expect(listBody.jobs.some((j) => j.jobId === accepted.jobId && j.queueName === accepted.queueName)).toBe(
      true,
    );
  });

  it("returns 401 for enqueue without session", async () => {
    const res = await app.request("/api/v1/jobs/example.success/enqueue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "x" }),
    });
    expect(res.status).toBe(401);
  });
});

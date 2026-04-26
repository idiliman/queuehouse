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
  exampleDlqJob,
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
      if (lastState === "completed" && detail.result != null) break;
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

  async function waitForJobState(
    cookie: string,
    queueName: string,
    jobId: string,
    want: string,
  ): Promise<Record<string, unknown>> {
    for (let i = 0; i < 120; i++) {
      const res = await app.request(
        `/api/v1/jobs/${encodeURIComponent(queueName)}/${encodeURIComponent(jobId)}`,
        { headers: { Cookie: cookie } },
      );
      expect(res.status).toBe(200);
      const detail = (await res.json()) as Record<string, unknown> & { state: string };
      if (detail.state === want) return detail;
      if (detail.state === "failed" && want !== "failed") {
        throw new Error(`unexpected failed: ${JSON.stringify(detail)}`);
      }
      await Bun.sleep(50);
    }
    throw new Error(`timeout waiting for state ${want}`);
  }

  it("DLQ: unrecoverable fails once, admin retries and removes", async () => {
    await prisma.user.create({
      data: {
        email: "admin-dlq@example.com",
        passwordHash: await Bun.password.hash("pw", { algorithm: "bcrypt", cost: 4 }),
        role: "ADMIN",
      },
    });
    const login = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin-dlq@example.com", password: "pw" }),
    });
    expect(login.status).toBe(200);
    const adminCookie = cookiePairFromSetCookie(login.headers.get("set-cookie")!);

    const enq1 = await app.request("/api/v1/jobs/example.dlq/enqueue", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: adminCookie,
        "X-Request-Id": "req_dlq_unrecoverable",
      },
      body: JSON.stringify({ unrecoverable: true }),
    });
    expect(enq1.status).toBe(200);
    const acc1 = (await enq1.json()) as { jobId: string; queueName: string };
    expect(acc1.queueName).toBe(exampleDlqJob.queue);
    let d1 = (await waitForJobState(
      adminCookie,
      acc1.queueName,
      acc1.jobId,
      "failed",
    )) as {
      failedReason?: string;
      metadata: { attemptsMade: number; maxAttempts?: number };
      resolvedRetry?: { maxAttempts: number };
    };
    for (let s = 0; s < 30 && d1.metadata.attemptsMade < 1; s++) {
      await Bun.sleep(40);
      const r = await app.request(
        `/api/v1/jobs/${encodeURIComponent(acc1.queueName)}/${encodeURIComponent(acc1.jobId)}`,
        { headers: { Cookie: adminCookie } },
      );
      expect(r.status).toBe(200);
      d1 = (await r.json()) as typeof d1;
    }
    expect(d1.failedReason).toBeTruthy();
    expect(d1.metadata.attemptsMade).toBe(1);
    expect(d1.metadata.maxAttempts).toBe(1);
    expect(d1.resolvedRetry?.maxAttempts).toBe(1);

    const enq2 = await app.request("/api/v1/jobs/example.dlq/enqueue", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: adminCookie,
        "X-Request-Id": "req_dlq_retryable",
      },
      body: JSON.stringify({ errorMessage: "first run" }),
    });
    expect(enq2.status).toBe(200);
    const acc2 = (await enq2.json()) as { jobId: string; queueName: string };
    let d2 = (await waitForJobState(
      adminCookie,
      acc2.queueName,
      acc2.jobId,
      "failed",
    )) as { failedReason?: string; metadata: { attemptsMade: number } };
    for (let s = 0; s < 30 && d2.metadata.attemptsMade < 1; s++) {
      await Bun.sleep(40);
      const r = await app.request(
        `/api/v1/jobs/${encodeURIComponent(acc2.queueName)}/${encodeURIComponent(acc2.jobId)}`,
        { headers: { Cookie: adminCookie } },
      );
      expect(r.status).toBe(200);
      d2 = (await r.json()) as typeof d2;
    }
    expect(d2.metadata.attemptsMade).toBe(1);
    expect(String(d2.failedReason ?? "")).toContain("first run");

    const retry = await app.request(
      `/api/v1/jobs/${encodeURIComponent(acc2.queueName)}/${encodeURIComponent(acc2.jobId)}/retry`,
      { method: "POST", headers: { Cookie: adminCookie } },
    );
    expect(retry.status).toBe(200);
    (await waitForJobState(
      adminCookie,
      acc2.queueName,
      acc2.jobId,
      "failed",
    )) as { metadata: { attemptsMade: number } };

    const del = await app.request(
      `/api/v1/jobs/${encodeURIComponent(acc2.queueName)}/${encodeURIComponent(acc2.jobId)}`,
      { method: "DELETE", headers: { Cookie: adminCookie } },
    );
    expect(del.status).toBe(204);
    const gone = await app.request(
      `/api/v1/jobs/${encodeURIComponent(acc2.queueName)}/${encodeURIComponent(acc2.jobId)}`,
      { headers: { Cookie: adminCookie } },
    );
    expect(gone.status).toBe(404);

    // Unrecoverable job still in failed: remove to clean up
    const del1 = await app.request(
      `/api/v1/jobs/${encodeURIComponent(acc1.queueName)}/${encodeURIComponent(acc1.jobId)}`,
      { method: "DELETE", headers: { Cookie: adminCookie } },
    );
    expect(del1.status).toBe(204);
  });

  it("DLQ: viewer cannot retry in place (403)", async () => {
    await prisma.user.create({
      data: {
        email: "viewer-dlq@example.com",
        passwordHash: await Bun.password.hash("pw", { algorithm: "bcrypt", cost: 4 }),
        role: "VIEWER",
      },
    });
    await prisma.user.create({
      data: {
        email: "admin2-dlq@example.com",
        passwordHash: await Bun.password.hash("pw", { algorithm: "bcrypt", cost: 4 }),
        role: "ADMIN",
      },
    });

    const adminLogin = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin2-dlq@example.com", password: "pw" }),
    });
    const adminCookie = cookiePairFromSetCookie(adminLogin.headers.get("set-cookie")!);

    const enq = await app.request("/api/v1/jobs/example.dlq/enqueue", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: adminCookie, "X-Request-Id": "req_viewer" },
      body: JSON.stringify({}),
    });
    expect(enq.status).toBe(200);
    const { jobId, queueName } = (await enq.json()) as { jobId: string; queueName: string };
    await waitForJobState(adminCookie, queueName, jobId, "failed");

    const vLogin = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "viewer-dlq@example.com", password: "pw" }),
    });
    const vCookie = cookiePairFromSetCookie(vLogin.headers.get("set-cookie")!);

    const ret = await app.request(
      `/api/v1/jobs/${encodeURIComponent(queueName)}/${encodeURIComponent(jobId)}/retry`,
      { method: "POST", headers: { Cookie: vCookie } },
    );
    expect(ret.status).toBe(403);

    const del = await app.request(
      `/api/v1/jobs/${encodeURIComponent(queueName)}/${encodeURIComponent(jobId)}`,
      { method: "DELETE", headers: { Cookie: vCookie } },
    );
    expect(del.status).toBe(403);

    // Admin cleanup
    const delAd = await app.request(
      `/api/v1/jobs/${encodeURIComponent(queueName)}/${encodeURIComponent(jobId)}`,
      { method: "DELETE", headers: { Cookie: adminCookie } },
    );
    expect(delAd.status).toBe(204);
  });
});

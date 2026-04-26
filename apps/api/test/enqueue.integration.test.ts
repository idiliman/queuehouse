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
  AUDIT_ACTION,
  bullmqPrefix,
  exampleDlqJob,
  exampleFailJob,
  exampleProgressJob,
  exampleSuccessJob,
  loadConfig,
  queuehouseBulkDlqJob,
  queuehouseRetentionCleanupJob,
} from "@queuehouse/core";
import { createBullJobProcessor } from "../../worker/src/process-job";
import { prisma } from "@queuehouse/db";
import type { ApiVariables } from "../src/api-types";
import { AUDIT_ACTION as API_AUDIT_ACTION } from "../src/audit/audit-log";

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
  let workerSystem: Worker | undefined;

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
    const processor = createBullJobProcessor(redis, workerCfg);
    worker = new Worker(exampleSuccessJob.queue, processor, { connection: redis, prefix, concurrency: 2 });
    await worker.waitUntilReady();
    workerSystem = new Worker(
      queuehouseBulkDlqJob.queue,
      createBullJobProcessor(redis, workerCfg),
      { connection: redis, prefix, concurrency: 2 },
    );
    await workerSystem.waitUntilReady();
  });

  afterAll(async () => {
    await workerSystem?.close();
    await worker?.close();
    await redis?.quit();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.session.deleteMany();
    await prisma.auditLog.deleteMany();
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

    const auditRow = await prisma.auditLog.findFirst({
      where: { requestId: reqId, action: "job.enqueue" },
    });
    expect(auditRow).not.toBeNull();
    expect(auditRow?.result).toBe("SUCCESS");
    expect(auditRow?.errorCode).toBeNull();
    const sum = auditRow?.summary as Record<string, unknown>;
    expect(sum?.jobName).toBe("example.success");
    expect(sum?.newJobId).toBe(accepted.jobId);
    expect(sum?.queueName).toBe(accepted.queueName);

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

  it("enqueues example.success with Bearer API key (enqueue + read, allow list)", async () => {
    await prisma.user.create({
      data: {
        email: "key-enqueue@example.com",
        passwordHash: await Bun.password.hash("pw", { algorithm: "bcrypt", cost: 4 }),
        role: "ADMIN",
      },
    });
    const login = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "key-enqueue@example.com", password: "pw" }),
    });
    const cookie = cookiePairFromSetCookie(login.headers.get("set-cookie")!);
    const create = await app.request("/api/v1/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        scopes: ["enqueue", "read"],
        allowedJobTypes: [exampleSuccessJob.name],
      }),
    });
    expect(create.status).toBe(201);
    const { token } = (await create.json()) as { token: string };
    const reqId = "req_bearer_enqueue_1";
    const enqueue = await app.request("/api/v1/jobs/example.success/enqueue", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "X-Request-Id": reqId,
      },
      body: JSON.stringify({ message: "via-bearer" }),
    });
    expect(enqueue.status).toBe(200);
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

  it("DLQ: admin retry-as-new enqueues linked job and validates payload", async () => {
    await prisma.user.create({
      data: {
        email: "admin-ran@example.com",
        passwordHash: await Bun.password.hash("pw", { algorithm: "bcrypt", cost: 4 }),
        role: "ADMIN",
      },
    });
    const login = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin-ran@example.com", password: "pw" }),
    });
    expect(login.status).toBe(200);
    const adminCookie = cookiePairFromSetCookie(login.headers.get("set-cookie")!);

    const enq = await app.request("/api/v1/jobs/example.dlq/enqueue", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: adminCookie, "X-Request-Id": "req_ran" },
      body: JSON.stringify({ errorMessage: "source failed" }),
    });
    expect(enq.status).toBe(200);
    const acc = (await enq.json()) as { jobId: string; queueName: string };
    await waitForJobState(adminCookie, acc.queueName, acc.jobId, "failed");

    const bad = await app.request(
      `/api/v1/jobs/${encodeURIComponent(acc.queueName)}/${encodeURIComponent(acc.jobId)}/retry-as-new`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: adminCookie },
        body: JSON.stringify({ payload: { unrecoverable: "not-a-boolean" } }),
      },
    );
    expect(bad.status).toBe(400);
    const badBody = (await bad.json()) as { error?: string };
    expect(badBody.error).toBe("validation_failed");

    const ran = await app.request(
      `/api/v1/jobs/${encodeURIComponent(acc.queueName)}/${encodeURIComponent(acc.jobId)}/retry-as-new`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: adminCookie, "X-Request-Id": "req_ran2" },
        body: JSON.stringify({ payload: { errorMessage: "from retry as new" } }),
      },
    );
    expect(ran.status).toBe(200);
    const accepted = (await ran.json()) as { jobId: string; queueName: string; requestId: string };
    expect(accepted.requestId).toBe("req_ran2");
    expect(accepted.jobId).not.toBe(acc.jobId);
    expect(accepted.queueName).toBe(acc.queueName);

    const resNew = await app.request(
      `/api/v1/jobs/${encodeURIComponent(accepted.queueName)}/${encodeURIComponent(accepted.jobId)}`,
      { headers: { Cookie: adminCookie } },
    );
    expect(resNew.status).toBe(200);
    const dNew = (await resNew.json()) as {
      metadata: { retriedAsNewFrom?: { queueName: string; jobId: string } };
    };
    expect(dNew.metadata.retriedAsNewFrom).toEqual({
      queueName: acc.queueName,
      jobId: acc.jobId,
    });

    const delOld = await app.request(
      `/api/v1/jobs/${encodeURIComponent(acc.queueName)}/${encodeURIComponent(acc.jobId)}`,
      { method: "DELETE", headers: { Cookie: adminCookie } },
    );
    expect(delOld.status).toBe(204);
    const delNew = await app.request(
      `/api/v1/jobs/${encodeURIComponent(accepted.queueName)}/${encodeURIComponent(accepted.jobId)}`,
      { method: "DELETE", headers: { Cookie: adminCookie } },
    );
    expect(delNew.status).toBe(204);
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

    const rNew = await app.request(
      `/api/v1/jobs/${encodeURIComponent(queueName)}/${encodeURIComponent(jobId)}/retry-as-new`,
      { method: "POST", headers: { "Content-Type": "application/json", Cookie: vCookie },
      body: JSON.stringify({}) },
    );
    expect(rNew.status).toBe(403);

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

  it("bulk DLQ: system job removes selected failed jobs", async () => {
    await prisma.user.create({
      data: {
        email: "admin-bulk-dlq@example.com",
        passwordHash: await Bun.password.hash("pw", { algorithm: "bcrypt", cost: 4 }),
        role: "ADMIN",
      },
    });
    const login = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin-bulk-dlq@example.com", password: "pw" }),
    });
    expect(login.status).toBe(200);
    const adminCookie = cookiePairFromSetCookie(login.headers.get("set-cookie")!);

    const targets: { jobId: string; queueName: string }[] = [];
    for (let i = 0; i < 2; i++) {
      const enq = await app.request("/api/v1/jobs/example.dlq/enqueue", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: adminCookie,
          "X-Request-Id": `req_bulk_dlq_${i}`,
        },
        body: JSON.stringify({ errorMessage: "bulk remove test" }),
      });
      expect(enq.status).toBe(200);
      targets.push((await enq.json()) as { jobId: string; queueName: string });
    }
    for (const t of targets) {
      await waitForJobState(adminCookie, t.queueName, t.jobId, "failed");
    }

    const bulk = await app.request("/api/v1/admin/bulk-dlq", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: adminCookie,
        "X-Request-Id": "req_bulk_op",
      },
      body: JSON.stringify({
        action: "remove",
        targets: targets.map((j) => ({ queueName: j.queueName, jobId: j.jobId })),
      }),
    });
    expect(bulk.status).toBe(200);
    const bulkJson = (await bulk.json()) as { jobId: string; queueName: string; bulk: boolean };
    expect(bulkJson.bulk).toBe(true);
    expect(bulkJson.queueName).toBe(queuehouseBulkDlqJob.queue);
    await waitForJobState(adminCookie, bulkJson.queueName, bulkJson.jobId, "completed");

    for (const t of targets) {
      const g = await app.request(
        `/api/v1/jobs/${encodeURIComponent(t.queueName)}/${encodeURIComponent(t.jobId)}`,
        { headers: { Cookie: adminCookie } },
      );
      expect(g.status).toBe(404);
    }

    const completeAudit = await prisma.auditLog.findFirst({
      where: { requestId: "req_bulk_op", action: AUDIT_ACTION.BULK_DLQ_COMPLETE },
      orderBy: { createdAt: "desc" },
    });
    expect(completeAudit).not.toBeNull();
    expect(completeAudit!.summary as Record<string, unknown>).toMatchObject({
      action: "remove",
      requested: 2,
      executed: 2,
      skipped: 0,
      failed: 0,
    });
  });

  it("retention: admin can enqueue queuehouse.retention_cleanup and worker completes with audit", async () => {
    await prisma.user.create({
      data: {
        email: "admin-retention@example.com",
        passwordHash: await Bun.password.hash("pw", { algorithm: "bcrypt", cost: 4 }),
        role: "ADMIN",
      },
    });
    const login = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin-retention@example.com", password: "pw" }),
    });
    expect(login.status).toBe(200);
    const adminCookie = cookiePairFromSetCookie(login.headers.get("set-cookie")!);

    const r = await app.request("/api/v1/admin/retention-cleanup", {
      method: "POST",
      headers: { Cookie: adminCookie, "X-Request-Id": "req_retention" },
    });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { jobId: string; queueName: string; retention: boolean };
    expect(j.retention).toBe(true);
    expect(j.queueName).toBe(queuehouseRetentionCleanupJob.queue);

    const enqAudit = await prisma.auditLog.findFirst({
      where: { requestId: "req_retention", action: API_AUDIT_ACTION.RETENTION_CLEANUP },
    });
    expect(enqAudit).not.toBeNull();

    await waitForJobState(adminCookie, j.queueName, j.jobId, "completed");

    const doneAudit = await prisma.auditLog.findFirst({
      where: { requestId: "req_retention", action: AUDIT_ACTION.RETENTION_CLEANUP_COMPLETE },
    });
    expect(doneAudit).not.toBeNull();
    const sum = doneAudit?.summary as Record<string, unknown>;
    expect(typeof sum?.removedCompleted).toBe("number");
    expect(typeof sum?.removedFailed).toBe("number");
  });

  it("bulk DLQ: GET /admin/bulk-dlq-targets previews failed jobs for current filters (admin only)", async () => {
    await prisma.user.create({
      data: {
        email: "admin-bulk-tg@example.com",
        passwordHash: await Bun.password.hash("pw", { algorithm: "bcrypt", cost: 4 }),
        role: "ADMIN",
      },
    });
    await prisma.user.create({
      data: {
        email: "viewer-bulk-tg@example.com",
        passwordHash: await Bun.password.hash("pw", { algorithm: "bcrypt", cost: 4 }),
        role: "VIEWER",
      },
    });
    const adminLogin = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin-bulk-tg@example.com", password: "pw" }),
    });
    expect(adminLogin.status).toBe(200);
    const adminCookie = cookiePairFromSetCookie(adminLogin.headers.get("set-cookie")!);
    const vLogin = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "viewer-bulk-tg@example.com", password: "pw" }),
    });
    expect(vLogin.status).toBe(200);
    const viewerCookie = cookiePairFromSetCookie(vLogin.headers.get("set-cookie")!);

    const fromMs = Date.now();
    const failedTargets: { jobId: string; queueName: string }[] = [];
    for (let i = 0; i < 2; i++) {
      const enq = await app.request("/api/v1/jobs/example.dlq/enqueue", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: adminCookie,
        },
        body: JSON.stringify({ errorMessage: `preview tg ${i}` }),
      });
      expect(enq.status).toBe(200);
      failedTargets.push((await enq.json()) as { jobId: string; queueName: string });
    }
    for (const t of failedTargets) {
      await waitForJobState(adminCookie, t.queueName, t.jobId, "failed");
    }

    const denied = await app.request("/api/v1/admin/bulk-dlq-targets", {
      headers: { Cookie: viewerCookie },
    });
    expect(denied.status).toBe(403);

    const preview = await app.request(
      `/api/v1/admin/bulk-dlq-targets?queue=${encodeURIComponent(
        failedTargets[0]!.queueName,
      )}&jobName=example.dlq&from=${fromMs}`,
      { headers: { Cookie: adminCookie } },
    );
    expect(preview.status).toBe(200);
    const pJson = (await preview.json()) as {
      cap: number;
      hasMore: boolean;
      matchingCount: number;
      targetCount: number;
      targets: { queueName: string; jobId: string }[];
    };
    expect(pJson.matchingCount).toBe(2);
    expect(pJson.targetCount).toBe(2);
    expect(pJson.hasMore).toBe(false);
    expect(pJson.targets).toEqual(
      expect.arrayContaining(
        failedTargets.map((f) => ({ queueName: f.queueName, jobId: f.jobId })),
      ),
    );

    const none = await app.request(
      `/api/v1/admin/bulk-dlq-targets?jobName=example.success&from=${fromMs}`,
      { headers: { Cookie: adminCookie } },
    );
    expect(none.status).toBe(200);
    const nJson = (await none.json()) as { matchingCount: number; targetCount: number; targets: unknown[] };
    expect(nJson.matchingCount).toBe(0);
    expect(nJson.targetCount).toBe(0);
    expect(nJson.targets).toEqual([]);

    for (const t of failedTargets) {
      await app.request(
        `/api/v1/jobs/${encodeURIComponent(t.queueName)}/${encodeURIComponent(t.jobId)}`,
        { method: "DELETE", headers: { Cookie: adminCookie } },
      );
    }
  });

  it("DLQ: enqueue retry override exhausts configured attempts on example.fail", async () => {
    await prisma.user.create({
      data: {
        email: "admin-exhaust@example.com",
        passwordHash: await Bun.password.hash("pw", { algorithm: "bcrypt", cost: 4 }),
        role: "ADMIN",
      },
    });
    const login = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin-exhaust@example.com", password: "pw" }),
    });
    expect(login.status).toBe(200);
    const cookie = cookiePairFromSetCookie(login.headers.get("set-cookie")!);

    const enq = await app.request("/api/v1/jobs/example.fail/enqueue", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        "X-Request-Id": "req_exhaust",
      },
      body: JSON.stringify({
        errorMessage: "exhaust test",
        retry: { maxAttempts: 3, backoffMs: 0 },
      }),
    });
    expect(enq.status).toBe(200);
    const acc = (await enq.json()) as { jobId: string; queueName: string };
    expect(acc.queueName).toBe(exampleFailJob.queue);

    const detail = (await waitForJobState(
      cookie,
      acc.queueName,
      acc.jobId,
      "failed",
    )) as {
      failedReason?: string;
      metadata: { attemptsMade: number; maxAttempts?: number };
    };
    expect(detail.metadata.maxAttempts).toBe(3);
    expect(detail.metadata.attemptsMade).toBe(3);
    expect(String(detail.failedReason ?? "")).toContain("exhaust test");

    const del = await app.request(
      `/api/v1/jobs/${encodeURIComponent(acc.queueName)}/${encodeURIComponent(acc.jobId)}`,
      { method: "DELETE", headers: { Cookie: cookie } },
    );
    expect(del.status).toBe(204);
  });

  it("enqueue: rejects retry override when job does not allow overrides", async () => {
    await prisma.user.create({
      data: {
        email: "u-dep@example.com",
        passwordHash: await Bun.password.hash("pw", { algorithm: "bcrypt", cost: 4 }),
        role: "VIEWER",
      },
    });
    const login = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "u-dep@example.com", password: "pw" }),
    });
    expect(login.status).toBe(200);
    const cookie = cookiePairFromSetCookie(login.headers.get("set-cookie")!);
    const res = await app.request("/api/v1/jobs/example.deprecated/enqueue", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ legacy: true, retry: { maxAttempts: 1 } }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("retry_override_not_allowed");
  });

  it("audit: records failed validation without raw payload in summary", async () => {
    await prisma.user.create({
      data: {
        email: "audit-fail@example.com",
        passwordHash: await Bun.password.hash("pw", { algorithm: "bcrypt", cost: 4 }),
        role: "VIEWER",
      },
    });
    const login = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "audit-fail@example.com", password: "pw" }),
    });
    expect(login.status).toBe(200);
    const cookie = cookiePairFromSetCookie(login.headers.get("set-cookie")!);
    const failReq = "req_audit_validation_fail";
    const res = await app.request("/api/v1/jobs/example.success/enqueue", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        "X-Request-Id": failReq,
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const row = await prisma.auditLog.findFirst({
      where: { requestId: failReq, action: "job.enqueue" },
    });
    expect(row).not.toBeNull();
    expect(row?.result).toBe("FAILURE");
    expect(row?.errorCode).toBe("validation_failed");
    expect(JSON.stringify(row?.summary)).not.toContain("message");
  });

  it("audit: admin can list audit logs; viewer cannot", async () => {
    await prisma.user.create({
      data: {
        email: "audit-admin@example.com",
        passwordHash: await Bun.password.hash("pw", { algorithm: "bcrypt", cost: 4 }),
        role: "ADMIN",
      },
    });
    await prisma.user.create({
      data: {
        email: "audit-view@example.com",
        passwordHash: await Bun.password.hash("pw", { algorithm: "bcrypt", cost: 4 }),
        role: "VIEWER",
      },
    });
    const adminLogin = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "audit-admin@example.com", password: "pw" }),
    });
    expect(adminLogin.status).toBe(200);
    const adminCookie = cookiePairFromSetCookie(adminLogin.headers.get("set-cookie")!);
    const enq = await app.request("/api/v1/jobs/example.success/enqueue", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: adminCookie, "X-Request-Id": "req_list_audit" },
      body: JSON.stringify({ message: "aud" }),
    });
    expect(enq.status).toBe(200);
    const list = await app.request("/api/v1/audit-logs?limit=20", {
      headers: { Cookie: adminCookie },
    });
    expect(list.status).toBe(200);
    const body = (await list.json()) as { items: { action: string }[]; total: number };
    expect(body.total).toBeGreaterThan(0);
    expect(body.items.some((i) => i.action === "job.enqueue")).toBe(true);

    const viewLogin = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "audit-view@example.com", password: "pw" }),
    });
    expect(viewLogin.status).toBe(200);
    const viewCookie = cookiePairFromSetCookie(viewLogin.headers.get("set-cookie")!);
    const denied = await app.request("/api/v1/audit-logs", { headers: { Cookie: viewCookie } });
    expect(denied.status).toBe(403);
  });

  it("audit: actions= query filters to multiple action values", async () => {
    const admin = await prisma.user.create({
      data: {
        email: "audit-multi@example.com",
        passwordHash: await Bun.password.hash("pw", { algorithm: "bcrypt", cost: 4 }),
        role: "ADMIN",
      },
    });
    await prisma.auditLog.createMany({
      data: [
        {
          requestId: "req_audit_filter_1",
          userId: admin.id,
          action: "job.enqueue",
          summary: {},
          result: "SUCCESS",
        },
        {
          requestId: "req_audit_filter_2",
          userId: admin.id,
          action: "job.bulk_dlq",
          summary: { action: "retry", requested: 2 },
          result: "SUCCESS",
        },
        {
          requestId: "req_audit_filter_3",
          userId: admin.id,
          action: AUDIT_ACTION.BULK_DLQ_COMPLETE,
          summary: { requested: 2, executed: 2, skipped: 0, failed: 0 },
          result: "SUCCESS",
        },
      ],
    });
    const login = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "audit-multi@example.com", password: "pw" }),
    });
    expect(login.status).toBe(200);
    const cookie = cookiePairFromSetCookie(login.headers.get("set-cookie")!);
    const list = await app.request(
      "/api/v1/audit-logs?limit=20&actions=job.bulk_dlq,job.bulk_dlq_complete",
      { headers: { Cookie: cookie } },
    );
    expect(list.status).toBe(200);
    const body = (await list.json()) as { items: { action: string; requestId: string }[]; total: number };
    expect(body.total).toBe(2);
    expect(body.items.map((i) => i.requestId).sort()).toEqual(["req_audit_filter_2", "req_audit_filter_3"]);
  });

  it("manual enqueue: admin enqueues example.progress (manual.ui only) and it completes", async () => {
    await prisma.user.create({
      data: {
        email: "manual-ui@example.com",
        passwordHash: await Bun.password.hash("pw", { algorithm: "bcrypt", cost: 4 }),
        role: "ADMIN",
      },
    });
    const login = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "manual-ui@example.com", password: "pw" }),
    });
    expect(login.status).toBe(200);
    const cookie = cookiePairFromSetCookie(login.headers.get("set-cookie")!);
    const reqId = "req_manual_progress_1";
    const res = await app.request("/api/v1/manual-enqueue", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        "X-Request-Id": reqId,
      },
      body: JSON.stringify({
        jobName: exampleProgressJob.name,
        payload: { steps: 1 },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { jobId: string; queueName: string };
    expect(body.queueName).toBe(exampleProgressJob.queue);
    const detail = await app.request(
      `/api/v1/jobs/${encodeURIComponent(body.queueName)}/${encodeURIComponent(body.jobId)}`,
      { headers: { Cookie: cookie } },
    );
    expect(detail.status).toBe(200);
    const row = await prisma.auditLog.findFirst({
      where: { requestId: reqId, action: "job.enqueue" },
    });
    expect(row?.result).toBe("SUCCESS");
    const s = row?.summary as Record<string, unknown>;
    expect(s.path).toBe("manual");
    expect(s.jobName).toBe(exampleProgressJob.name);
  });

  it("manual enqueue: viewer receives 403", async () => {
    await prisma.user.create({
      data: {
        email: "manual-view@example.com",
        passwordHash: await Bun.password.hash("pw", { algorithm: "bcrypt", cost: 4 }),
        role: "VIEWER",
      },
    });
    const login = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "manual-view@example.com", password: "pw" }),
    });
    const cookie = cookiePairFromSetCookie(login.headers.get("set-cookie")!);
    const res = await app.request("/api/v1/manual-enqueue", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ jobName: "example.success", payload: { message: "n" } }),
    });
    expect(res.status).toBe(403);
  });

  it("manual enqueue: rejects example.deprecated (no manual.ui)", async () => {
    await prisma.user.create({
      data: {
        email: "manual-dep@example.com",
        passwordHash: await Bun.password.hash("pw", { algorithm: "bcrypt", cost: 4 }),
        role: "ADMIN",
      },
    });
    const login = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "manual-dep@example.com", password: "pw" }),
    });
    const cookie = cookiePairFromSetCookie(login.headers.get("set-cookie")!);
    const res = await app.request("/api/v1/manual-enqueue", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ jobName: "example.deprecated", payload: {} }),
    });
    expect(res.status).toBe(403);
    const b = (await res.json()) as { error: string };
    expect(b.error).toBe("manual_enqueue_not_allowed");
  });

  it("manual enqueue: wait returns job result for example.success", async () => {
    await prisma.user.create({
      data: {
        email: "manual-wait@example.com",
        passwordHash: await Bun.password.hash("pw", { algorithm: "bcrypt", cost: 4 }),
        role: "ADMIN",
      },
    });
    const login = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "manual-wait@example.com", password: "pw" }),
    });
    const cookie = cookiePairFromSetCookie(login.headers.get("set-cookie")!);
    const res = await app.request("/api/v1/manual-enqueue", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        jobName: exampleSuccessJob.name,
        payload: { message: "waited" },
        waitTimeoutMs: 30_000,
      }),
    });
    expect(res.status).toBe(200);
    const b = (await res.json()) as { result?: { echoed: string } };
    expect(b.result).toEqual({ echoed: "waited" });
  });

  it("raw reveal: GET stays redacted; admin POST returns raw and audits; viewer and API key forbidden", async () => {
    await prisma.user.create({
      data: {
        email: "raw-admin@example.com",
        passwordHash: await Bun.password.hash("pw", { algorithm: "bcrypt", cost: 4 }),
        role: "ADMIN",
      },
    });
    await prisma.user.create({
      data: {
        email: "raw-viewer@example.com",
        passwordHash: await Bun.password.hash("pw", { algorithm: "bcrypt", cost: 4 }),
        role: "VIEWER",
      },
    });
    const adminLogin = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "raw-admin@example.com", password: "pw" }),
    });
    const adminCookie = cookiePairFromSetCookie(adminLogin.headers.get("set-cookie")!);
    const vLogin = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "raw-viewer@example.com", password: "pw" }),
    });
    const viewerCookie = cookiePairFromSetCookie(vLogin.headers.get("set-cookie")!);

    const reqId = "req_raw_reveal_1";
    const enq = await app.request("/api/v1/jobs/example.success/enqueue", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: adminCookie,
        "X-Request-Id": reqId,
      },
      body: JSON.stringify({ message: "raw-secret-abc" }),
    });
    expect(enq.status).toBe(200);
    const acc = (await enq.json()) as { jobId: string; queueName: string };
    for (let i = 0; i < 80; i++) {
      const r = await app.request(
        `/api/v1/jobs/${encodeURIComponent(acc.queueName)}/${encodeURIComponent(acc.jobId)}`,
        { headers: { Cookie: adminCookie } },
      );
      expect(r.status).toBe(200);
      const d = (await r.json()) as { state: string; payload: { message?: string } };
      if (d.state === "completed") {
        break;
      }
      await Bun.sleep(50);
    }

    const viewerGet = await app.request(
      `/api/v1/jobs/${encodeURIComponent(acc.queueName)}/${encodeURIComponent(acc.jobId)}`,
      { headers: { Cookie: viewerCookie } },
    );
    expect(viewerGet.status).toBe(200);
    const vDetail = (await viewerGet.json()) as { payload: { message?: string } };
    expect(vDetail.payload.message).toBe("[REDACTED]");

    const vReveal = await app.request(
      `/api/v1/jobs/${encodeURIComponent(acc.queueName)}/${encodeURIComponent(acc.jobId)}/raw-reveal`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: viewerCookie },
        body: JSON.stringify({ reason: "should fail" }),
      },
    );
    expect(vReveal.status).toBe(403);

    const keyCreate = await app.request("/api/v1/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({
        name: "raw-test",
        scopes: ["read", "admin"],
        allowedJobTypes: ["example.success"],
      }),
    });
    expect(keyCreate.status).toBe(201);
    const { token: apiToken } = (await keyCreate.json()) as { token: string };
    const keyReveal = await app.request(
      `/api/v1/jobs/${encodeURIComponent(acc.queueName)}/${encodeURIComponent(acc.jobId)}/raw-reveal`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiToken}`,
        },
        body: JSON.stringify({ reason: "api key" }),
      },
    );
    expect(keyReveal.status).toBe(403);

    const badBody = await app.request(
      `/api/v1/jobs/${encodeURIComponent(acc.queueName)}/${encodeURIComponent(acc.jobId)}/raw-reveal`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: adminCookie },
        body: JSON.stringify({ reason: "" }),
      },
    );
    expect(badBody.status).toBe(400);

    const revealReq = "req_raw_reveal_audit";
    const ok = await app.request(
      `/api/v1/jobs/${encodeURIComponent(acc.queueName)}/${encodeURIComponent(acc.jobId)}/raw-reveal`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: adminCookie,
          "X-Request-Id": revealReq,
        },
        body: JSON.stringify({ reason: "incident-42 investigation" }),
      },
    );
    expect(ok.status).toBe(200);
    const raw = (await ok.json()) as { payload: { message?: string }; result: { echoed?: string } };
    expect(raw.payload.message).toBe("raw-secret-abc");
    expect(raw.result).toEqual({ echoed: "raw-secret-abc" });

    const audit = await prisma.auditLog.findFirst({
      where: { requestId: revealReq, action: "job.raw_reveal" },
    });
    expect(audit).not.toBeNull();
    expect(audit?.result).toBe("SUCCESS");
    const asum = audit?.summary as Record<string, unknown>;
    expect(asum.reason).toBe("incident-42 investigation");
    expect(asum.jobName).toBe("example.success");
  });
});

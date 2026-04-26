import "./test-setup";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Hono } from "hono";
import IORedis from "ioredis";
import {
  bullmqPrefix,
  exampleSuccessJob,
  workerHeartbeatKeyPattern,
  workerHeartbeatRedisKey,
  WORKER_HEARTBEAT_TTL_SEC,
  type WorkerHeartbeatPayload,
} from "@queuehouse/core";
import { prisma } from "@queuehouse/db";
import { getOrCreateQueue } from "../src/bullmq/queuehouse-queue";
import type { ApiVariables } from "../src/api-types";

const repoRoot = path.join(fileURLToPath(new URL("../../..", import.meta.url)));
const dbPackageDir = path.join(repoRoot, "packages", "db");

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
    console.warn("Skipping queues integration tests: migrate failed.");
    return false;
  }
}

async function tryRedisPing(): Promise<boolean> {
  const url = process.env.REDIS_URL;
  if (!url) return false;
  const r = new IORedis(url, { maxRetriesPerRequest: null });
  try {
    return (await r.ping()) === "PONG";
  } catch {
    return false;
  } finally {
    await r.quit();
  }
}

const dbReady = tryMigrateForIntegrationTests();
const redisReady = await tryRedisPing();
const integrationDescribe = dbReady && redisReady ? describe : describe.skip;

integrationDescribe("Queues and worker heartbeats (integration)", () => {
  let app: Hono<{ Variables: ApiVariables }>;
  let redis: IORedis;

  beforeAll(async () => {
    app = (await import("../src/server")).default;
    const apiConfig = (await import("../src/config")).config;
    redis = new IORedis(apiConfig.redisUrl!, { maxRetriesPerRequest: null });
  });

  afterAll(async () => {
    await redis.quit();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    const apiConfig = (await import("../src/config")).config;
    const pattern = workerHeartbeatKeyPattern(apiConfig.namespace);
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 128);
      cursor = next;
      if (keys.length) await redis.del(...keys);
    } while (cursor !== "0");

    const q = getOrCreateQueue(redis, apiConfig, exampleSuccessJob.queue);
    if (await q.isPaused()) {
      await q.resume();
    }
  });

  it("GET /queues returns stats for registered queues and 401 when unauthenticated", async () => {
    const r0 = await app.request("/api/v1/queues");
    expect(r0.status).toBe(401);

    await prisma.user.deleteMany();
    const password = await Bun.password.hash("q-int-queues!", { algorithm: "bcrypt" });
    await prisma.user.create({
      data: {
        email: "qviewer@example.com",
        passwordHash: password,
        role: "VIEWER",
      },
    });
    const login = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "qviewer@example.com", password: "q-int-queues!" }),
    });
    expect(login.status).toBe(200);
    const cookieHeader = login.headers.getSetCookie().map((c) => c.split(";")[0]!.trim()).join("; ");

    const r1 = await app.request("/api/v1/queues", {
      headers: { Cookie: cookieHeader },
    });
    expect(r1.status).toBe(200);
    const body = (await r1.json()) as {
      queues: { name: string; paused: boolean; counts: Record<string, number> }[];
      workers: unknown[];
    };
    const names = body.queues.map((q) => q.name);
    expect(names).toContain(exampleSuccessJob.queue);
    expect(body.workers).toEqual([]);
  });

  it("admin can pause and resume; viewer receives 403 on pause", async () => {
    await prisma.user.deleteMany();
    const pw = await Bun.password.hash("admin-pause!", { algorithm: "bcrypt" });
    await prisma.user.create({
      data: {
        email: "qadmin@example.com",
        passwordHash: pw,
        role: "ADMIN",
      },
    });
    const pwV = await Bun.password.hash("viewer-pause!", { algorithm: "bcrypt" });
    await prisma.user.create({
      data: {
        email: "qviewer2@example.com",
        passwordHash: pwV,
        role: "VIEWER",
      },
    });

    const adminLogin = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "qadmin@example.com", password: "admin-pause!" }),
    });
    const adminCookie = adminLogin.headers
      .getSetCookie()
      .map((c) => c.split(";")[0]!.trim())
      .join("; ");
    const viewerLogin = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "qviewer2@example.com", password: "viewer-pause!" }),
    });
    const viewerCookie = viewerLogin.headers
      .getSetCookie()
      .map((c) => c.split(";")[0]!.trim())
      .join("; ");

    const qn = exampleSuccessJob.queue;
    const pauseViewer = await app.request(`/api/v1/queues/${encodeURIComponent(qn)}/pause`, {
      method: "POST",
      headers: { Cookie: viewerCookie },
    });
    expect(pauseViewer.status).toBe(403);

    const pauseOk = await app.request(`/api/v1/queues/${encodeURIComponent(qn)}/pause`, {
      method: "POST",
      headers: { Cookie: adminCookie },
    });
    expect(pauseOk.status).toBe(200);

    const apiConfig = (await import("../src/config")).config;
    const queue = getOrCreateQueue(redis, apiConfig, qn);
    expect(await queue.isPaused()).toBe(true);

    const listPaused = await app.request("/api/v1/queues", {
      headers: { Cookie: adminCookie },
    });
    const listBody = (await listPaused.json()) as { queues: { name: string; paused: boolean }[] };
    const row = listBody.queues.find((x) => x.name === qn);
    expect(row?.paused).toBe(true);

    const resumeOk = await app.request(`/api/v1/queues/${encodeURIComponent(qn)}/resume`, {
      method: "POST",
      headers: { Cookie: adminCookie },
    });
    expect(resumeOk.status).toBe(200);
    expect(await queue.isPaused()).toBe(false);
  });

  it("GET /queues lists worker heartbeats present in Redis", async () => {
    await prisma.user.deleteMany();
    const password = await Bun.password.hash("hb-read!", { algorithm: "bcrypt" });
    await prisma.user.create({
      data: {
        email: "hbread@example.com",
        passwordHash: password,
        role: "VIEWER",
      },
    });
    const login = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "hbread@example.com", password: "hb-read!" }),
    });
    const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]!.trim()).join("; ");

    const apiConfig = (await import("../src/config")).config;
    const id = "test-instance-uuid";
    const key = workerHeartbeatRedisKey(apiConfig.namespace, id);
    const payload: WorkerHeartbeatPayload = {
      instanceId: id,
      coreVersion: "test",
      queues: ["example"],
      concurrency: 3,
      hostname: "test-host",
      pid: 42,
      startedAt: new Date().toISOString(),
    };
    await redis.set(key, JSON.stringify(payload), "EX", WORKER_HEARTBEAT_TTL_SEC);

    const r = await app.request("/api/v1/queues", {
      headers: { Cookie: cookie },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { workers: { instanceId: string; stale: boolean }[] };
    expect(body.workers.some((w) => w.instanceId === id)).toBe(true);
  });
});

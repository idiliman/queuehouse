import "./test-setup";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Hono } from "hono";
import IORedis from "ioredis";
import { Queue } from "bullmq";
import { exampleSuccessJob, bullmqPrefix } from "@queuehouse/core";
import { prisma } from "@queuehouse/db";
import { getOrCreateQueue } from "../src/bullmq/queuehouse-queue";
import { reconcileAllEnabledJobSchedules } from "../src/bullmq/job-schedules";
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
    console.warn("Skipping schedule integration tests: migrate failed.");
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

integrationDescribe("Job schedules (integration)", () => {
  let app: Hono<{ Variables: ApiVariables }>;
  let redis: IORedis;

  beforeAll(async () => {
    const apiConfig = (await import("../src/config")).config;
    app = (await import("../src/server")).default;
    redis = new IORedis(apiConfig.redisUrl!, { maxRetriesPerRequest: null });
  });

  afterAll(async () => {
    await redis.quit();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.jobSchedule.deleteMany();
    const apiConfig = (await import("../src/config")).config;
    const prefix = bullmqPrefix(apiConfig.namespace);
    const queue = new Queue(exampleSuccessJob.queue, {
      connection: redis,
      prefix,
    });
    const scheds = await queue.getJobSchedulers(0, 500, false);
    for (const s of scheds) {
      if (s.id) {
        await queue.removeJobScheduler(s.id);
      }
    }
    await queue.close();
  });

  it("preview, create, list, bull reconcile, delete", async () => {
    const password = await Bun.password.hash("sched-int-test!", { algorithm: "bcrypt" });
    await prisma.user.deleteMany();
    const admin = await prisma.user.create({
      data: {
        email: "schedint@example.com",
        passwordHash: password,
        role: "ADMIN",
      },
    });
    const login = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: admin.email, password: "sched-int-test!" }),
    });
    const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]!.trim());
    const cookieHeader = cookie.join("; ");

    const prev = await app.request("/api/v1/schedules/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieHeader },
      body: JSON.stringify({ cronPattern: "0 5 * * *", timeZone: "UTC", count: 2 }),
    });
    expect(prev.status).toBe(200);
    const prevBody = (await prev.json()) as { runs: { iso: string }[] };
    expect(prevBody.runs.length).toBe(2);

    const create = await app.request("/api/v1/schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieHeader },
      body: JSON.stringify({
        jobName: "example.success",
        cronPattern: "15 4 * * *",
        timeZone: "America/New_York",
        payload: { message: "from cron" },
        enabled: true,
      }),
    });
    if (create.status !== 200) {
      const errB = (await create.json().catch(() => ({}))) as { error?: string };
      throw new Error(`create failed: ${create.status} ${errB.error ?? ""}`);
    }
    const createBody = (await create.json()) as { schedule: { id: string } };
    const sid = createBody.schedule.id;

    const list = await app.request("/api/v1/schedules", {
      headers: { Cookie: cookieHeader },
    });
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { schedules: { id: string }[] };
    expect(listBody.schedules.length).toBe(1);
    expect(listBody.schedules[0]!.id).toBe(sid);

    const apiConfig = (await import("../src/config")).config;
    const q = getOrCreateQueue(redis, apiConfig, exampleSuccessJob.queue);
    const js = await q.getJobScheduler(sid);
    expect(js).toBeDefined();
    expect(js?.pattern).toBe("15 4 * * *");
    expect(js?.tz).toBe("America/New_York");

    const del = await app.request(`/api/v1/schedules/${sid}`, {
      method: "DELETE",
      headers: { Cookie: cookieHeader },
    });
    expect(del.status).toBe(204);
    const after = await q.getJobScheduler(sid);
    expect(after).toBeUndefined();
  });

  it("reconcile marks schema mismatch as needs review and removes Bull scheduler; PATCH recovers", async () => {
    const password = await Bun.password.hash("sched-mismatch!", { algorithm: "bcrypt" });
    await prisma.user.deleteMany();
    const admin = await prisma.user.create({
      data: {
        email: "schedmismatch@example.com",
        passwordHash: password,
        role: "ADMIN",
      },
    });
    const login = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: admin.email, password: "sched-mismatch!" }),
    });
    const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]!.trim());
    const cookieHeader = cookie.join("; ");

    const create = await app.request("/api/v1/schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieHeader },
      body: JSON.stringify({
        jobName: "example.success",
        cronPattern: "20 3 * * *",
        timeZone: "UTC",
        payload: { message: "mismatch test" },
        enabled: true,
      }),
    });
    expect(create.status).toBe(200);
    const createBody = (await create.json()) as { schedule: { id: string } };
    const sid = createBody.schedule.id;

    const apiConfig = (await import("../src/config")).config;
    const q = getOrCreateQueue(redis, apiConfig, exampleSuccessJob.queue);
    expect(await q.getJobScheduler(sid)).toBeDefined();

    await prisma.jobSchedule.update({
      where: { id: sid },
      data: { schemaVersion: 999 },
    });

    const stale = await prisma.jobSchedule.findUniqueOrThrow({ where: { id: sid } });
    await reconcileAllEnabledJobSchedules(redis, apiConfig, [stale]);

    const rowAfter = await prisma.jobSchedule.findUniqueOrThrow({ where: { id: sid } });
    expect(rowAfter.needsReview).toBe(true);
    expect(rowAfter.needsReviewReason).toBe("schema_version_mismatch");
    expect(await q.getJobScheduler(sid)).toBeUndefined();

    const list = await app.request("/api/v1/schedules", {
      headers: { Cookie: cookieHeader },
    });
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as {
      schedules: { id: string; needsReview: boolean; nextRun: string | null }[];
    };
    const listed = listBody.schedules.find((s) => s.id === sid);
    expect(listed?.needsReview).toBe(true);
    expect(listed?.nextRun).toBeNull();

    const recover = await app.request(`/api/v1/schedules/${sid}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookieHeader },
      body: JSON.stringify({
        payload: { message: "mismatch test" },
      }),
    });
    expect(recover.status).toBe(200);
    const recoveredRow = await prisma.jobSchedule.findUniqueOrThrow({ where: { id: sid } });
    expect(recoveredRow.needsReview).toBe(false);
    expect(recoveredRow.schemaVersion).toBe(1);
    expect(await q.getJobScheduler(sid)).toBeDefined();
  });
});

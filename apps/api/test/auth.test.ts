import "./test-setup";
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import app from "../src/server";
import { prisma } from "@queuehouse/db";
import { SESSION_COOKIE_NAME } from "../src/auth/session";

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
      "Skipping API auth tests: Postgres unreachable or migrate failed. Start postgres (e.g. `docker compose up -d postgres`) or set QUEUEHOUSE_REQUIRE_DB_TESTS=1 in CI.",
    );
    return false;
  }
}

const dbReady = tryMigrateForIntegrationTests();
const authDescribe = dbReady ? describe : describe.skip;

authDescribe("API auth", () => {
  beforeEach(async () => {
    await prisma.session.deleteMany();
    await prisma.user.deleteMany();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });
  it("GET /api/v1/auth/session returns 401 when unauthenticated", async () => {
    const res = await app.request("/api/v1/auth/session");
    expect(res.status).toBe(401);
  });

  it("rejects disabled users", async () => {
    await prisma.user.create({
      data: {
        email: "gone@example.com",
        passwordHash: await Bun.password.hash("pw", { algorithm: "bcrypt", cost: 4 }),
        role: "VIEWER",
        disabledAt: new Date(),
      },
    });

    const res = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "gone@example.com", password: "pw" }),
    });
    expect(res.status).toBe(401);
  });

  it("login, session, and logout work with the session cookie", async () => {
    await prisma.user.create({
      data: {
        email: "op@example.com",
        passwordHash: await Bun.password.hash("correct-horse", {
          algorithm: "bcrypt",
          cost: 4,
        }),
        role: "VIEWER",
      },
    });

    const login = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "op@example.com", password: "correct-horse" }),
    });
    expect(login.status).toBe(200);

    const setCookieRaw = login.headers.get("set-cookie");
    expect(setCookieRaw).toBeTruthy();
    expect(setCookieRaw!.toLowerCase()).toContain(SESSION_COOKIE_NAME.toLowerCase());
    const cookieHeader = cookiePairFromSetCookie(setCookieRaw!);

    const sess = await app.request("/api/v1/auth/session", {
      headers: { Cookie: cookieHeader },
    });
    expect(sess.status).toBe(200);
    const body = (await sess.json()) as { user: { email: string; role: string } };
    expect(body.user.email).toBe("op@example.com");
    expect(body.user.role).toBe("VIEWER");

    const logout = await app.request("/api/v1/auth/logout", {
      method: "POST",
      headers: { Cookie: cookieHeader },
    });
    expect(logout.status).toBe(204);

    const after = await app.request("/api/v1/auth/session", {
      headers: { Cookie: cookieHeader },
    });
    expect(after.status).toBe(401);
  });

  it("allows viewers to load OpenAPI JSON and Scalar docs", async () => {
    await prisma.user.create({
      data: {
        email: "docs@example.com",
        passwordHash: await Bun.password.hash("pw", { algorithm: "bcrypt", cost: 4 }),
        role: "VIEWER",
      },
    });
    const login = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "docs@example.com", password: "pw" }),
    });
    const cookie = cookiePairFromSetCookie(login.headers.get("set-cookie")!);

    const oas = await app.request("/api/v1/openapi.json", { headers: { Cookie: cookie } });
    expect(oas.status).toBe(200);
    const spec = (await oas.json()) as { paths?: unknown };
    expect(spec.paths).toBeDefined();

    const docs = await app.request("/api/v1/docs", { headers: { Cookie: cookie } });
    expect(docs.status).toBe(200);
    expect((docs.headers.get("content-type") || "").toLowerCase()).toContain("text/html");
  });

  it("distinguishes viewer vs admin on protected routes", async () => {
    await prisma.user.create({
      data: {
        email: "viewer@example.com",
        passwordHash: await Bun.password.hash("pw", { algorithm: "bcrypt", cost: 4 }),
        role: "VIEWER",
      },
    });
    await prisma.user.create({
      data: {
        email: "admin@example.com",
        passwordHash: await Bun.password.hash("pw", { algorithm: "bcrypt", cost: 4 }),
        role: "ADMIN",
      },
    });

    const viewerLogin = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "viewer@example.com", password: "pw" }),
    });
    const vCookie = cookiePairFromSetCookie(viewerLogin.headers.get("set-cookie")!);

    const vOk = await app.request("/api/v1/protected/viewer", {
      headers: { Cookie: vCookie },
    });
    expect(vOk.status).toBe(200);

    const vAdmin = await app.request("/api/v1/protected/admin", {
      headers: { Cookie: vCookie },
    });
    expect(vAdmin.status).toBe(403);

    const adminLogin = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@example.com", password: "pw" }),
    });
    const aCookie = cookiePairFromSetCookie(adminLogin.headers.get("set-cookie")!);

    const aOk = await app.request("/api/v1/protected/admin", {
      headers: { Cookie: aCookie },
    });
    expect(aOk.status).toBe(200);
  });

  it("propagates X-Request-Id through v1 routes", async () => {
    const res = await app.request("/api/v1/auth/session", {
      headers: { "X-Request-Id": "req_auth_1" },
    });
    expect(res.headers.get("X-Request-Id")).toBe("req_auth_1");
  });

  it("rejects invalid Bearer API keys with invalid_token", async () => {
    const notShape = await app.request("/api/v1/jobs", {
      headers: { Authorization: "Bearer notqh_notvalid" },
    });
    expect(notShape.status).toBe(401);
    const a = (await notShape.json()) as { error: string };
    expect(a.error).toBe("invalid_token");

    const unknown = await app.request("/api/v1/jobs", {
      headers: { Authorization: "Bearer qh_123456789012345678901234567890ab" },
    });
    expect(unknown.status).toBe(401);
  });

  it("creates an API key as admin and uses Bearer for GET /api/v1/jobs", async () => {
    await prisma.user.create({
      data: {
        email: "keyadmin@example.com",
        passwordHash: await Bun.password.hash("pw", { algorithm: "bcrypt", cost: 4 }),
        role: "ADMIN",
      },
    });
    const login = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "keyadmin@example.com", password: "pw" }),
    });
    const cookie = cookiePairFromSetCookie(login.headers.get("set-cookie")!);

    const create = await app.request("/api/v1/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        name: "test",
        scopes: ["read"],
        allowedJobTypes: ["example.success"],
      }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { token: string };
    const jobs = await app.request("/api/v1/jobs?limit=3", {
      headers: { Authorization: `Bearer ${created.token}` },
    });
    expect(jobs.status).toBe(200);
    const list = (await jobs.json()) as { jobs: unknown[] };
    expect(list.jobs).toBeDefined();
  });

  it("rejects non-admins for POST /api/v1/api-keys", async () => {
    await prisma.user.create({
      data: {
        email: "noviewkeys@example.com",
        passwordHash: await Bun.password.hash("pw", { algorithm: "bcrypt", cost: 4 }),
        role: "VIEWER",
      },
    });
    const login = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "noviewkeys@example.com", password: "pw" }),
    });
    const cookie = cookiePairFromSetCookie(login.headers.get("set-cookie")!);
    const res = await app.request("/api/v1/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ scopes: ["read"], allowedJobTypes: ["example.success"] }),
    });
    expect(res.status).toBe(403);
  });
});

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
});

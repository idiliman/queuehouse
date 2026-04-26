import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { prisma } from "../src/index";
import { bootstrapFirstAdmin } from "../src/bootstrap";
import { EXAMPLE_DATABASE_URL } from "@queuehouse/core";

process.env.DATABASE_URL = process.env.DATABASE_URL ?? EXAMPLE_DATABASE_URL;

const dbDir = path.join(fileURLToPath(new URL("..", import.meta.url)));

function tryMigrate(): boolean {
  if (process.env.QUEUEHOUSE_REQUIRE_DB_TESTS === "1") {
    execSync("bunx prisma migrate deploy", {
      cwd: dbDir,
      env: process.env,
      stdio: "inherit",
    });
    return true;
  }
  try {
    execSync("bunx prisma migrate deploy", {
      cwd: dbDir,
      env: process.env,
      stdio: "pipe",
    });
    return true;
  } catch {
    console.warn(
      "Skipping bootstrap tests: Postgres unreachable. Start postgres or set QUEUEHOUSE_REQUIRE_DB_TESTS=1 in CI.",
    );
    return false;
  }
}

const dbReady = tryMigrate();
const bootstrapDescribe = dbReady ? describe : describe.skip;

bootstrapDescribe("bootstrapFirstAdmin", () => {
  beforeEach(async () => {
    await prisma.session.deleteMany();
    await prisma.user.deleteMany();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });
  it("creates an admin when no users exist", async () => {
    await bootstrapFirstAdmin({ email: "Admin@Example.com", password: "longenough" });
    const u = await prisma.user.findFirst();
    expect(u?.email).toBe("admin@example.com");
    expect(u?.role).toBe("ADMIN");
  });

  it("refuses to run when any user already exists", async () => {
    await bootstrapFirstAdmin({ email: "first@example.com", password: "longenough" });
    await expect(
      bootstrapFirstAdmin({ email: "second@example.com", password: "longenough" }),
    ).rejects.toThrow(/already exist/);
  });
});

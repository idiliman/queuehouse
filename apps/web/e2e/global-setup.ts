import { execFileSync } from "node:child_process";
import path from "node:path";
import type { FullConfig } from "@playwright/test";
import { loadRootEnv, repoRootFromHere } from "./load-env";

export default async function globalSetup(_config: FullConfig) {
  loadRootEnv();

  if (!process.env.DATABASE_URL?.trim()) {
    throw new Error(
      "DATABASE_URL is required for E2E (e.g. from repo .env or docker compose Postgres).",
    );
  }
  if (!process.env.REDIS_URL?.trim()) {
    throw new Error("REDIS_URL is required for E2E (e.g. redis://localhost:6379).");
  }

  const root = repoRootFromHere();
  const dbDir = path.join(root, "packages", "db");

  execFileSync("bunx", ["prisma", "migrate", "deploy"], {
    cwd: dbDir,
    stdio: "inherit",
    env: process.env,
  });

  execFileSync("bun", [path.join(root, "apps", "web", "e2e", "ensure-admin.ts")], {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  });
}

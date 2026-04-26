import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";
import { loadRootEnv } from "./e2e/load-env";

loadRootEnv();

const webDir = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.join(webDir, "..", "api");
const webEnv = {
  ...process.env,
  NODE_ENV: "development",
};

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:5173",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium" }],
  webServer: [
    {
      command: "bun run src/server.ts",
      cwd: apiDir,
      url: "http://127.0.0.1:3000/healthz",
      reuseExistingServer: !process.env.CI,
      env: webEnv,
      timeout: 120_000,
    },
    {
      command:
        "bun run build && bun run preview -- --host 127.0.0.1 --port 5173 --strictPort",
      cwd: webDir,
      url: "http://127.0.0.1:5173",
      reuseExistingServer: !process.env.CI,
      env: webEnv,
      timeout: 180_000,
    },
  ],
});

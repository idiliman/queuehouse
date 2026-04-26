import { expect, test, type Page } from "@playwright/test";

const adminEmail = process.env.E2E_ADMIN_EMAIL ?? "e2e-admin@queuehouse.test";
const adminPassword = process.env.E2E_ADMIN_PASSWORD ?? "e2e-test-password-min-8-chars";

async function loginAsAdmin(page: Page) {
  await page.goto("/");
  await page.getByLabel("Email").fill(adminEmail);
  await page.getByLabel("Password").fill(adminPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText(/Signed in as/)).toBeVisible();
}

test.describe("operator smoke", () => {
  test("login and dashboard", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("Email").fill(adminEmail);
    await page.getByLabel("Password").fill(adminPassword);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(
      page.getByText(new RegExp(adminEmail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "Jobs" })).toBeVisible();
  });

  test("jobs table filters and job detail navigation", async ({ page }) => {
    await loginAsAdmin(page);
    await page.getByRole("link", { name: "Jobs" }).click();
    await expect(page.getByText(/Filter jobs stored in BullMQ/)).toBeVisible();

    await page.getByLabel("Job name").fill("nonexistent-job-name-for-e2e");
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect(page.getByText("No jobs match the current filters.")).toBeVisible();

    await page.getByLabel("Job name").clear();
    await page.getByRole("button", { name: "Refresh" }).click();

    await page.goto("/enqueue");
    await expect(page.getByRole("heading", { name: "Manual enqueue" })).toBeVisible();
    await page.getByLabel("Job").selectOption("example.success");
    await page.getByLabel("Payload (JSON)").fill(JSON.stringify({ message: "smoke-filter" }));
    await page.getByLabel("Wait timeout (ms)").fill("20000");
    await page.getByRole("button", { name: "Enqueue" }).click();
    await expect(page.getByText(/Last result/)).toBeVisible({ timeout: 25_000 });

    await page.getByRole("link", { name: "Jobs" }).click();
    await page.getByLabel("Job name").fill("example.success");
    await page.getByRole("button", { name: "Refresh" }).click();
    const open = page.getByRole("link", { name: "Open" }).first();
    await expect(open).toBeVisible({ timeout: 15_000 });
    await open.click();
    await expect(page.getByRole("heading", { name: /Job / })).toBeVisible();
    await expect(page.getByText(/example\.success/)).toBeVisible();
  });

  test("manual enqueue client-side JSON validation", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto("/enqueue");
    await page.getByLabel("Payload (JSON)").fill("{ not json");
    await page.getByRole("button", { name: "Enqueue" }).click();
    await expect(page.getByRole("alert")).toContainText("Payload must be valid JSON.");
  });

  test("schedule creation preview", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto("/schedules");
    await expect(page.getByRole("heading", { name: "Cron schedules" })).toBeVisible();
    await expect(page.getByText("Loading…")).toBeHidden({ timeout: 30_000 });
    await page.getByRole("button", { name: "Preview next runs" }).click();
    await expect(page.getByText(/\d{4}-\d{2}-\d{2}T/)).toBeVisible();
  });

  test("DLQ retry in place", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto("/enqueue");
    await page.getByLabel("Job").selectOption("example.dlq");
    await page.getByLabel("Payload (JSON)").fill("{}");
    await page.getByRole("button", { name: "Enqueue" }).click();
    await expect(page.getByText(/Last result/)).toBeVisible({ timeout: 25_000 });

    await page.goto("/dlq");
    await expect(page.getByText(/Filter jobs stored in BullMQ/)).toBeVisible();

    await expect
      .poll(
        async () => {
          await page.getByRole("button", { name: "Refresh" }).click();
          return page.getByRole("link", { name: "Open" }).count();
        },
        { timeout: 45_000, intervals: [400, 800, 1600, 3000] },
      )
      .toBeGreaterThan(0);

    await page.getByRole("link", { name: "Open" }).first().click();
    await expect(page.getByRole("button", { name: "Retry in place" })).toBeVisible();
    await page.getByRole("button", { name: "Retry in place" }).click();
    await expect(page.getByRole("alert")).toHaveCount(0);
  });

  test("API key token display", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto("/api-keys");
    await expect(page.getByRole("heading", { name: "API keys" })).toBeVisible();

    const jobCheckbox = page.getByRole("checkbox", { name: /example\.success/ });
    await jobCheckbox.check();

    await page.getByRole("button", { name: "Create key" }).click();
    await expect(page.getByText("Copy this token now")).toBeVisible();
    await expect(page.getByText(/^qh_/).first()).toBeVisible();
  });

  test("raw reveal confirmation", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto("/enqueue");
    await page.getByLabel("Job").selectOption("example.success");
    await page.getByLabel("Payload (JSON)").fill(JSON.stringify({ message: "raw-reveal-smoke" }));
    await page.getByLabel("Wait timeout (ms)").fill("25000");
    await page.getByRole("button", { name: "Enqueue" }).click();
    await expect(page.getByText(/Last result/)).toBeVisible({ timeout: 30_000 });

    const section = page.locator("section").filter({ hasText: "Last result" });
    const summary = await section.locator("p").first().innerText();
    const jobId = summary.match(/Job id:\s*(\S+)/)?.[1];
    expect(jobId).toBeTruthy();

    await page.goto(`/jobs/queuehouse-example/${jobId}`);
    await expect(page.getByText(/\[REDACTED\]/)).toBeVisible();

    await page.getByRole("button", { name: /Load raw payload/ }).click();
    await page.getByLabel("Reason").fill("playwright smoke — audited operator access");
    await page.getByRole("button", { name: "Confirm and load" }).click();

    await expect(page.getByText("raw-reveal-smoke")).toBeVisible();
    await expect(page.getByRole("button", { name: "Back to redacted" })).toBeVisible();
  });
});

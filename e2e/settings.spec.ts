import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { ADMIN_TOKEN } from "./constants";

// Must match the console seeded from playwright.config.ts's webServer env.
const SEEDED_CONSOLE = { protectApiBaseUrl: "http://127.0.0.1:9", protectApiKey: "e2e-api-key" };

async function putSettings(request: APIRequestContext, group: string, values: Record<string, string | null>) {
  const res = await request.put("/api/admin/settings", {
    headers: { "x-admin-token": ADMIN_TOKEN },
    data: { group, values },
  });
  expect(res.status(), await res.text()).toBe(200);
}

async function signIn(page: Page) {
  await page.goto("/admin");
  await page.locator("#admin-token").fill(ADMIN_TOKEN);
  await page.getByRole("button", { name: "Enter" }).click();
}

test.describe("settings", () => {
  test.afterEach(async ({ request }) => {
    await putSettings(request, "console", SEEDED_CONSOLE);
    await putSettings(request, "notifications", { slackWebhookUrl: null, alertTimezone: null });
    await putSettings(request, "panel", { helpText: null });
  });

  test("first run walks through setup and lands on Overview", async ({ page, request }) => {
    await putSettings(request, "console", { protectApiBaseUrl: null, protectApiKey: null });
    await signIn(page);

    await expect(page.getByRole("heading", { name: "Encryption key" })).toBeVisible();
    await expect(page.getByText("SECRETS_KEY is set")).toBeVisible();
    await page.getByRole("button", { name: "Continue" }).click();

    await expect(page.getByRole("heading", { name: "UniFi console" })).toBeVisible();
    await page.getByLabel("Console URL").fill(SEEDED_CONSOLE.protectApiBaseUrl);
    await page.getByLabel("Protect API key").fill(SEEDED_CONSOLE.protectApiKey);
    await page.getByRole("button", { name: "Test connection" }).click();
    // Saving first, then testing: the unreachable console fails with a reason, not silently.
    await expect(page.getByText("Protect Integration API")).toBeVisible();
    await expect(page.getByText("ECONNREFUSED").first()).toBeVisible();
    await page.getByRole("button", { name: "Save and continue" }).click();

    await expect(page.getByRole("heading", { name: "Notifications" })).toBeVisible();
    await page.getByRole("button", { name: "Skip this step" }).click();

    await expect(page.getByRole("heading", { name: "Kiosk panel" })).toBeVisible();
    await page.getByLabel("Kiosk help text").fill("Problem? Call the front desk");
    await page.getByRole("button", { name: "Save and finish" }).click();

    await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();

    await page.goto("/panel");
    await expect(page.getByText("Problem? Call the front desk").first()).toBeAttached();
  });

  test("a secret shows only whether it is set, survives a reload, and can be cleared", async ({ page }) => {
    await signIn(page);
    await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
    await page.goto("/admin/settings");

    const field = page.getByLabel("Incoming webhook URL");
    await field.fill("https://hooks.slack.example/e2e-secret");
    await page.getByLabel("Timezone for alert times").fill("Europe/Paris");
    const notifications = page.locator("section", { has: page.getByRole("heading", { name: "Notifications" }) });
    await notifications.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Settings saved")).toBeVisible();

    await page.reload();
    await expect(page.getByLabel("Incoming webhook URL")).toHaveValue("");
    await expect(page.getByLabel("Timezone for alert times")).toHaveValue("Europe/Paris");
    await expect(notifications.getByText("Set", { exact: true }).first()).toBeVisible();
    expect(await page.content()).not.toContain("e2e-secret");

    await notifications.getByRole("button", { name: "Clear" }).first().click();
    await notifications.getByRole("button", { name: "Save" }).click();
    await expect(notifications.getByText("Not set", { exact: true }).first()).toBeVisible();
  });

  test("rejects an invalid value with the reason", async ({ page }) => {
    await signIn(page);
    await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
    await page.goto("/admin/settings");
    await page.getByLabel("Quiet hours start").fill("25");
    const panel = page.locator("section", { has: page.getByRole("heading", { name: "Kiosk panel" }) });
    await panel.getByRole("button", { name: "Save" }).click();
    await expect(panel.getByRole("alert")).toContainText("quietHoursStart");
  });
});

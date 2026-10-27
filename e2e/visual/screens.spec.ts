import { expect, test, type Locator, type Page } from "@playwright/test";
import { ADMIN_TOKEN, DURESS_PIN_LABEL, STANDARD_PIN } from "../constants";

// One walk through every reachable screen and dialog, light theme
// (the only theme a user can reach: nothing sets .dark). Names are the
// snapshot file names, so keep them stable across PRs.

const HOOK = `/api/hooks/sensor?token=e2e-webhook-secret`;
const DOOR = "visual-front-door";
// Desktop and phone. The kiosk keeps its own tablet sizes below.
const WIDTHS = [
  [1440, 900],
  [390, 844],
] as const;

// Not "serial": after a diff the rest of the walk must still run, so one pass reports every changed screen.
// Tests run in file order on one worker and don't depend on each other.

async function signIn(page: Page): Promise<void> {
  await page.goto("/admin");
  await page.locator("#admin-token").fill(ADMIN_TOKEN);
  await page.getByRole("button", { name: "Enter" }).click();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
}

async function open(page: Page, label: string): Promise<void> {
  // Phone width: the sidebar is a drawer, so open it before picking a screen.
  if (!(await page.getByRole("navigation", { name: "Admin screens" }).getByText(label, { exact: true }).isVisible()))
    await page
      .getByRole("button", { name: /sidebar/i })
      .first()
      .click();
  await page.getByText(label, { exact: true }).click();
  await expect(page.getByRole("heading", { name: label })).toBeVisible();
}

// Clocks, dates and relative times change between runs and change the width of
// the text around them, so masking the box isn't enough: rewrite the text to a
// fixed placeholder before the shot. Only this page's DOM is touched.
async function freezeText(page: Page): Promise<void> {
  // The header pill ("DISARMED since 2:19 PM") fills in after the first fetch.
  if (page.url().includes("/admin") && !(await page.locator("#admin-token").count()))
    await expect(page.getByText(/^since /)).toBeVisible();
  await page.evaluate(() => {
    const rules: Array<[RegExp, string]> = [
      [/\b\d{4}-\d{2}-\d{2}\b/g, "2026-01-01"],
      [/\b\d{1,2}:\d{2}(:\d{2})?( ?[AaPp]\.?[Mm]\.?)?/g, "12:00 PM"],
      [/\b(quiet for|for) \d+\s?(s|m|h|d)\b/g, "$1 1m"],
      [/\b\d+\s?(s|m|h|d|min|sec|hours?|days?)\s+ago\b/g, "1m ago"],
      [/\bJust now\b/g, "1m ago"],
    ];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      let t = n.nodeValue ?? "";
      for (const [re, to] of rules) t = t.replace(re, to);
      if (t !== n.nodeValue) n.nodeValue = t;
    }
  });
}

async function shot(page: Page, name: string, extra: Locator[] = []): Promise<void> {
  // Overlays and the panel's JS-driven banner settle over a few hundred ms; rewrite the text after
  // that, since a poll can re-render a relative time ("Just now") between the two.
  await page.waitForTimeout(500);
  await freezeText(page);
  // Focus or a click can leave a page or a pane scrolled by a different amount on each run.
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    for (const el of document.querySelectorAll("*")) if (el.scrollTop) el.scrollTop = 0;
  });
  await expect.soft(page).toHaveScreenshot(`${name}.png`, { mask: [page.locator("time"), ...extra] });
}

for (const [width, height] of WIDTHS) {
  test.describe(`admin ${width}`, () => {
    test.use({ viewport: { width, height } });
    const name = (base: string) => `${base}-${width}`;

    // A failed shot restarts the worker and re-runs this hook: seed once, or later screens would
    // show a second trip and drift for reasons that have nothing to do with the UI.
    test.beforeAll(async ({ request }) => {
      const audit = await request.get("/api/admin/audit", { headers: { "x-admin-token": ADMIN_TOKEN } });
      if (JSON.stringify(await audit.json()).includes(DOOR)) return;
      await request.post(HOOK, { data: { sensorId: DOOR, eventType: "open" } });
    });

    test("login", async ({ page }) => {
      await page.goto("/admin");
      await expect(page.locator("#admin-token")).toBeVisible();
      await shot(page, name("admin-login"));
    });

    test("login rejected", async ({ page }) => {
      await page.goto("/admin");
      await page.locator("#admin-token").fill("not-the-token");
      await page.getByRole("button", { name: "Enter" }).click();
      await expect(page.getByText("Token rejected.")).toBeVisible();
      await shot(page, name("admin-login-rejected"));
    });

    test("screens", async ({ page }) => {
      await signIn(page);
      await shot(page, name("admin-overview"));
      for (const [label, slug] of [
        ["Sensors", "sensors"],
        ["PINs", "pins"],
        ["Delays", "delays"],
        ["Audit log", "audit"],
        ["Events", "events"],
        ["Tasks", "tasks"],
        ["Settings", "settings"],
      ]) {
        await open(page, label);
        await shot(page, name(`admin-${slug}`));
      }
    });

    test("sensor detail and delete dialog", async ({ page }) => {
      await signIn(page);
      await open(page, "Sensors");
      await page.getByRole("button").filter({ hasText: DOOR }).click();
      await shot(page, name("admin-sensor-detail"));
      await page.getByRole("button", { name: "Delete sensor" }).click();
      await expect(page.getByRole("heading", { name: `Delete "${DOOR}"?` })).toBeVisible();
      await shot(page, name("admin-dialog-delete-sensor"));
    });

    test("pin detail, revoke dialog and toast", async ({ page }) => {
      await signIn(page);
      await open(page, "PINs");
      await page.getByRole("row").filter({ hasText: DURESS_PIN_LABEL }).click();
      await expect(page.getByRole("heading", { name: "Edit PIN" })).toBeVisible();
      await shot(page, name("admin-dialog-pin-detail"));
      await page.keyboard.press("Escape");
      await page.getByRole("row").filter({ hasText: DURESS_PIN_LABEL }).getByRole("button", { name: "Revoke" }).click();
      await expect(page.getByRole("heading", { name: `Revoke "${DURESS_PIN_LABEL}"?` })).toBeVisible();
      await shot(page, name("admin-dialog-revoke-pin"));
      await page.getByRole("button", { name: "Cancel" }).click();
      await page.locator("#new-pin-label").fill(`Visual PIN ${width}`);
      await page.locator("#new-pin-code").fill(width === 1440 ? "9753" : "9754"); // one DB for both widths: a PIN code must be unique
      await page.getByRole("button", { name: "Add PIN" }).click();
      await expect(page.getByText("PIN added. Active immediately.")).toBeVisible();
      // The Add PIN button fades to its "Added" state; which frame the shot catches changes between runs.
      await shot(page, name("admin-pins-toast"), [page.getByRole("button", { name: "Added" })]);
    });

    test("arm dialogs", async ({ page, request }) => {
      // Disarm dialog with the PIN keypad: arm first, then open "Disarm".
      await signIn(page);
      await page.getByRole("button", { name: "Arm system" }).click();
      await expect(page.getByRole("button", { name: "Disarm" })).toBeVisible();
      await page.getByRole("button", { name: "Disarm" }).click();
      await expect(page.getByRole("alertdialog")).toBeVisible();
      await shot(page, name("admin-dialog-disarm-pin"));
      await page.keyboard.press("Escape");
      await request.post("/api/disarm", { data: { pin: STANDARD_PIN } });
    });
  });
}

test.describe("panel", () => {
  test.use({ viewport: { width: 1024, height: 768 } });
  const volatile = (page: Page) => [page.locator("#clock-time, #clock-date, #forecast, #welcome-name")];

  test.beforeAll(async ({ request }) => {
    await request.post("/api/disarm", { data: { pin: STANDARD_PIN } });
  });

  test("disarmed and arm confirm", async ({ page }) => {
    await page.goto("/panel");
    await expect(page.locator("#banner-label")).toHaveText("Disarmed");
    await shot(page, "panel-disarmed", volatile(page));
    await page.locator("#action-btn").click();
    await expect(page.locator("#arm-confirm-overlay")).toBeVisible();
    await shot(page, "panel-arm-confirm", volatile(page));
  });

  test("open door, arm confirm over an open door, test mode", async ({ page, request }) => {
    const headers = { "x-admin-token": ADMIN_TOKEN };
    const doorId = "visual-panel-door";
    try {
      await request.put("/api/admin/config", {
        headers,
        data: { config: { sensorOpenEventTypes: "visual-open", sensorClosedEventTypes: "visual-close" } },
      });
      await request.put("/api/admin/config", {
        headers,
        data: { sensors: [{ unifiId: doorId, mode: "instant", sensorType: "door" }] },
      });
      await request.post(HOOK, { data: { sensorId: doorId, eventType: "visual-open" } });

      await page.goto("/panel");
      await expect(page.locator("#doors")).toContainText(doorId);
      await shot(page, "panel-door-open", volatile(page));

      await page.locator("#action-btn").click();
      await page.locator("#arm-confirm-yes").click(); // refused: the overlay reopens naming the open door
      await expect(page.locator("#arm-confirm-title")).toHaveText("Door open. Arm anyway?");
      await shot(page, "panel-door-open-confirm", volatile(page));
      await page.locator("#arm-confirm-cancel").click();

      await request.put("/api/admin/config", { headers, data: { config: { panelTestMode: "true" } } });
      await expect(page.locator("#test-mode-badge")).toBeVisible({ timeout: 6_000 });
      await shot(page, "panel-test-mode", volatile(page));
    } finally {
      await request.put("/api/admin/config", {
        headers,
        data: { config: { panelTestMode: "false", sensorOpenEventTypes: "", sensorClosedEventTypes: "" } },
      });
      await request.delete(`/api/admin/config?unifiId=${doorId}`, { headers });
    }
  });

  test("armed and alarm", async ({ page, request }) => {
    await page.goto("/panel");
    await page.locator("#action-btn").click();
    await page.locator("#arm-confirm-yes").click();
    await expect(page.locator("#banner-label")).toHaveText("Armed", { timeout: 10_000 });
    await shot(page, "panel-armed", volatile(page));

    await request.post(HOOK, { data: { sensorId: DOOR, eventType: "open" } });
    await expect(page.locator("#banner-label")).toHaveText("ALARM", { timeout: 10_000 });
    await shot(page, "panel-alarm", volatile(page));
    await request.post("/api/disarm", { data: { pin: STANDARD_PIN } });
  });

  test("portrait", async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto("/panel");
    await expect(page.locator("#banner-label")).toHaveText("Disarmed", { timeout: 10_000 });
    await shot(page, "panel-portrait", volatile(page));
  });

  // Not a real kiosk size: a phone-width overflow check only.
  test("phone width", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/panel");
    await expect(page.locator("#banner-label")).toHaveText("Disarmed", { timeout: 10_000 });
    await shot(page, "panel-390", volatile(page));
  });
});

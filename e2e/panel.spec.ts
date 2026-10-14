import { expect, test, type Page } from "@playwright/test";
import { ADMIN_TOKEN, DURESS_PIN, STANDARD_PIN } from "./constants";

async function typePin(page: Page, pin: string): Promise<void> {
  for (const digit of pin) {
    await page.locator(`button[data-digit="${digit}"]`).click();
  }
}

// Arming takes no PIN — just the confirm dialog. See public/panel.js /
// app/api/panel/arm/route.ts.
async function armViaConfirm(page: Page): Promise<void> {
  await page.locator("#action-btn").click();
  await expect(page.locator("#arm-confirm-overlay")).toBeVisible();
  await page.locator("#arm-confirm-yes").click();
}

test.describe("panel kiosk", () => {
  test.beforeAll(async ({ request }) => {
    // Guarantee a DISARMED baseline regardless of what ran before this spec
    // (the suite runs against one shared server/state — see playwright.config.ts).
    await request.post("/api/disarm", { data: { pin: STANDARD_PIN } });
  });

  test("renders the current state with JavaScript disabled", async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto("/panel");
    await expect(page.locator("#banner-label")).toHaveText("Disarmed");
    await expect(page.locator("#action-btn")).toHaveText("Arm system");
    // The keypad is only for disarming — hidden server-side while disarmed,
    // even with no JS to toggle it later.
    await expect(page.locator("#keypad")).toBeHidden();
    await expect(page.locator("#pin-dots")).toBeHidden();
    await expect(page.locator("#offline-banner")).toBeHidden();
    await context.close();
  });

  test("idle disarmed state hides the keypad and offers a tap-to-confirm arm", async ({ page }) => {
    await page.goto("/panel");
    await expect(page.locator("#banner-label")).toHaveText("Disarmed");
    await expect(page.locator("#keypad")).toBeHidden();
    await expect(page.locator("#pin-dots")).toBeHidden();
    await expect(page.locator("#action-btn")).toHaveText("Arm system");

    // Tapping opens a confirmation instead of arming immediately; cancelling
    // leaves the system untouched.
    await page.locator("#action-btn").click();
    await expect(page.locator("#arm-confirm-overlay")).toBeVisible();
    await page.locator("#arm-confirm-cancel").click();
    await expect(page.locator("#arm-confirm-overlay")).toBeHidden();
    await expect(page.locator("#banner-label")).toHaveText("Disarmed");
  });

  test("arms with a tap + confirm (no PIN), shows the exit delay, then settles into ARMED", async ({ page }) => {
    await page.goto("/panel");
    await armViaConfirm(page);

    await expect(page.locator("#message")).toHaveText("Armed: exit now");
    await expect(page.locator("#banner-label")).toHaveText("Arming");
    await expect(page.locator("#status-banner")).toHaveClass(/state-arming/);
    await expect(page.locator("#action-btn")).toHaveText("Disarm");
    // Only disarming is PIN-gated — the keypad reappears now that there's
    // something to disarm.
    await expect(page.locator("#keypad")).toBeVisible();
    await expect(page.locator("#pin-dots")).toBeVisible();

    // DEFAULT_EXIT_DELAY_SEC=2 in the e2e environment (playwright.config.ts).
    await expect(page.locator("#banner-label")).toHaveText("Armed", { timeout: 8_000 });
    await expect(page.locator("#status-banner")).toHaveClass(/state-armed/);
    await expect(page.locator("#banner-countdown")).toBeHidden();

    // Restore the disarmed baseline for the tests after this one. The 4th
    // digit auto-submits (see addDigit() in public/panel.js) — no separate
    // submit click.
    await typePin(page, STANDARD_PIN);
    await expect(page.locator("#message")).toHaveText("System disarmed");
    await expect(page.locator("#banner-label")).toHaveText("Disarmed");
    await expect(page.locator("#action-btn")).toHaveText("Arm system");
  });

  test("blocks arming while a gating door sensor is open, and 'Yes, arm' again overrides it", async ({ page, request }) => {
    const doorId = `e2e-panel-gate-door-${Date.now()}`;
    try {
      // A distinct eventType (not the "open"/"close" other specs use) so this
      // doesn't reclassify any other test's sensor state — sensorOpenEventTypes
      // is opt-in and config-mapped, same precedent as cameraTriggerEventTypes.
      await request.put("/api/admin/config", {
        headers: { "x-admin-token": ADMIN_TOKEN },
        data: { config: { sensorOpenEventTypes: "e2e-door-open", sensorClosedEventTypes: "e2e-door-close" } },
      });
      await request.put("/api/admin/config", {
        headers: { "x-admin-token": ADMIN_TOKEN },
        data: { sensors: [{ unifiId: doorId, mode: "instant", sensorType: "door" }] },
      });
      const webhookRes = await request.post(`/api/hooks/sensor?token=e2e-webhook-secret`, {
        data: { sensorId: doorId, eventType: "e2e-door-open" },
      });
      expect(webhookRes.ok()).toBeTruthy();

      await page.goto("/panel");
      await armViaConfirm(page);

      // Blocked — the overlay reopens with the door named, and the system is still disarmed.
      await expect(page.locator("#arm-confirm-overlay")).toBeVisible();
      await expect(page.locator("#arm-confirm-title")).toHaveText("Door open. Arm anyway?");
      await expect(page.locator("#arm-confirm-sub")).toContainText(doorId);
      await expect(page.locator("#banner-label")).toHaveText("Disarmed");

      // Confirming again sends the override and actually arms.
      await page.locator("#arm-confirm-yes").click();
      await expect(page.locator("#message")).toHaveText("Armed: exit now");
      await expect(page.locator("#banner-label")).toHaveText("Arming");

      // Restore the disarmed baseline for the tests after this one. The 4th
      // digit auto-submits — no separate submit click.
      await expect(page.locator("#banner-label")).toHaveText("Armed", { timeout: 8_000 });
      await typePin(page, STANDARD_PIN);
      await expect(page.locator("#banner-label")).toHaveText("Disarmed");
    } finally {
      // Guaranteed even if an assertion above throws: this sensor stays
      // current_state='open' forever unless removed, blocking every later arm
      // in this shared, serial suite, and a lingering sensorOpenEventTypes
      // would silently mark other tests' sensors open too.
      await request.delete(`/api/admin/config?unifiId=${doorId}`, { headers: { "x-admin-token": ADMIN_TOKEN } });
      await request.put("/api/admin/config", {
        headers: { "x-admin-token": ADMIN_TOKEN },
        data: { config: { sensorOpenEventTypes: "", sensorClosedEventTypes: "" } },
      });
      await request.post("/api/disarm", { data: { pin: STANDARD_PIN } });
    }
  });

  test("a door sensor tripping during the exit delay increments armingTripCount, exposed to the panel's chime", async ({
    page,
    request,
  }) => {
    const doorId = `e2e-arming-chime-door-${Date.now()}`;
    await request.put("/api/admin/config", {
      headers: { "x-admin-token": ADMIN_TOKEN },
      data: { sensors: [{ unifiId: doorId, mode: "delayed", sensorType: "door" }] },
    });

    await page.goto("/panel");
    await armViaConfirm(page);
    await expect(page.locator("#banner-label")).toHaveText("Arming");

    const statusBefore = await (await request.get("/api/status")).json();
    expect(statusBefore.armingTripCount).toBe(0);

    await request.post(`/api/hooks/sensor?token=e2e-webhook-secret`, { data: { sensorId: doorId, eventType: "open" } });

    const statusAfter = await (await request.get("/api/status")).json();
    expect(statusAfter.armingTripCount).toBe(1);
    expect(statusAfter.armingTripDoors).toHaveLength(1);
    await expect(page.locator("#message")).toContainText("Door opened:");

    // Restore the disarmed baseline for the tests after this one. The 4th
    // digit auto-submits — no separate submit click.
    await expect(page.locator("#banner-label")).toHaveText("Armed", { timeout: 8_000 });
    await typePin(page, STANDARD_PIN);
    await expect(page.locator("#banner-label")).toHaveText("Disarmed");
  });

  test("lists every door under the banner (open ones first)", async ({ page, request }) => {
    const doorId = `e2e-strip-door-${Date.now()}`;
    await request.put("/api/admin/config", {
      headers: { "x-admin-token": ADMIN_TOKEN },
      data: { sensors: [{ unifiId: doorId, mode: "delayed", sensorType: "door" }] },
    });
    await page.goto("/panel");
    await expect(page.locator("#doors .door:not([hidden])").filter({ hasText: doorId })).toBeVisible();

    await armViaConfirm(page);
    await expect(page.locator("#banner-label")).toHaveText("Arming");
    await expect(page.locator("#armed-info")).toContainText("Armed by Panel at");

    // A PIN is what disarms, including during the exit delay.
    await typePin(page, STANDARD_PIN);
    await expect(page.locator("#banner-label")).toHaveText("Disarmed");
    await expect(page.locator("#armed-info")).toBeHidden();
  });

  test("test mode from the admin config shows a banner on the kiosk and reports through /api/status", async ({ page, request }) => {
    const setTestMode = (on: boolean) =>
      request.put("/api/admin/config", { headers: { "x-admin-token": ADMIN_TOKEN }, data: { config: { panelTestMode: on ? "true" : "false" } } });
    try {
      await page.goto("/panel");
      await expect(page.locator("#test-mode-badge")).toBeHidden();
      await setTestMode(true);
      expect((await (await request.get("/api/status")).json()).testMode).toBe(true);
      await expect(page.locator("#test-mode-badge")).toBeVisible({ timeout: 6_000 });
    } finally {
      await setTestMode(false);
    }
    await expect(page.locator("#test-mode-badge")).toBeHidden({ timeout: 6_000 });
  });

  test.describe("disarming (system armed)", () => {
    test.beforeEach(async ({ request }) => {
      await request.post("/api/panel/arm");
    });

    test.afterEach(async ({ request }) => {
      // A DISARM event while already disarmed is a harmless no-op in the
      // state machine (lib/state/machine.ts), so this is safe to call
      // whether or not the test itself already disarmed.
      await request.post("/api/disarm", { data: { pin: STANDARD_PIN } });
    });

    test("typing digits fills the PIN dots; backspace and clear work on a partial entry", async ({ page }) => {
      await page.goto("/panel");
      await expect(page.locator("#banner-label")).not.toHaveText("Disarmed");

      // Always exactly 4 dots in the DOM — no growing past 4.
      await expect(page.locator(".pin-dot")).toHaveCount(4);

      // Stays under 4 throughout this test: the 4th digit auto-submits (see
      // addDigit() in public/panel.js), which would clear the buffer out
      // from under backspace/clear — that behavior is covered by the
      // auto-submit tests below instead.
      await typePin(page, "123");
      await expect(page.locator(".pin-dot.filled")).toHaveCount(3);
      // Disarm is greyed out mid-entry (the 4th digit auto-submits) and back once cleared.
      await expect(page.locator("#action-btn")).toBeDisabled();

      await page.locator("#backspace-btn").click();
      await expect(page.locator(".pin-dot.filled")).toHaveCount(2);

      await page.locator("#clear-btn").click();
      await expect(page.locator(".pin-dot.filled")).toHaveCount(0);
      await expect(page.locator("#action-btn")).toBeEnabled();
    });

    test("tapping Disarm with no digits shows a hint, without calling the API", async ({ page }) => {
      await page.goto("/panel");
      await page.locator("#action-btn").click();
      await expect(page.locator("#message")).toHaveText("Enter your 4-digit PIN");
      await expect(page.locator("#banner-label")).not.toHaveText("Disarmed");
    });

    test("a wrong PIN shakes and shows a generic error with tries remaining — never which PIN or duress", async ({ page }) => {
      await page.goto("/panel");
      // Wait out the 2s exit delay first: the ARMING -> ARMED poll clears the
      // message line (meant for "Door opened: …"), and used to wipe this
      // test's error before it could be read whenever the reply landed just
      // before that poll.
      await expect(page.locator("#banner-label")).toHaveText("Armed", { timeout: 8_000 });
      await typePin(page, "0000");
      // Not an exact count: every PIN attempt shares one lockout bucket (see
      // PIN_BUCKET in lib/engine/index.ts), so the exact remaining count
      // depends on suite run order.
      await expect(page.locator("#message")).toHaveText(/^(Incorrect PIN\. \d+ tries remaining|LAST TRY: one more wrong PIN triggers the alarm)$/);
      const message = await page.locator("#message").textContent();
      expect(message?.toLowerCase()).not.toContain("duress");
    });

    test("the 4th digit auto-submits the right PIN — no separate Disarm tap — and shows a welcome message", async ({ page }) => {
      await page.goto("/panel");
      await typePin(page, STANDARD_PIN);
      await expect(page.locator("#message")).toHaveText("System disarmed");
      await expect(page.locator("#banner-label")).toHaveText("Disarmed");
      await expect(page.locator("#action-btn")).toHaveText("Arm system");
      await expect(page.locator("#keypad")).toBeHidden();

      // STANDARD_PIN_LABEL is "E2E Standard" — first name only, per
      // AlarmEngine.dispatch()'s welcomeName tracking.
      await expect(page.locator("#disarmed-panel")).toBeVisible();
      await expect(page.locator("#welcome-message")).toBeVisible();
      await expect(page.locator("#welcome-name")).toHaveText("E2E");
    });
  });

  test("an instant sensor trip while armed drives the panel into ALARM, and disarm silences it", async ({
    page,
    request,
  }) => {
    const sensorId = `e2e-instant-${Date.now()}`;
    // Register the sensor as "instant" mode via the admin API so it trips
    // the alarm immediately rather than starting an entry delay.
    const adminHeaders = { "content-type": "application/json", "x-admin-token": "e2e-admin-token" };
    await request.post("/api/hooks/sensor?token=e2e-webhook-secret", { data: { sensorId, eventType: "open" } });
    await request.put("/api/admin/config", {
      headers: adminHeaders,
      data: { sensors: [{ unifiId: sensorId, mode: "instant" }] },
    });

    await page.goto("/panel");
    await armViaConfirm(page);
    await expect(page.locator("#banner-label")).toHaveText("Armed", { timeout: 8_000 });

    await request.post("/api/hooks/sensor?token=e2e-webhook-secret", { data: { sensorId, eventType: "open" } });

    await expect(page.locator("#banner-label")).toHaveText("ALARM", { timeout: 5_000 });
    await expect(page.locator("#status-banner")).toHaveClass(/state-alarm/);
    await expect(page.locator("#message")).toHaveText("Enter PIN to silence and disarm");
    await expect(page.locator("#action-btn")).toHaveText("Disarm");

    await typePin(page, STANDARD_PIN);
    await expect(page.locator("#banner-label")).toHaveText("Disarmed");
  });

  test("a duress PIN silences ALARM but is indistinguishable in the UI from a normal disarm", async ({ page, request }) => {
    const sensorId = `e2e-instant-duress-${Date.now()}`;
    const adminHeaders = { "content-type": "application/json", "x-admin-token": "e2e-admin-token" };
    await request.post("/api/hooks/sensor?token=e2e-webhook-secret", { data: { sensorId, eventType: "open" } });
    await request.put("/api/admin/config", { headers: adminHeaders, data: { sensors: [{ unifiId: sensorId, mode: "instant" }] } });

    await page.goto("/panel");
    await armViaConfirm(page);
    await expect(page.locator("#banner-label")).toHaveText("Armed", { timeout: 8_000 });

    await request.post("/api/hooks/sensor?token=e2e-webhook-secret", { data: { sensorId, eventType: "open" } });
    await expect(page.locator("#banner-label")).toHaveText("ALARM", { timeout: 5_000 });

    // Same exact assertions as the standard-PIN disarm above — the whole
    // point of duress is that nothing here differs from a normal disarm.
    await typePin(page, DURESS_PIN);
    await expect(page.locator("#message")).toHaveText("System disarmed");
    await expect(page.locator("#banner-label")).toHaveText("Disarmed");
    await expect(page.locator("#welcome-name")).toHaveText("E2E");

    const bodyText = await page.locator("body").innerText();
    expect(bodyText.toLowerCase()).not.toContain("duress");
  });

  // Every PIN attempt shares one lockout bucket, whatever X-Forwarded-For says
  // (see PIN_BUCKET in lib/engine/index.ts), and a correct PIN doesn't clear
  // it, so these tests can't isolate themselves. Instead the window and the
  // lockout are shortened to a few seconds and waited out on both sides, so
  // these start from a clean count and nothing after them inherits a locked
  // keypad or an ALARM.
  test.describe("PIN lockout", () => {
    const SHORT_SEC = 3;
    const setLimits = (request: import("@playwright/test").APIRequestContext, windowSec: number, lockoutSec: number) =>
      request.put("/api/admin/config", {
        headers: { "x-admin-token": ADMIN_TOKEN },
        data: { config: { rateLimitWindowSec: windowSec, rateLimitLockoutSec: lockoutSec } },
      });
    const waitOut = () => new Promise((r) => setTimeout(r, (SHORT_SEC + 0.5) * 1000));

    test.beforeEach(async ({ request }) => {
      // A short window first, so earlier tests' wrong PINs age out...
      await setLimits(request, SHORT_SEC, SHORT_SEC);
      await waitOut();
      // ...then a long one, so this test's own five tries all count however slowly they're typed.
      await setLimits(request, 60, SHORT_SEC);
    });

    test.afterEach(async ({ request }) => {
      await waitOut(); // the lockout expires, which drops the bucket
      await request.post("/api/disarm", { data: { pin: STANDARD_PIN } });
      await setLimits(request, 300, 300);
    });

    test("5 wrong PINs locks the panel out, triggers the alarm, and rejects even the correct PIN while locked", async ({
      page,
      request,
    }) => {
      await page.goto("/panel");
      await armViaConfirm(page);
      await expect(page.locator("#banner-label")).toHaveText("Armed", { timeout: 8_000 });

      // The 5 failures go through the API, not rapid real-UI clicks:
      // submitPin() in panel.js doesn't disable the button while a request is
      // in flight, so back-to-back clicks can race. Each claims a different
      // source, which used to buy a fresh bucket per request and no lockout.
      for (let i = 0; i < 4; i++) {
        const res = await request.post("/api/disarm", { headers: { "x-forwarded-for": `10.66.0.${i}` }, data: { pin: "0000" } });
        expect(res.status()).toBe(401);
      }
      // The 5th tips the shared bucket into lockout: 429, and a real ALARM (see handlePinLockout in lib/state/machine.ts).
      const fifth = await request.post("/api/disarm", { headers: { "x-forwarded-for": "10.66.0.4" }, data: { pin: "0000" } });
      expect(fifth.status()).toBe(429);

      // At the real keypad, even the *correct* PIN is rejected while locked
      // out. Checked on the keypad's own request, not the message line: the
      // system is already in ALARM, so the ~2s status poll overwrites the
      // lockout message with "Enter PIN to silence and disarm".
      await expect(page.locator("#banner-label")).toHaveText("ALARM", { timeout: 5_000 });
      const rejected = page.waitForResponse((res) => res.url().endsWith("/api/disarm"));
      await typePin(page, STANDARD_PIN);
      expect((await rejected).status()).toBe(429);
      await expect(page.locator("#banner-label")).toHaveText("ALARM");
    });

    test("5 wrong PINs typed at the real keypad count down and drive the panel live into ALARM", async ({ page }) => {
      await page.goto("/panel");
      await armViaConfirm(page);
      await expect(page.locator("#banner-label")).toHaveText("Armed", { timeout: 8_000 });

      for (let remaining = 4; remaining >= 1; remaining--) {
        await typePin(page, "0000");
        await expect(page.locator("#message")).toHaveText(
          remaining === 1
            ? "LAST TRY: one more wrong PIN triggers the alarm"
            : `Incorrect PIN. ${remaining} tries remaining`,
        );
      }

      // The 5th wrong PIN tips the bucket into lockout, through the real
      // keypad this time, and the panel itself shows the alarm it triggered.
      // Not asserting the lockout response's own message text here: the
      // panel's ~2s status poll (see pollStatus/applyStatus in panel.js)
      // notices ALARM right on its heels and overwrites it with the generic
      // "Enter PIN to silence and disarm" — a harmless race between two
      // legitimate messages. The banner settling into ALARM is the non-racy check.
      await typePin(page, "0000");
      await expect(page.locator("#banner-label")).toHaveText("ALARM", { timeout: 5_000 });
      await expect(page.locator("#status-banner")).toHaveClass(/state-alarm/);
    });
  });

  test("landscape orientation swaps to the two-column layout", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto("/panel");
    await expect(page.locator(".help-line-left")).toBeVisible();
    await expect(page.locator(".help-line-right")).toBeHidden();
  });

  test("portrait orientation uses the single-column layout", async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto("/panel");
    await expect(page.locator(".help-line-right")).toBeVisible();
    await expect(page.locator(".help-line-left")).toBeHidden();
  });

  test("the panel is one main landmark that holds the status and the keypad", async ({ page }) => {
    await page.goto("/panel");
    await expect(page.getByRole("main")).toHaveCount(1);
    await expect(page.getByRole("main").locator("#status-banner")).toBeAttached();
    await expect(page.getByRole("main").locator("#keypad")).toBeAttached();
  });
});

import { readFileSync, writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { ADMIN_TOKEN, STANDARD_PIN } from "./constants";

async function signIn(page: Page): Promise<void> {
  await page.goto("/admin");
  await page.locator("#admin-token").fill(ADMIN_TOKEN);
  await page.getByRole("button", { name: "Enter" }).click();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
}

test.describe("admin portal", () => {
  test("rejects a wrong token and accepts the right one", async ({ page }) => {
    await page.goto("/admin");
    await page.locator("#admin-token").fill("not-the-token");
    await page.getByRole("button", { name: "Enter" }).click();
    await expect(page.getByText("Token rejected.")).toBeVisible();

    await page.locator("#admin-token").fill(ADMIN_TOKEN);
    await page.getByRole("button", { name: "Enter" }).click();
    await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  });

  test("never shows the admin UI for a stored token the server rejects", async ({ page }) => {
    await page.addInitScript(() => sessionStorage.setItem("uap-admin-token", "stale-token"));
    await page.goto("/admin");
    await expect(page.getByText("Token rejected.")).toBeVisible();
    await expect(page.getByText("Signed in via admin token")).toHaveCount(0);
  });

  test("navigates every sidebar screen, reflecting the path in the URL", async ({ page }) => {
    await signIn(page);
    await expect(page).toHaveURL(/\/admin\/?$/);

    const screens: Array<[label: string, slug: string]> = [
      ["Sensors", "sensors"],
      ["PINs", "pins"],
      ["Delays", "delays"],
      ["Audit log", "audit"],
      ["Tasks", "tasks"],
      ["Settings", "settings"],
    ];
    for (const [label, slug] of screens) {
      await page.getByText(label, { exact: true }).click();
      await expect(page.getByRole("heading", { name: label })).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`/admin/${slug}$`));
    }

    // Overview has no path segment of its own — it's the /admin base route.
    await page.getByText("Overview", { exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/?$/);

    // A direct link into a subpage (e.g. bookmarked or shared) lands straight
    // on that screen instead of always resetting to Overview.
    await page.goto("/admin/sensors");
    await expect(page.getByRole("heading", { name: "Sensors" })).toBeVisible();
  });

  test("Tasks screen shows update/connectivity status and both 'Check now' buttons work", async ({ page }) => {
    await signIn(page);
    await page.getByText("Tasks", { exact: true }).click();
    await expect(page.getByText("Update check", { exact: true })).toBeVisible();
    await expect(page.getByText("Connectivity watchdog")).toBeVisible();

    // Each card gets its own "Check now" button, so scope by card.
    const updateCard = page.locator("div.border-border").filter({ hasText: "Update check" });
    const connectivityCard = page.locator("div.border-border").filter({ hasText: "Connectivity watchdog" });

    // The check asks GitHub anonymously (no token needed for public
    // releases). Whether GitHub answers or not, "last checked" must advance:
    // a failed check surfaces its error rather than looking like the
    // scheduler never ran (see lib/services/update-check.ts).
    await updateCard.getByRole("button", { name: "Check now" }).click();
    await expect(updateCard.getByText(/last checked Just now/)).toBeVisible();
    await expect(updateCard.getByRole("button", { name: "Check now" })).toBeVisible();

    // Connectivity's own "Check now" forces a fresh poll — see
    // lib/services/connectivity-watchdog.ts — and returns to idle after.
    await connectivityCard.getByRole("button", { name: "Check now" }).click();
    await expect(connectivityCard.getByText("Last checked: Just now")).toBeVisible();
    await expect(connectivityCard.getByRole("button", { name: "Check now" })).toBeVisible();
  });

  test("a live requested: -> applying: -> done: transition auto-reloads the page, but an already-in-progress state on load does not", async ({
    page,
  }) => {
    // Seeds a real "requested:" state via the same API the "Update to
    // latest" button calls, then loads straight into it — the reload effect
    // (app/admin/[[...screen]]/page.tsx) must not fire just because the page
    // happened to mount mid-update, only on a transition it observes live.
    await page.request.post("/api/admin/update", {
      headers: { "x-admin-token": ADMIN_TOKEN },
      data: { tag: "v9.9.9" },
    });
    await signIn(page);
    await page.getByText("Tasks", { exact: true }).click();
    await expect(page.getByText("Update requested")).toBeVisible();

    // waitForEvent, not waitForLoadState — the latter resolves immediately
    // if the page is already in that state, so it can't tell "no reload
    // happened" from "already loaded a while ago". This actually waits for
    // the *next* navigation, resolving false on a timeout with none.
    async function reloadHappened(timeoutMs: number): Promise<boolean> {
      return page
        .waitForEvent("load", { timeout: timeoutMs })
        .then(() => true)
        .catch(() => false);
    }

    // Simulates the root updater timer picking the request up.
    writeFileSync("./data/update-status", "applying:v9.9.9");
    const updateCard = page.locator("div.border-border").filter({ hasText: "Update check" });
    const notReloadedYet = reloadHappened(1500);
    await updateCard.getByRole("button", { name: "Check now" }).click();
    await expect(updateCard.getByText("Updating to")).toBeVisible();
    expect(await notReloadedYet).toBe(false);

    // Simulates the update finishing — the app should toast and reload on
    // its own, without the admin needing to notice and refresh manually.
    writeFileSync("./data/update-status", "done:v9.9.9");
    const reloadsNow = reloadHappened(5000);
    await updateCard.getByRole("button", { name: "Check now" }).click();
    await expect(page.getByText(/Update applied\. Reloading/)).toBeVisible();
    expect(await reloadsNow).toBe(true);
    await expect(page.getByText("Last update applied")).toBeVisible();
  });

  test("adds a PIN, sees it active, then revokes it", async ({ page }) => {
    await signIn(page);
    await page.getByText("PINs", { exact: true }).click();

    const label = `E2E CRUD ${Date.now()}`;
    await page.locator("#new-pin-label").fill(label);
    await page.locator("#new-pin-code").fill("4445");
    await page.getByRole("button", { name: "Add PIN" }).click();
    await expect(page.getByText("PIN added. Active immediately.")).toBeVisible();

    const row = page.getByRole("row").filter({ hasText: label });
    await expect(row.getByText("Active")).toBeVisible();

    await row.getByRole("button", { name: "Revoke" }).click();
    await expect(page.getByRole("heading", { name: `Revoke "${label}"?` })).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("heading", { name: `Revoke "${label}"?` })).not.toBeVisible();

    await row.getByRole("button", { name: "Revoke" }).click();
    await page.getByRole("button", { name: "Revoke PIN" }).click();

    // The Status filter defaults to Active — a revoked PIN is kept for
    // audit purposes only, not something shown day to day — so the row this
    // just revoked drops out of view on its own, with no filter click.
    await expect(row).not.toBeVisible();
    await expect(page).not.toHaveURL(/[?&]status=/);

    await page.getByRole("button", { name: "All", exact: true }).click();
    await expect(row.getByText("Revoked")).toBeVisible();
    await expect(row.getByRole("button", { name: "Revoke" })).not.toBeVisible();
  });

  test("clicking a PIN row opens its detail dialog, and editing the label saves", async ({ page }) => {
    await signIn(page);
    await page.getByText("PINs", { exact: true }).click();

    const label = `E2E Detail ${Date.now()}`;
    await page.locator("#new-pin-label").fill(label);
    await page.locator("#new-pin-code").fill("4446");
    await page.getByRole("button", { name: "Add PIN" }).click();
    await expect(page.getByText("PIN added. Active immediately.")).toBeVisible();

    const row = page.getByRole("row").filter({ hasText: label });
    await row.click();
    await expect(page.getByRole("heading", { name: "Edit PIN" })).toBeVisible();

    const newLabel = `${label} (edited)`;
    await page.locator("#pin-detail-label").fill(newLabel);
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("heading", { name: "Edit PIN" })).not.toBeVisible();
    await expect(page.getByRole("row").filter({ hasText: newLabel })).toBeVisible();
  });

  test("rejects a PIN shorter than 4 digits", async ({ page }) => {
    await signIn(page);
    await page.getByText("PINs", { exact: true }).click();
    await page.locator("#new-pin-label").fill("Too short");
    await page.locator("#new-pin-code").fill("12");
    await page.getByRole("button", { name: "Add PIN" }).click();
    await expect(page.getByText("PIN must be exactly 4 digits.")).toBeVisible();
  });

  test("PINs screen defaults to showing only Active PINs, not Revoked ones", async ({ page, request }) => {
    const label = `E2E Default Filter ${Date.now()}`;
    await request.post("/api/admin/pins", {
      headers: { "x-admin-token": ADMIN_TOKEN },
      data: { label, pin: "9012", isDuress: false },
    });
    const created = await (await request.get("/api/admin/pins", { headers: { "x-admin-token": ADMIN_TOKEN } })).json();
    const createdPin = (created.pins as { id: number; label: string }[]).find((p) => p.label === label)!;
    await request.delete(`/api/admin/pins?id=${createdPin.id}`, { headers: { "x-admin-token": ADMIN_TOKEN } });

    await signIn(page);
    await page.getByText("PINs", { exact: true }).click();

    // No status param at all — the plain landing view.
    await expect(page).not.toHaveURL(/[?&]status=/);
    await expect(page.getByRole("button", { name: "Active", exact: true })).toHaveClass(/bg-primary/);
    await expect(page.getByRole("row").filter({ hasText: label })).toHaveCount(0);
    await expect(page.getByRole("row").filter({ hasText: "Active" }).first()).toBeVisible();

    await page.getByRole("button", { name: "All", exact: true }).click();
    await expect(page.getByRole("row").filter({ hasText: label })).toBeVisible();
  });

  test("PINs table sorts, filters, and persists both through the URL and a reload", async ({ page }) => {
    await signIn(page);
    await page.getByText("PINs", { exact: true }).click();

    // Default: alphabetical by label, ascending — "E2E Duress" before "E2E Standard".
    await expect(page).toHaveURL(/\/admin\/pins$/);
    const labelCells = page.locator("table tbody tr td:first-child");
    const firstLabelIndex = (await labelCells.allTextContents()).findIndex((t) => t === "E2E Duress");
    const secondLabelIndex = (await labelCells.allTextContents()).findIndex((t) => t === "E2E Standard");
    expect(firstLabelIndex).toBeGreaterThanOrEqual(0);
    expect(firstLabelIndex).toBeLessThan(secondLabelIndex);

    // The arrow indicator is aria-hidden (decorative), so it's absent from
    // the accessible name Playwright matches on — assert it via rendered
    // text content instead.
    const labelHeader = page.getByRole("button", { name: "Label", exact: true });
    const createdHeader = page.getByRole("button", { name: "Created", exact: true });
    await expect(labelHeader).toContainText("↑");

    // Clicking the active sort column's header again reverses direction, in the URL too.
    await labelHeader.click();
    await expect(page).toHaveURL(/[?&]dir=desc/);
    await expect(labelHeader).toContainText("↓");

    // Clicking a different column switches to it, ascending, in the URL too.
    await createdHeader.click();
    await expect(page).toHaveURL(/[?&]sort=created/);
    await expect(page).not.toHaveURL(/[?&]dir=desc/);
    await expect(createdHeader).toContainText("↑");

    // Status filter narrows the table and lands in the URL.
    const label = `E2E Filter ${Date.now()}`;
    await page.locator("#new-pin-label").fill(label);
    await page.locator("#new-pin-code").fill("9871");
    await page.getByRole("button", { name: "Add PIN" }).click();
    const row = page.getByRole("row").filter({ hasText: label });
    await row.getByRole("button", { name: "Revoke" }).click();
    await page.getByRole("button", { name: "Revoke PIN" }).click();
    // Status defaults to Active now, so the row this just revoked drops out
    // of view until switching filters — same as the "adds a PIN" test above.
    await page.getByRole("button", { name: "Revoked", exact: true }).click();
    await expect(page).toHaveURL(/[?&]status=revoked/);
    await expect(page.getByRole("row").filter({ hasText: "Active" })).toHaveCount(0);
    await expect(row).toBeVisible();
    await expect(row.getByText("Revoked")).toBeVisible();

    // A reload lands on the exact same sort + filter, read back from the URL.
    await page.reload();
    await expect(page.getByRole("button", { name: "Created", exact: true })).toContainText("↑");
    await expect(page.getByRole("row").filter({ hasText: "Active" })).toHaveCount(0);
    await expect(row).toBeVisible();

    // "Clear filters" drops status/from/to from the URL and the table opens back up.
    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(page).not.toHaveURL(/[?&]status=/);
    await expect(page.getByRole("row").filter({ hasText: "Active" })).not.toHaveCount(0);
  });

  test("saves delay changes and they persist across a reload", async ({ page, request }) => {
    // This suite runs serially against one shared server/DB (see
    // playwright.config.ts), and every later test's arm/disarm assertions
    // assume the fast DEFAULT_EXIT_DELAY_SEC=2 restored at the end of this
    // test. If any assertion above the restore step throws — including a
    // one-off timing flake, not just a real bug — the test aborts before
    // restoring, leaving exitDelaySec=45 poisoning every subsequent test in
    // the run. The direct API call in `finally` guarantees the restore runs
    // regardless of what happened in the UI checks.
    try {
      await signIn(page);
      await page.getByText("Delays", { exact: true }).click();
      // Wait for the admin snapshot to populate the field before typing into
      // it: typing into a value the fetch is about to overwrite is a race the
      // UI now guards against (DelaysScreen's `dirty` flag), but the test
      // shouldn't be the thing proving that guard by accident — it showed up
      // in CI as a box reading "245".
      await expect(page.locator("#exit-delay")).not.toHaveValue("");
      await page.locator("#exit-delay").fill("45");
      await page.locator("#entry-delay").fill("20");
      await page.getByRole("button", { name: "Save delays" }).click();
      await expect(page.getByText("Saved. Applies from the next arming.")).toBeVisible();

      // The URL now carries the screen (/admin/delays), so a reload lands back
      // here directly instead of resetting to Overview.
      await page.reload();
      await expect(page.locator("#exit-delay")).toHaveValue("45");
      await expect(page.locator("#entry-delay")).toHaveValue("20");

      // Restore the fast delay the rest of the suite (panel.spec.ts) relies on.
      await page.locator("#exit-delay").fill("2");
      await page.locator("#entry-delay").fill("2");
      await page.getByRole("button", { name: "Save delays" }).click();
      await expect(page.getByText("Saved. Applies from the next arming.")).toBeVisible();
    } finally {
      await request.put("/api/admin/config", {
        headers: { "x-admin-token": ADMIN_TOKEN },
        data: { config: { exitDelaySec: 2, entryDelaySec: 2 } },
      });
    }
  });

  test("Settings screen saves rate-limit values and they persist across a reload", async ({ page, request }) => {
    // Same guaranteed-restore reasoning as the Delays test above: later
    // tests (the panel lockout test) assume the default 5-attempt lockout.
    try {
      await signIn(page);
      await page.getByText("Settings", { exact: true }).click();
      await page.locator("#rate-limit-max-attempts").fill("3");
      await page.locator("#rate-limit-window-sec").fill("120");
      await page.locator("#rate-limit-lockout-sec").fill("90");
      // Every settings section has its own Save: use the one under Security.
      await page
        .getByRole("heading", { name: "Security" })
        .locator("..")
        .getByRole("button", { name: "Save", exact: true })
        .click();
      await expect(page.getByText("Security settings saved")).toBeVisible();

      await page.reload();
      await expect(page.locator("#rate-limit-max-attempts")).toHaveValue("3");
      await expect(page.locator("#rate-limit-window-sec")).toHaveValue("120");
      await expect(page.locator("#rate-limit-lockout-sec")).toHaveValue("90");
    } finally {
      await request.put("/api/admin/config", {
        headers: { "x-admin-token": ADMIN_TOKEN },
        data: { config: { rateLimitMaxAttempts: 5, rateLimitWindowSec: 300, rateLimitLockoutSec: 300 } },
      });
    }
  });

  test("Settings screen's Test mode switch persists across a reload and is not listed under Advanced", async ({
    page,
    request,
  }) => {
    try {
      await signIn(page);
      await page.getByText("Settings", { exact: true }).click();
      await page.getByRole("switch", { name: "Test mode" }).click();
      await expect(page.getByText("Test mode on. Kiosk siren muted.")).toBeVisible();
      expect((await (await request.get("/api/status")).json()).testMode).toBe(true);

      await page.reload();
      await expect(page.getByRole("switch", { name: "Test mode" })).toBeChecked();
      await expect(page.locator("#advanced-config-panelTestMode")).toHaveCount(0);
    } finally {
      await request.put("/api/admin/config", {
        headers: { "x-admin-token": ADMIN_TOKEN },
        data: { config: { panelTestMode: "false" } },
      });
    }
  });

  test("Settings screen's Advanced section adds a new config key, editable afterward", async ({ page }) => {
    const key = `e2eAdvancedKey${Date.now()}`;
    await signIn(page);
    await page.getByText("Settings", { exact: true }).click();

    await page.locator("#new-config-key").fill(key);
    await page.locator("#new-config-value").fill("first-value");
    await page.getByRole("button", { name: "Add key" }).click();
    await expect(page.getByText(`Added ${key}`)).toBeVisible();

    const row = page.locator(`#advanced-config-${key}`);
    await expect(row).toHaveValue("first-value");

    await row.fill("second-value");
    await row.locator("xpath=..").getByRole("button", { name: "Save", exact: true }).click();

    // The URL carries the screen (/admin/settings), so a reload lands back
    // here directly, same as the Delays persistence test above.
    await page.reload();
    await expect(page.locator(`#advanced-config-${key}`)).toHaveValue("second-value");
  });

  test("Overview's 'Last armed / disarmed' card reflects a real event, even with 50+ unrelated audit rows since", async ({
    page,
    request,
  }) => {
    // Previously derived from the general, capped last-50-events list, which
    // this deliberately floods past to prove the fix (a dedicated, uncapped
    // query — see getLastArmDisarmEvent) rather than reintroducing the bug.
    await request.post("/api/panel/arm");
    await request.post("/api/disarm", { data: { pin: STANDARD_PIN } });
    const unifiId = `e2e-overview-noise-${Date.now()}`;
    for (let i = 0; i < 55; i++) {
      await request.post(`/api/hooks/sensor?token=e2e-webhook-secret`, {
        data: { sensorId: unifiId, eventType: "open" },
      });
    }

    await signIn(page);
    const lastArmCard = page.locator("div.border-border").filter({ hasText: "Last armed / disarmed" });
    await expect(lastArmCard).toContainText(/Armed|Disarmed/);
    await expect(lastArmCard.getByText("No arm/disarm events yet")).toHaveCount(0);
  });

  // Deliberately placed after the Settings tests above: this configures
  // sensorOpenEventTypes/sensorClosedEventTypes, which then shows up as two
  // extra rows (each with their own "Save" button) in the Settings screen's
  // Advanced config table — the earlier rate-limit test's `getByRole("button",
  // { name: "Save", exact: true })` relies on "Save" being unique on that
  // screen, and running this test before it broke that.
  test("Overview's 'Open right now' card reflects real door-sensor state once tracking is configured", async ({
    page,
    request,
  }) => {
    const doorId = `e2e-overview-door-${Date.now()}`;
    try {
      await request.put("/api/admin/config", {
        headers: { "x-admin-token": ADMIN_TOKEN },
        data: { config: { sensorOpenEventTypes: "e2e-overview-open", sensorClosedEventTypes: "e2e-overview-close" } },
      });
      await request.put("/api/admin/config", {
        headers: { "x-admin-token": ADMIN_TOKEN },
        data: { sensors: [{ unifiId: doorId, mode: "instant", sensorType: "door" }] },
      });
      await request.post(`/api/hooks/sensor?token=e2e-webhook-secret`, {
        data: { sensorId: doorId, eventType: "e2e-overview-open" },
      });

      await signIn(page);
      const openCard = page.locator("div.border-border").filter({ hasText: "Open right now" });
      await expect(openCard.getByText(doorId, { exact: false })).toBeVisible();
      await expect(openCard.getByText("Live sensor state isn't tracked yet", { exact: false })).toHaveCount(0);

      await request.post(`/api/hooks/sensor?token=e2e-webhook-secret`, {
        data: { sensorId: doorId, eventType: "e2e-overview-close" },
      });
      await page.reload();
      const openCardAfterClose = page.locator("div.border-border").filter({ hasText: "Open right now" });
      await expect(openCardAfterClose.getByText(doorId, { exact: false })).toHaveCount(0);
      await expect(openCardAfterClose.getByText("closed", { exact: false })).toBeVisible();
    } finally {
      // Same guaranteed-restore reasoning as the Delays/Settings tests: this
      // suite runs serially against one shared DB. An open door sensor blocks
      // every later arm, and leaving sensorOpenEventTypes set means any later
      // test posting a matching eventType silently marks its sensor open. Both
      // must be undone even if an assertion above throws. Clearing the keys to
      // "" is how they're disabled — they're opt-in and falsy-means-off.
      await request.delete(`/api/admin/config?unifiId=${doorId}`, { headers: { "x-admin-token": ADMIN_TOKEN } });
      await request.put("/api/admin/config", {
        headers: { "x-admin-token": ADMIN_TOKEN },
        data: { config: { sensorOpenEventTypes: "", sensorClosedEventTypes: "" } },
      });
    }
  });

  test("changes a sensor's mode, camera ID, and RTSPS URL, and it persists", async ({ page, request }) => {
    // Sensors self-register on their first webhook event — trip one directly
    // via the real webhook endpoint rather than hand-inserting a DB row.
    const unifiId = `e2e-sensor-${Date.now()}`;
    const webhookRes = await request.post(`/api/hooks/sensor?token=e2e-webhook-secret`, {
      data: { sensorId: unifiId, eventType: "open" },
    });
    expect(webhookRes.ok()).toBeTruthy();

    await signIn(page);
    await page.getByText("Sensors", { exact: true }).click();
    // The list row (role="button") also renders its mode as a sibling text
    // node, so its accessible name is "<unifiId> <mode>", never an exact
    // match for unifiId alone — scope by role and match by substring instead.
    await page.getByRole("button").filter({ hasText: unifiId }).click();

    // The radio input itself is visually hidden (sr-only) — the label is the
    // real click target, same as a user tapping the row.
    await page.locator("label").filter({ hasText: "Instant" }).click();
    await page.locator("#sensor-camera").fill("CAM-E2E-1");
    await page.locator("#sensor-rtsp").fill("rtsps://192.168.1.1:7441/e2e-test?enableSrtp");
    await page.getByRole("button", { name: "Save sensor" }).click();
    await expect(page.getByText("Saved just now")).toBeVisible();

    // The URL now carries the screen (/admin/sensors), so a reload lands back
    // here directly instead of resetting to Overview.
    await page.reload();
    await page.getByRole("button").filter({ hasText: unifiId }).click();
    await expect(page.locator("#sensor-camera")).toHaveValue("CAM-E2E-1");
    await expect(page.locator("#sensor-rtsp")).toHaveValue("rtsps://192.168.1.1:7441/e2e-test?enableSrtp");
  });

  test("the detail pane's trip history lists this sensor's own recent events, most recent first", async ({
    page,
    request,
  }) => {
    const unifiId = `e2e-trip-history-${Date.now()}`;
    // Three distinct trips, sequential and awaited so they land in a known
    // order — a fourth sensor's trip in between proves the list is actually
    // filtered to this sensor, not just "recent audit rows in general".
    await request.post(`/api/hooks/sensor?token=e2e-webhook-secret`, {
      data: { sensorId: unifiId, eventType: "open" },
    });
    await request.post(`/api/hooks/sensor?token=e2e-webhook-secret`, {
      data: { sensorId: `${unifiId}-other`, eventType: "open" },
    });
    await request.post(`/api/hooks/sensor?token=e2e-webhook-secret`, {
      data: { sensorId: unifiId, eventType: "open" },
    });

    await signIn(page);
    await page.getByText("Sensors", { exact: true }).click();
    await page.getByRole("button").filter({ hasText: unifiId }).first().click();

    const history = page.locator("#sensor-trip-history");
    const rows = history.locator("> div > div");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText(`Sensor '${unifiId}' tripped while disarmed`);
    await expect(rows.nth(1)).toContainText(`Sensor '${unifiId}' tripped while disarmed`);
    // Not the other sensor's own trip in between.
    await expect(history).not.toContainText(`${unifiId}-other`);
  });

  test("sets a sensor's event type and it persists, reflected in the sidebar list", async ({ page, request }) => {
    const unifiId = `e2e-type-sensor-${Date.now()}`;
    const webhookRes = await request.post(`/api/hooks/sensor?token=e2e-webhook-secret`, {
      data: { sensorId: unifiId, eventType: "open" },
    });
    expect(webhookRes.ok()).toBeTruthy();

    await signIn(page);
    await page.getByText("Sensors", { exact: true }).click();
    const row = page.getByRole("button").filter({ hasText: unifiId });
    await row.click();

    await expect(page.locator("#sensor-type")).toHaveValue("");
    await page.locator("#sensor-type").selectOption("door");
    await page.getByRole("button", { name: "Save sensor" }).click();
    await expect(page.getByText("Saved just now")).toBeVisible();
    await expect(row).toContainText("door");

    await page.reload();
    await page.getByRole("button").filter({ hasText: unifiId }).click();
    await expect(page.locator("#sensor-type")).toHaveValue("door");
  });

  test("the sidebar health dot is green for a sensor tripping at its own normal rate", async ({ page, request }) => {
    const unifiId = `e2e-health-sensor-${Date.now()}`;
    await request.post(`/api/hooks/sensor?token=e2e-webhook-secret`, {
      data: { sensorId: unifiId, eventType: "open" },
    });

    await signIn(page);
    await page.getByText("Sensors", { exact: true }).click();
    const row = page.getByRole("button").filter({ hasText: unifiId });
    await expect(row.locator("span[title*='Last tripped']")).toHaveClass(/bg-success/);
  });

  test("a trip arriving while the Sensors screen is open updates its date without a manual refresh", async ({
    page,
    request,
  }) => {
    const unifiId = `e2e-live-refresh-${Date.now()}`;
    await request.post(`/api/hooks/sensor?token=e2e-webhook-secret`, {
      data: { sensorId: unifiId, eventType: "open" },
    });

    await signIn(page);
    await page.getByText("Sensors", { exact: true }).click();
    const row = page.getByRole("button").filter({ hasText: unifiId });
    const firstTrip = (await row.innerText()).split("\n").pop()!;

    // Nobody touches the page — the trip has to reach it on its own, which is
    // the whole reason the list polls (see the Sensors poll in
    // app/admin/[[...screen]]/page.tsx).
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await request.post(`/api/hooks/sensor?token=e2e-webhook-secret`, {
      data: { sensorId: unifiId, eventType: "open" },
    });
    await expect(row).not.toContainText(firstTrip, { timeout: 25_000 });
  });

  test("the sidebar health dot is grey, not red, for a sensor that has never tripped", async ({ page, request }) => {
    // Registers via the config PUT route (not a webhook trip), so it has no
    // trip history at all. Grey, not red: with no baseline there is nothing
    // to judge it against, and claiming "broken" would be a guess (see
    // sensorHealth in app/admin/shared.ts).
    const unifiId = `e2e-nohistory-sensor-${Date.now()}`;
    await request.put("/api/admin/config", {
      headers: { "x-admin-token": ADMIN_TOKEN },
      data: { sensors: [{ unifiId, mode: "instant" }] },
    });

    await signIn(page);
    await page.getByText("Sensors", { exact: true }).click();
    const row = page.getByRole("button").filter({ hasText: unifiId });
    await expect(row.locator("span[title*='Last tripped']")).toHaveClass(/bg-muted-foreground/);
  });

  test("only shows the camera feed for a self-mapped camera sensor, not a physical sensor with a manually attached camera", async ({
    page,
    request,
  }) => {
    const unifiId = `e2e-nofeed-sensor-${Date.now()}`;
    await request.post(`/api/hooks/sensor?token=e2e-webhook-secret`, {
      data: { sensorId: unifiId, eventType: "open" },
    });

    await signIn(page);
    await page.getByText("Sensors", { exact: true }).click();
    await page.getByRole("button").filter({ hasText: unifiId }).click();
    await expect(page.getByText("No Protect camera mapped")).toHaveCount(0);

    // Manually attaching a camera to this physical sensor still shouldn't
    // surface a feed — only a sensor that IS a camera (cameraId === its own
    // unifiId) gets one, per the "Camera" badge distinction above.
    await page.locator("#sensor-camera").fill("CAM-E2E-NOFEED");
    await page.getByRole("button", { name: "Save sensor" }).click();
    await expect(page.getByText("Saved just now")).toBeVisible();
    await expect(page.getByText("No Protect camera mapped")).toHaveCount(0);
    await expect(page.getByText("CAM-E2E-NOFEED", { exact: false })).toHaveCount(0);
  });

  test("a camera-sourced trigger self-maps its own camera ID and shows the Camera badge, distinct from a physical sensor", async ({
    page,
    request,
  }) => {
    // cameraTriggerEventTypes is opt-in and config-mapped, same as
    // webhookSensorIdPath/webhookEventTypePath — off by default, so this
    // test turns it on explicitly rather than relying on any default.
    const configRes = await request.put("/api/admin/config", {
      headers: { "x-admin-token": ADMIN_TOKEN },
      data: { config: { cameraTriggerEventTypes: "motion" } },
    });
    expect(configRes.ok()).toBeTruthy();

    const cameraUnifiId = `e2e-camera-${Date.now()}`;
    const sensorUnifiId = `e2e-physical-${Date.now()}`;
    await request.post(`/api/hooks/sensor?token=e2e-webhook-secret`, {
      data: { sensorId: cameraUnifiId, eventType: "motion" },
    });
    await request.post(`/api/hooks/sensor?token=e2e-webhook-secret`, {
      data: { sensorId: sensorUnifiId, eventType: "open" },
    });

    await signIn(page);
    await page.getByText("Sensors", { exact: true }).click();

    const cameraRow = page.getByRole("button").filter({ hasText: cameraUnifiId });
    await expect(cameraRow.getByText("Camera", { exact: true })).toBeVisible();
    const sensorRow = page.getByRole("button").filter({ hasText: sensorUnifiId });
    await expect(sensorRow.getByText("Camera", { exact: true })).toHaveCount(0);

    await cameraRow.click();
    await expect(page.locator("#sensor-camera")).toHaveValue(cameraUnifiId);
    await expect(
      page.getByText("its snapshot or live feed above is wired to itself automatically", { exact: false }),
    ).toBeVisible();
    await expect(page.getByText("Last tripped", { exact: false })).toBeVisible();
  });

  test("shows a loading spinner in the camera feed while switching between two camera sensors", async ({
    page,
    request,
  }) => {
    await request.put("/api/admin/config", {
      headers: { "x-admin-token": ADMIN_TOKEN },
      data: { config: { cameraTriggerEventTypes: "motion" } },
    });
    const camA = `e2e-loader-cam-a-${Date.now()}`;
    const camB = `e2e-loader-cam-b-${Date.now()}`;
    await request.post(`/api/hooks/sensor?token=e2e-webhook-secret`, { data: { sensorId: camA, eventType: "motion" } });
    await request.post(`/api/hooks/sensor?token=e2e-webhook-secret`, { data: { sensorId: camB, eventType: "motion" } });

    await signIn(page);
    await page.getByText("Sensors", { exact: true }).click();
    await page.getByRole("button").filter({ hasText: camA }).click();
    await expect(page.locator("#sensor-camera")).toHaveValue(camA);

    // Slow the camera-feed fetch down so the transient loading state is
    // actually observable — real-server responses in this e2e environment
    // (no Protect backend configured) 404 almost instantly otherwise.
    await page.route("**/api/admin/cameras/**", async (route) => {
      await new Promise((r) => setTimeout(r, 600));
      await route.continue();
    });

    await page.getByRole("button").filter({ hasText: camB }).click();
    await expect(page.locator("svg.animate-spin")).toBeVisible();
    await expect(page.locator("svg.animate-spin")).toBeHidden({ timeout: 5_000 });
  });

  test("selecting a sensor puts its id at the end of the URL, and a reload lands on that same sensor", async ({
    page,
    request,
  }) => {
    const unifiId = `e2e-url-sensor-${Date.now()}`;
    await request.post(`/api/hooks/sensor?token=e2e-webhook-secret`, {
      data: { sensorId: unifiId, eventType: "open" },
    });

    await signIn(page);
    await page.getByText("Sensors", { exact: true }).click();
    await page.getByRole("button").filter({ hasText: unifiId }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/sensors/${unifiId}$`));

    // The URL alone determines the selection now — no need to click the row again.
    await page.reload();
    await expect(page.getByRole("heading", { level: 2, name: unifiId })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/admin/sensors/${unifiId}$`));
  });

  test("Refresh picks up a sensor that self-registered while the screen was already open", async ({
    page,
    request,
  }) => {
    await signIn(page);
    // Opening Sensors reloads the whole admin snapshot a few milliseconds after the click. Wait for it:
    // a webhook posted inside that window is already in the reloaded list, and the "not there yet"
    // check below would fail.
    const snapshotReloaded = page.waitForResponse(
      (r) => r.url().endsWith("/api/admin/config") && r.request().method() === "GET",
    );
    await page.getByText("Sensors", { exact: true }).click();
    await snapshotReloaded;

    // Trip a brand-new sensor's first webhook event only *after* the Sensors
    // screen is already open — it won't appear until a refresh, since the
    // list came from the admin snapshot fetched on login.
    const unifiId = `e2e-refresh-sensor-${Date.now()}`;
    const webhookRes = await request.post(`/api/hooks/sensor?token=e2e-webhook-secret`, {
      data: { sensorId: unifiId, eventType: "open" },
    });
    expect(webhookRes.ok()).toBeTruthy();
    await expect(page.getByRole("button").filter({ hasText: unifiId })).toHaveCount(0);

    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.getByRole("button").filter({ hasText: unifiId })).toBeVisible();
  });

  test("deletes a sensor", async ({ page, request }) => {
    const unifiId = `e2e-delete-sensor-${Date.now()}`;
    const webhookRes = await request.post(`/api/hooks/sensor?token=e2e-webhook-secret`, {
      data: { sensorId: unifiId, eventType: "open" },
    });
    expect(webhookRes.ok()).toBeTruthy();

    await signIn(page);
    await page.getByText("Sensors", { exact: true }).click();
    await page.getByRole("button").filter({ hasText: unifiId }).click();

    await page.getByRole("button", { name: "Delete sensor" }).click();
    await expect(page.getByRole("heading", { name: `Delete "${unifiId}"?` })).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("heading", { name: `Delete "${unifiId}"?` })).not.toBeVisible();

    await page.getByRole("main").getByRole("button", { name: "Delete sensor" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete sensor" }).click();
    await expect(page.getByRole("button").filter({ hasText: unifiId })).toHaveCount(0);
  });

  test("the audit log filter chips narrow the visible rows", async ({ page }) => {
    await signIn(page);
    await page.getByText("Audit log", { exact: true }).click();
    await expect(page.getByRole("heading", { name: "Audit log" })).toBeVisible();
    // The heading is purely route-driven and appears instantly, but the
    // audit rows come from the admin snapshot fetched once on login — poll
    // instead of a one-shot count so a slow fetch doesn't read the table
    // before it's populated.
    await expect.poll(() => page.getByRole("row").count()).toBeGreaterThan(1); // header row + at least one event
    const allCount = await page.getByRole("row").count();

    // Scoped to <main> — the sidebar nav also has a "PINs" item.
    await page.locator("main").getByRole("button", { name: "PINs", exact: true }).click();
    const pinsCount = await page.getByRole("row").count();
    expect(pinsCount).toBeLessThanOrEqual(allCount);
    expect(pinsCount).toBeGreaterThan(0);
  });

  test("downloads the audit log as CSV (most recent 200), with raw detail beyond the humanized summary", async ({
    page,
  }) => {
    // Trip a sensor first so there's a row with real detail (sensorId) to
    // verify in the export, not just plain events.
    await page.request.post("/api/hooks/sensor?token=e2e-webhook-secret", {
      data: { sensorId: "e2e-csv-check", eventType: "open" },
    });

    await signIn(page);
    await page.getByText("Audit log", { exact: true }).click();
    await expect(page.getByRole("heading", { name: "Audit log" })).toBeVisible();
    await expect.poll(() => page.getByRole("row").count()).toBeGreaterThan(1);

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Download CSV" }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^audit-log-\d{4}-\d{2}-\d{2}\.csv$/);

    const csvPath = await download.path();
    const csv = readFileSync(csvPath, "utf8");
    // Starts with a UTF-8 BOM so Excel on Windows reads accented names correctly.
    expect(csv.split("\r\n")[0]).toBe("\uFEFFid,timestamp,actor,event,category,description,detail_json");
    // The raw detail (e.g. sensorId) must survive into the export — that's
    // the whole point, beyond what the UI's humanized one-liner shows.
    expect(csv).toContain("e2e-csv-check");
  });

  test("Audit log paginates at 100 events, with Older/Newer navigation", async ({ page, request }) => {
    // Generate enough events to guarantee a second page (100/page) —
    // trip an ignore-mode sensor's webhook repeatedly, cheaper than any UI
    // flow, and it doesn't affect anything else in the suite.
    const unifiId = `e2e-pagination-sensor-${Date.now()}`;
    for (let i = 0; i < 105; i++) {
      await request.post("/api/hooks/sensor?token=e2e-webhook-secret", {
        data: { sensorId: unifiId, eventType: "open" },
      });
    }

    await signIn(page);
    await page.getByText("Audit log", { exact: true }).click();
    await expect(page.getByText("Page 1")).toBeVisible();

    const olderBtn = page.getByRole("button", { name: "Older →" });
    const newerBtn = page.getByRole("button", { name: "← Newer" });
    await expect(olderBtn).toBeEnabled();
    await expect(newerBtn).toBeDisabled();

    await expect.poll(() => page.getByRole("row").count()).toBe(101); // header + 100 events

    await olderBtn.click();
    await expect(page.getByText("Page 2")).toBeVisible();
    await expect(newerBtn).toBeEnabled();

    await newerBtn.click();
    await expect(page.getByText("Page 1")).toBeVisible();
    await expect(newerBtn).toBeDisabled();
  });

  test("header arm button arms with no PIN; disarm still requires the right PIN", async ({ page }) => {
    await signIn(page);
    await expect(page.getByText("Disarmed", { exact: true })).toBeVisible();

    // Arming from the admin UI is gated by the admin token alone — see
    // app/api/admin/arm/route.ts — so the click arms directly, no dialog.
    await page.getByRole("button", { name: "Arm system" }).click();
    await expect(page.getByText("Armed", { exact: true })).toBeVisible({ timeout: 8_000 });

    // Disarming stays the actual security boundary: still PIN-gated.
    await page.getByRole("button", { name: "Disarm", exact: true }).click();
    const disarmDialog = page.getByRole("alertdialog");
    await disarmDialog.locator("#arm-pin").fill("0000");
    await disarmDialog.getByRole("button", { name: "Disarm", exact: true }).click();
    await expect(page.getByText("Incorrect PIN.")).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("heading", { name: "Disarm the system" })).not.toBeVisible();

    await page.getByRole("button", { name: "Disarm", exact: true }).click();
    await disarmDialog.locator("#arm-pin").fill(STANDARD_PIN);
    await disarmDialog.getByRole("button", { name: "Disarm", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Disarm the system" })).not.toBeVisible();
    await expect(page.getByText("Disarmed", { exact: true })).toBeVisible();
  });

  test("header arm button blocks arming while a gating door sensor is open, and 'Arm anyway' overrides it", async ({
    page,
    request,
  }) => {
    const doorId = `e2e-arm-gate-door-${Date.now()}`;
    try {
      // sensorOpenEventTypes/sensorClosedEventTypes are opt-in and config-mapped,
      // same precedent as cameraTriggerEventTypes — a distinct eventType value
      // (not the "open"/"close" other specs use) so this doesn't reclassify any
      // other test's sensor state.
      const configRes = await request.put("/api/admin/config", {
        headers: { "x-admin-token": ADMIN_TOKEN },
        data: { config: { sensorOpenEventTypes: "e2e-door-open", sensorClosedEventTypes: "e2e-door-close" } },
      });
      expect(configRes.ok()).toBeTruthy();

      await request.put("/api/admin/config", {
        headers: { "x-admin-token": ADMIN_TOKEN },
        data: { sensors: [{ unifiId: doorId, mode: "instant", sensorType: "door" }] },
      });
      const webhookRes = await request.post(`/api/hooks/sensor?token=e2e-webhook-secret`, {
        data: { sensorId: doorId, eventType: "e2e-door-open" },
      });
      expect(webhookRes.ok()).toBeTruthy();

      await signIn(page);
      await expect(page.getByText("Disarmed", { exact: true })).toBeVisible();

      await page.getByRole("button", { name: "Arm system" }).click();
      // Scoped to the dialog: the Overview screen's own "Open right now" card
      // shows this same open door (and its id) at the same time — a
      // page-wide getByText(doorId) matches both and is a strict-mode
      // violation.
      const armConfirmDialog = page.getByRole("alertdialog");
      await expect(armConfirmDialog.getByText(doorId, { exact: false })).toBeVisible();
      await expect(page.getByText("Disarmed", { exact: true })).toBeVisible(); // still disarmed — blocked, not armed

      await armConfirmDialog.getByRole("button", { name: "Arm anyway", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Door open. Arm anyway?" })).not.toBeVisible();
      await expect(page.getByText("Armed", { exact: true })).toBeVisible({ timeout: 8_000 });

      // Restore the disarmed baseline for the tests after this one.
      await page.getByRole("button", { name: "Disarm", exact: true }).click();
      const disarmDialog = page.getByRole("alertdialog");
      await disarmDialog.locator("#arm-pin").fill(STANDARD_PIN);
      await disarmDialog.getByRole("button", { name: "Disarm", exact: true }).click();
      await expect(page.getByText("Disarmed", { exact: true })).toBeVisible();
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

  test("the header ARMING countdown ticks down every second, not just every ~2s poll", async ({ page, request }) => {
    // The default e2e exitDelaySec (2, see playwright.config.ts) is too
    // short to sample three 1s-apart points against — same restore
    // discipline as the "saves delay changes" test above: a try/finally so
    // a failed assertion still can't strand the rest of the suite on a slow
    // exit delay.
    try {
      await request.put("/api/admin/config", {
        headers: { "x-admin-token": ADMIN_TOKEN },
        data: { config: { exitDelaySec: 15 } },
      });

      await signIn(page);
      await expect(page.getByText("Disarmed", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Arm system" }).click();

      const pill = page.locator("header").getByText(/Arming · \d+s/);
      const readSecondsLeft = async () => {
        const text = await pill.textContent();
        return Number(text?.match(/(\d+)s/)?.[1]);
      };

      // Dense sampling over several seconds rather than a couple of rigid
      // 1s-apart reads: the local 1s tick (useDisplayRemainingSec in
      // AppShell.tsx) and the ~2s server poll are two independent timers, so
      // a fixed sample offset can legitimately straddle a poll right when it
      // lands, occasionally showing 0 change or a 2-step drop between two
      // adjacent samples even with the fix working correctly — a short
      // sample run measured this landing right at the edge of a 2-drop
      // minimum on a couple of runs. Ten samples 600ms apart (~5.4s, well
      // under the 15s exit delay above) give plenty of margin either way.
      // The pill renders "Arming · 0s" until the first status poll lands
      // with the real remainingSec; sampling that 0 reads as a backward tick.
      await expect(pill).toHaveText(/Arming · [1-9]\d*s/);
      const seconds: number[] = [];
      for (let i = 0; i < 10; i++) {
        seconds.push(await readSecondsLeft());
        await page.waitForTimeout(600);
      }

      // Never ticks backward.
      for (let i = 1; i < seconds.length; i++) {
        expect(seconds[i]).toBeLessThanOrEqual(seconds[i - 1]);
      }
      // Under the old bug (remainingSec only moved on the ~2s poll), samples
      // 600ms apart would almost always read identical, with an occasional
      // 2-step drop right on a poll — essentially never several clean
      // 1-step drops. The fix's per-second local tick should produce more
      // than that could plausibly manage.
      const singleStepDrops = seconds.slice(1).filter((v, i) => seconds[i] - v === 1).length;
      expect(singleStepDrops).toBeGreaterThanOrEqual(3);

      await expect(page.getByText("Armed", { exact: true })).toBeVisible({ timeout: 18_000 });

      // Restore the disarmed baseline for the tests after this one.
      await page.getByRole("button", { name: "Disarm", exact: true }).click();
      const disarmDialog = page.getByRole("alertdialog");
      await disarmDialog.locator("#arm-pin").fill(STANDARD_PIN);
      await disarmDialog.getByRole("button", { name: "Disarm", exact: true }).click();
      await expect(page.getByText("Disarmed", { exact: true })).toBeVisible();
    } finally {
      await request.put("/api/admin/config", {
        headers: { "x-admin-token": ADMIN_TOKEN },
        data: { config: { exitDelaySec: 2 } },
      });
    }
  });

  test("the duress tooltip opens on keyboard focus and closes on Escape", async ({ page }) => {
    await signIn(page);
    await page.getByText("PINs", { exact: true }).click();
    const trigger = page.getByRole("button", { name: "What is a duress PIN?" });
    await page.locator("#new-pin-code").focus();
    for (let i = 0; i < 6 && !(await trigger.evaluate((el) => el === document.activeElement)); i++)
      await page.keyboard.press("Tab");
    await expect(trigger).toBeFocused();
    const tip = page.getByText(/^Disarms normally/);
    await expect(tip).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(tip).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test("the duress toggle: role, name, keyboard, saved value and audit entry (add form and edit dialog)", async ({
    page,
    request,
  }) => {
    await signIn(page);
    await page.getByText("PINs", { exact: true }).click();

    const toggle = page.getByRole("switch");
    await expect(toggle).toHaveCount(1);
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(toggle).toHaveAccessibleName("Duress PIN");

    await toggle.click();
    await expect(toggle).toBeChecked();
    await toggle.focus();
    await page.keyboard.press("Space");
    await expect(toggle).not.toBeChecked();
    await page.keyboard.press("Enter");
    await expect(toggle).toBeChecked();

    const label = `E2E Duress toggle ${Date.now()}`;
    await page.locator("#new-pin-label").fill(label);
    await page.locator("#new-pin-code").fill("4447");
    await page.getByRole("button", { name: "Add PIN" }).click();
    await expect(page.getByText("PIN added. Active immediately.")).toBeVisible();

    const headers = { "x-admin-token": ADMIN_TOKEN };
    const pins = (await (await request.get("/api/admin/pins", { headers })).json()) as {
      pins: Array<{ label: string; isDuress: boolean }>;
    };
    expect(pins.pins.find((p) => p.label === label)?.isDuress).toBe(true);
    const audit = (await (await request.get("/api/admin/audit", { headers })).json()) as {
      audit: Array<{ event: string; detail: unknown }>;
    };
    // A duress PIN's audit entry carries the same fields as a standard PIN's: nothing marks it.
    expect(
      audit.audit.find((e) => e.event === "pin_created" && JSON.stringify(e.detail).includes(label))?.detail,
    ).toEqual({ label });

    // Edit dialog: the toggle starts from the saved value and saves a change.
    await page.getByRole("row").filter({ hasText: label }).click();
    const dialog = page.getByRole("dialog");
    const editToggle = dialog.getByRole("switch");
    await expect(editToggle).toBeChecked();
    await expect(editToggle).toHaveAccessibleName("Duress PIN");
    await editToggle.click();
    await expect(editToggle).not.toBeChecked();
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("heading", { name: "Edit PIN" })).not.toBeVisible();
    const after = (await (await request.get("/api/admin/pins", { headers })).json()) as {
      pins: Array<{ label: string; isDuress: boolean }>;
    };
    expect(after.pins.find((p) => p.label === label)?.isDuress).toBe(false);
  });

  test("dialogs: focus moves in on open, Escape closes, focus returns to the trigger", async ({ page, request }) => {
    const label = `E2E Dialog focus ${Date.now()}`;
    await request.post("/api/admin/pins", {
      headers: { "x-admin-token": ADMIN_TOKEN },
      data: { label, pin: "4448", isDuress: false },
    });
    await signIn(page);
    await page.getByText("PINs", { exact: true }).click();

    const revoke = page.getByRole("row").filter({ hasText: label }).getByRole("button", { name: "Revoke" });
    await revoke.focus();
    // Enter on the Revoke button opens only the Revoke dialog, not Edit PIN as well.
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toHaveCount(1);
    await expect(page.getByRole("heading", { name: `Revoke "${label}"?` })).toBeVisible();
    await expect(dialog.locator(":focus")).toHaveCount(1);
    await page.keyboard.press("Tab");
    await expect(dialog.locator(":focus")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(revoke).toBeFocused();

    // Disarm dialog (header button): same contract.
    await page.getByRole("button", { name: "Arm system" }).click();
    const disarm = page.getByRole("button", { name: "Disarm" });
    await expect(disarm).toBeVisible();
    await disarm.focus();
    await page.keyboard.press("Enter");
    await expect(dialog).toBeVisible();
    await expect(dialog.locator(":focus")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(disarm).toBeFocused();
    await request.post("/api/disarm", { data: { pin: STANDARD_PIN } });
  });

  test("PINs table: a row is a tab stop and Enter on it opens Edit PIN; headers sort from the keyboard", async ({
    page,
    request,
  }) => {
    const label = `E2E Row keyboard ${Date.now()}`;
    await request.post("/api/admin/pins", {
      headers: { "x-admin-token": ADMIN_TOKEN },
      data: { label, pin: "4449", isDuress: false },
    });
    await signIn(page);
    await page.getByText("PINs", { exact: true }).click();

    const row = page.getByRole("row").filter({ hasText: label });
    await row.focus();
    await expect(row).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "Edit PIN" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("heading", { name: "Edit PIN" })).not.toBeVisible();

    const typeHeader = page.getByRole("columnheader", { name: "Type" }).getByRole("button");
    await typeHeader.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/sort=type/);
    await expect(page.getByRole("columnheader", { name: /Type/ })).toContainText("↑");
  });

  test("confirm dialogs are alert dialogs: described, closed by Escape and Cancel, not by a click outside", async ({
    page,
    request,
  }) => {
    const label = `E2E Alert dialog ${Date.now()}`;
    await request.post("/api/admin/pins", {
      headers: { "x-admin-token": ADMIN_TOKEN },
      data: { label, pin: "4450", isDuress: false },
    });
    await signIn(page);
    await page.getByText("PINs", { exact: true }).click();
    const revoke = page.getByRole("row").filter({ hasText: label }).getByRole("button", { name: "Revoke" });

    await revoke.click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAccessibleName(`Revoke "${label}"?`);
    await expect(dialog).toHaveAccessibleDescription(/It stops working immediately/);

    // A click on the backdrop does not dismiss it.
    await page.mouse.click(5, 5);
    await expect(dialog).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await revoke.click();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("row").filter({ hasText: label }).getByText("Active")).toBeVisible();
  });

  test("forms: every control is reachable by its label, in order, and validation errors are announced", async ({
    page,
  }) => {
    await signIn(page);

    await page.getByText("Delays", { exact: true }).click();
    await expect(page.getByLabel("Exit delay · seconds")).toBeVisible();
    await expect(page.getByLabel("Entry delay · seconds")).toBeVisible();
    await expect(page.getByLabel("Exit delay · seconds")).toHaveAccessibleDescription(/Time to leave after arming/);

    await page.getByText("Settings", { exact: true }).click();
    for (const name of ["Max attempts", "Window · seconds", "Lockout · seconds", "Key", "Value"]) {
      await expect(page.getByLabel(name, { exact: true })).toBeVisible();
    }

    await page.getByText("PINs", { exact: true }).click();
    // Tab order through the add form: label, PIN, duress switch.
    await page.getByLabel("Label", { exact: true }).focus();
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("PIN · 4 digits")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("switch", { name: "Duress PIN" })).toBeFocused();

    // A validation error is announced as an alert.
    await page.getByRole("button", { name: "Add PIN" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Give the PIN a label." })).toBeVisible();
  });

  test("Events lists an incident from a sensor trip while armed, expands it, and shows it resolved after the disarm", async ({
    page,
    request,
  }) => {
    const unifiId = `e2e-events-${Date.now()}`;
    const hook = "/api/hooks/sensor?token=e2e-webhook-secret";
    // Register the sensor while disarmed, then arm and trip it.
    expect((await request.post(hook, { data: { sensorId: unifiId, eventType: "open" } })).ok()).toBeTruthy();
    await request.post("/api/panel/arm");
    await expect
      .poll(async () => (await (await request.get("/api/status")).json()).state, { timeout: 10_000 })
      .toBe("ARMED");
    expect((await request.post(hook, { data: { sensorId: unifiId, eventType: "open" } })).ok()).toBeTruthy();
    await expect
      .poll(async () => (await (await request.get("/api/status")).json()).state, { timeout: 10_000 })
      .toMatch(/ENTRY_DELAY|ALARM/);
    await request.post("/api/disarm", { data: { pin: STANDARD_PIN } });

    await signIn(page);
    await page.getByText("Events", { exact: true }).click();
    await expect(page.getByRole("heading", { name: "Events" })).toBeVisible();
    const row = page.getByRole("button").filter({ hasText: unifiId });
    await expect(row).toBeVisible();
    await expect(row).toContainText("resolved");
    await row.click();
    await expect(page.getByText(`${unifiId}: 1 trip`)).toBeVisible();
    await expect(page.getByText("No camera mapped to this sensor.").first()).toBeVisible();
  });

  test("Log out returns to the sign-in screen and a reload stays signed out", async ({ page }) => {
    await signIn(page);
    await page.getByRole("button", { name: "Log out" }).click();
    await expect(page.locator("#admin-token")).toBeVisible();
    await expect(page.getByText("Signed in via admin token")).toHaveCount(0);
    await page.reload();
    await expect(page.locator("#admin-token")).toBeVisible();
  });

  test("the sidebar navigates from the keyboard (Enter and Space), marks the current page, and collapses", async ({
    page,
  }) => {
    await signIn(page);
    const nav = page.getByRole("navigation", { name: "Admin screens" });
    await expect(nav.getByRole("button", { name: "Overview" })).toHaveAttribute("aria-current", "page");

    await nav.getByRole("button", { name: "Delays" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "Delays" })).toBeVisible();
    await expect(nav.getByRole("button", { name: "Delays" })).toHaveAttribute("aria-current", "page");
    await expect(nav.getByRole("button", { name: "Overview" })).not.toHaveAttribute("aria-current", "page");

    await nav.getByRole("button", { name: "Tasks" }).focus();
    await page.keyboard.press("Space");
    await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible();

    // Collapse to icons: still reachable by name, and a screen change still works.
    await page.getByRole("button", { name: "Toggle Sidebar" }).click();
    await expect(page.locator('[data-slot="sidebar"][data-state="collapsed"]')).toBeVisible();
    await nav.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  });

  test("on a phone the sidebar is a drawer that opens from the header and navigates", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await signIn(page);
    await expect(page.getByRole("navigation", { name: "Admin screens" })).toBeHidden();
    await page.getByRole("button", { name: "Toggle Sidebar" }).click();
    const nav = page.getByRole("navigation", { name: "Admin screens" });
    await expect(nav).toBeVisible();
    await nav.getByRole("button", { name: "PINs" }).click();
    await expect(page.getByRole("heading", { name: "PINs" })).toBeVisible();
  });

  test("PINs table: every column header has a name", async ({ page }) => {
    await signIn(page);
    await page.getByText("PINs", { exact: true }).click();
    await expect(page.getByRole("columnheader")).toHaveCount(5);
    await expect(page.getByRole("columnheader", { name: "Actions" })).toHaveCount(1);
  });
});

import { expect, test, type Page } from "@playwright/test";
import { ADMIN_TOKEN } from "./constants";

/**
 * Installed before any page script runs (addInitScript), so it catches a
 * violation regardless of which script on the page would have triggered it
 * — this is the same event the real browser fires when proxy.ts's CSP
 * (see that file) blocks something, not a mock of it.
 */
async function collectCspViolations(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    (window as unknown as { __cspViolations: string[] }).__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      (window as unknown as { __cspViolations: string[] }).__cspViolations.push(`${e.violatedDirective}: ${e.blockedURI}`);
    });
  });
  return () => page.evaluate(() => (window as unknown as { __cspViolations: string[] }).__cspViolations);
}

test.describe("Content-Security-Policy", () => {
  test("zero violations across /, /panel, and a logged-in /admin session", async ({ page }) => {
    const getViolations = await collectCspViolations(page);

    await page.goto("/");
    await page.goto("/panel");

    await page.goto("/admin");
    await page.locator("#admin-token").fill(ADMIN_TOKEN);
    await page.getByRole("button", { name: "Enter" }).click();
    await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();

    for (const screen of ["Sensors", "PINs", "Delays", "Audit log", "Events", "Tasks", "Settings"]) {
      await page.getByText(screen, { exact: true }).click();
    }

    expect(await getViolations()).toEqual([]);
  });
});

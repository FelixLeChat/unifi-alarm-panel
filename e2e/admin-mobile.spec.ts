import { expect, test, type Page } from "@playwright/test";
import { ADMIN_TOKEN } from "./constants";

// The admin UI is used from a phone when an alarm fires: no screen may scroll sideways,
// and every control has to sit inside the viewport.
test.use({ viewport: { width: 390, height: 844 } });

const SCREENS = ["Sensors", "PINs", "Delays", "Audit log", "Events", "Tasks", "Settings"];

async function offscreen(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const doc = document.documentElement;
    if (doc.scrollWidth > doc.clientWidth) out.push(`page scrolls sideways (${doc.scrollWidth} > ${doc.clientWidth})`);
    for (const el of document.querySelectorAll<HTMLElement>("main *, header *, button, a, input")) {
      // A box that scrolls on its own (a table, the heatmap) may be wider than the screen.
      let scrolls = false;
      for (let p = el.parentElement; p; p = p.parentElement)
        if (["auto", "scroll"].includes(getComputedStyle(p).overflowX)) scrolls = true;
      if (scrolls) continue;
      if (el.closest("[aria-hidden=true], .sr-only")) continue;
      const r = el.getBoundingClientRect();
      if (r.width && r.right > window.innerWidth + 1)
        out.push(`${el.tagName} "${(el.textContent ?? "").trim().slice(0, 30)}" ends at ${Math.round(r.right)}`);
    }
    return out;
  });
}

test("no admin screen overflows at phone width", async ({ page }) => {
  await page.goto("/admin");
  await page.locator("#admin-token").fill(ADMIN_TOKEN);
  await page.getByRole("button", { name: "Enter" }).click();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Arm system" })).toBeInViewport({ ratio: 1 });
  expect(await offscreen(page), "Overview").toEqual([]);

  for (const label of SCREENS) {
    await page.getByRole("button", { name: "Toggle Sidebar" }).first().click();
    await page.getByRole("navigation", { name: "Admin screens" }).getByText(label, { exact: true }).click();
    await expect(page.getByRole("heading", { name: label })).toBeVisible();
    await page.waitForTimeout(300);
    expect(await offscreen(page), label).toEqual([]);
  }
});

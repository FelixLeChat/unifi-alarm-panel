import { expect, test } from "@playwright/test";
import { ADMIN_TOKEN } from "./constants";

test.describe("brand assets", () => {
  test("declares an icon and a manifest, and every file loads", async ({ page, request }) => {
    await page.goto("/admin");
    const hrefs = await page
      .locator("head link[rel~='icon'], head link[rel='manifest']")
      .evaluateAll((els) => els.map((el) => el.getAttribute("href")));
    expect(hrefs.some((h) => h?.split("?")[0] === "/icon.svg")).toBe(true);
    const apple = await page.locator("head link[rel='apple-touch-icon']").getAttribute("href");
    expect(apple?.split("?")[0]).toBe("/apple-touch-icon.png");
    hrefs.push(apple);
    expect(hrefs).toContain("/site.webmanifest");

    for (const href of hrefs) {
      const res = await request.get(href!);
      expect(res.status(), href!).toBe(200);
    }
    const manifest = await (await request.get("/site.webmanifest")).json();
    expect(manifest.name).toBe("UniFi Alarm Panel");
    expect(manifest.icons.map((i: { sizes: string }) => i.sizes)).toEqual(
      expect.arrayContaining(["192x192", "512x512"]),
    );
    for (const icon of manifest.icons) expect((await request.get(icon.src)).status(), icon.src).toBe(200);
  });

  test("the wordmark is named and at least 80px wide on the login screen and in the sidebar", async ({ page }) => {
    await page.goto("/admin");
    const login = await page.getByRole("img", { name: "UniFi Alarm Panel" }).first().boundingBox();
    expect(login?.width ?? 0).toBeGreaterThanOrEqual(80);

    await page.locator("#admin-token").fill(ADMIN_TOKEN);
    await page.getByRole("button", { name: "Enter" }).click();
    await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
    const sidebar = await page.getByRole("img", { name: "UniFi Alarm Panel" }).first().boundingBox();
    expect(sidebar?.width ?? 0).toBeGreaterThanOrEqual(80);
  });
});

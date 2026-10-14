/**
 * Renders the PNG app icons from public/app-icon.svg: the iOS home-screen
 * icon and the two web-manifest sizes. Run after changing the mark:
 *
 *   pnpm exec tsx scripts/render-icons.mts
 */
import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const svg = readFileSync("public/app-icon.svg", "utf8");
const browser = await chromium.launch();
for (const [size, file] of [
  [180, "public/apple-touch-icon.png"],
  [192, "public/icon-192.png"],
  [512, "public/icon-512.png"],
] as const) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<style>html,body{margin:0}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
  await page.screenshot({ path: file, omitBackground: true });
  await page.close();
}
await browser.close();

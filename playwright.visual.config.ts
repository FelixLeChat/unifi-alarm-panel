import { defineConfig, type PlaywrightTestConfig } from "@playwright/test";
import base from "./playwright.config";

// Screenshot baseline for UI migrations (see CONTRIBUTING.md, "Visual baseline").
// Same server, env and fresh DB as the e2e suite; only the spec dir, the
// snapshot location and the output dir differ. Baselines stay out of git
// (they depend on the OS and font stack): create them on the commit you are
// about to change, then compare after the change.
const server = base.webServer as Extract<PlaywrightTestConfig["webServer"], { command: string }>;

export default defineConfig({
  ...base,
  testDir: "./e2e/visual",
  testIgnore: [],
  snapshotPathTemplate: "visual-baseline/{arg}{ext}",
  outputDir: "test-results-visual",
  expect: { toHaveScreenshot: { animations: "disabled", maxDiffPixels: 200, threshold: 0 } },
  reporter: "list",
  // The repo's own .env may carry real weather coordinates; blank them so the
  // panel's forecast strip is the same on every run (and offline).
  webServer: {
    ...server,
    env: { ...server.env, PANEL_WEATHER_LAT: "", PANEL_WEATHER_LON: "" },
  },
});

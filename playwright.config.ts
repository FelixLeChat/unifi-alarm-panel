import { defineConfig, devices } from "@playwright/test";

const PORT = 3177;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  // The screenshot walk needs a local baseline: it runs through playwright.visual.config.ts, not here.
  testIgnore: "**/visual/**",
  globalSetup: "./e2e/global-setup.ts",
  // This app is a single-process, single-state-machine system by design
  // (see CLAUDE.md: single instance, one process) — the
  // e2e suite exercises that same one shared armed/disarmed state through a
  // real server, so tests can't run concurrently against it without racing
  // each other's arm/disarm transitions. Serial execution mirrors reality.
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // Fresh DB every run, against a real production build (`next start`) —
    // avoids Turbopack dev mode's first-compile latency making the first
    // test of each route flaky under a tight timeout. This is deliberately
    // NOT `node .next/standalone/server.js` (what deploy/build.sh actually
    // ships): `next build`'s `output: "standalone"` warns that `next start`
    // "does not work with" it, but in practice it still serves everything
    // correctly here — it just runs the regular (non-trimmed) server rather
    // than the standalone one, which is a packaging concern, not a UI/API
    // one. This suite tests the app; deploy/build.sh's own gotchas (see its
    // comments) are a separate, lower-churn thing
    // to verify by hand or in a dedicated deploy smoke test if that ever
    // becomes worth automating.
    command: "rm -f ./data/e2e-test.db* && pnpm build && pnpm start",
    url: `${BASE_URL}/api/health`,
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
    env: {
      NEXT_TELEMETRY_DISABLED: "1",
      PORT: String(PORT),
      DATABASE_PATH: "./data/e2e-test.db",
      ADMIN_TOKEN: "e2e-admin-token",
      WEBHOOK_SHARED_SECRET: "e2e-webhook-secret",
      DEFAULT_EXIT_DELAY_SEC: "2",
      DEFAULT_ENTRY_DELAY_SEC: "2",
      PANEL_AUDIO_ENABLED: "false",
      // Never the live GitHub API. The hourly update check would find this repo's real releases (the
      // app reports itself as "dev"), show the header's "update available" button next to the Tasks
      // one, and make tests that look for "Update requested" depend on when that check finishes.
      // A repo that doesn't exist gives the same answer the check got while this repo was private.
      UPDATE_CHECK_REPO: "e2e/no-such-repo",
      // No UniFi console in this environment: blanked explicitly so the
      // repo's own .env (a real host) can't leak in and make the device
      // health poll sit on an unreachable address during the run.
      PROTECT_HOST: "",
      PROTECT_ADMIN_USERNAME: "",
      PROTECT_ADMIN_PASSWORD: "",
      // A configured-but-unreachable console (port 9 refuses at once), seeded
      // into the fresh DB on first boot, so the admin opens on Overview
      // instead of the first-run wizard. e2e/settings.spec.ts clears it to
      // walk the wizard itself.
      SECRETS_KEY: "ZTJlLXNlY3JldHMta2V5LTMyLWJ5dGVzLWxvbmchISE=", // gitleaks:allow (test-only key: "e2e-secrets-key-32-bytes-long!!!")
      PROTECT_API_BASE_URL: "http://127.0.0.1:9",
      PROTECT_API_KEY: "e2e-api-key",
      PANEL_QUIET_HOURS_START: "0",
      PANEL_QUIET_HOURS_END: "0",
    },
  },
});

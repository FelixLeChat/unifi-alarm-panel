/**
 * Regenerates the README screenshots in docs/screenshots/ against a throwaway
 * instance with demo data (fake names, fake PINs, the fake console from
 * scripts/mock-protect-server.ts). Needs internet for the kiosk weather strip
 * (Open-Meteo).
 *
 *   rm -f data/shot.db*
 *   pnpm protect:mock &     # the setup wizard's "Test connection" runs against it
 *   docker run --rm -d --name shot-go2rtc -p 127.0.0.1:1984:1984 alexxit/go2rtc   # so the go2rtc check passes too
 *   pnpm build
 *   echo v1.2.0 > VERSION   # the panel footer shows it; "dev" otherwise (delete the file after)
 *   PORT=3188 DATABASE_PATH=./data/shot.db ADMIN_TOKEN=t WEBHOOK_SHARED_SECRET=s \
 *     SECRETS_KEY=$(openssl rand -base64 32) DEFAULT_EXIT_DELAY_SEC=60 pnpm start &
 *   pnpm exec tsx scripts/screenshots.mts
 */
import { chromium } from "@playwright/test";

const BASE = process.env.SHOT_BASE ?? "http://localhost:3188";
const TOKEN = process.env.SHOT_ADMIN_TOKEN ?? "t";
const SECRET = process.env.SHOT_WEBHOOK_SECRET ?? "s";
const OUT = "docs/screenshots";
const MOCK_CONSOLE = process.env.SHOT_MOCK_CONSOLE ?? "http://localhost:8089";

const admin = (method: string, path: string, body?: unknown) =>
  fetch(BASE + path, { method, headers: { "x-admin-token": TOKEN, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
const hook = (sensorId: string, eventType: string) =>
  fetch(`${BASE}/api/hooks/sensor?token=${SECRET}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sensorId, eventType }) });
const post = (path: string, body: unknown = {}) =>
  fetch(BASE + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

await admin("PUT", "/api/admin/config", {
  config: { sensorOpenEventTypes: "open", sensorClosedEventTypes: "close" },
  sensors: [
    { unifiId: "front", name: "Front Door", mode: "delayed", sensorType: "door" },
    { unifiId: "back", name: "Back Door", mode: "delayed", sensorType: "door" },
    { unifiId: "hall", name: "Hallway Motion", mode: "delayed", sensorType: "motion" },
    { unifiId: "lab", name: "Lab Motion", mode: "instant", sensorType: "motion" },
  ],
});
const browser = await chromium.launch();

// First run: no console yet, so /admin opens the setup wizard. Fill the console step and test it.
const wizard = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await wizard.goto(`${BASE}/admin`);
await wizard.locator("#admin-token").fill(TOKEN);
await wizard.getByRole("button", { name: "Enter" }).click();
await wizard.getByRole("button", { name: "Continue" }).click();
await wizard.getByLabel("Console URL").fill(MOCK_CONSOLE);
await wizard.getByLabel("Protect API key").fill("demo-key");
await wizard.getByRole("button", { name: "Test connection" }).click();
await wizard.getByText("Protect Integration API").waitFor();
await sleep(1000);
await wizard.screenshot({ path: `${OUT}/admin-setup-wizard.png`, fullPage: true });
await wizard.close();

// From here on the console is configured, so the admin opens on Overview.
await admin("PUT", "/api/admin/settings", {
  group: "console",
  values: { protectApiBaseUrl: MOCK_CONSOLE, protectApiKey: "demo-key" },
});
await admin("PUT", "/api/admin/settings", {
  group: "panel",
  // Weather is live from Open-Meteo, so this needs internet; any city works.
  values: {
    audioEnabled: "false",
    quietHoursStart: "0",
    quietHoursEnd: "0",
    helpText: "Problem? Call Sam at 555-0100",
    weatherLat: "45.50",
    weatherLon: "-73.57",
  },
});
await admin("POST", "/api/admin/pins", { label: "Alex Martin", pin: "1234", isDuress: false });
await admin("POST", "/api/admin/pins", { label: "Sam Lee", pin: "5678", isDuress: false });
await hook("front", "close");
await hook("back", "close");

const panel = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const shot = async (page: typeof panel, name: string) => {
  await sleep(2500);
  await page.screenshot({ path: `${OUT}/${name}.png` });
};

// Disarmed, with the welcome message from a PIN disarm.
await panel.goto(`${BASE}/panel`);
await post("/api/panel/arm");
await sleep(500);
await post("/api/disarm", { pin: "1234" });
await shot(panel, "panel-disarmed");

// Exit delay with a door left open.
await post("/api/panel/arm");
await sleep(500);
await hook("front", "open");
await shot(panel, "panel-arming");

// Entry delay: shorten the exit delay so it reaches ARMED, then open a door.
await post("/api/disarm", { pin: "1234" });
await hook("front", "close");
await admin("PUT", "/api/admin/config", { config: { exitDelaySec: 3 } });
await post("/api/panel/arm");
await sleep(4500);
await hook("back", "open");
await shot(panel, "panel-entry-delay");
await post("/api/disarm", { pin: "5678" });
await hook("back", "close");

// Admin screens.
const adminPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await adminPage.goto(`${BASE}/admin`);
await adminPage.locator("#admin-token").fill(TOKEN);
await adminPage.getByRole("button", { name: "Enter" }).click();
await adminPage.getByRole("heading", { name: "Overview" }).waitFor();
for (const [label, file] of [["Sensors", "admin-sensors"], ["Settings", "admin-settings"]] as const) {
  await adminPage.getByText(label, { exact: true }).click();
  await shot(adminPage, file);
}

// Settings > Notifications: ntfy without Duress. Fake endpoints, never called.
await admin("PUT", "/api/admin/settings", {
  group: "notifications",
  values: {
    ntfyUrl: "https://ntfy.example.com",
    ntfyTopic: "office-alarm",
    ntfyAlertKinds: "ALARM,HEALTH",
    signalApiUrl: "http://signal-cli:8080",
    signalNumber: "+15145550100",
    signalRecipients: "+15145550101",
  },
});
await adminPage.reload();
await adminPage.getByRole("heading", { name: "Notifications" }).waitFor();
await adminPage.getByRole("heading", { name: "ntfy", exact: true }).scrollIntoViewIfNeeded();
await sleep(500);
await adminPage.getByRole("heading", { name: "ntfy", exact: true }).locator("xpath=../..").screenshot({ path: `${OUT}/admin-notifications.png` });

await browser.close();

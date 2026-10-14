/**
 * Regenerates the README screenshots in docs/screenshots/ against a throwaway
 * instance with demo data (fake names, fake PINs, no UniFi console).
 *
 *   rm -f data/shot.db*
 *   pnpm build
 *   echo v1.1.0 > VERSION   # the panel footer shows it; "dev" otherwise (delete the file after)
 *   PORT=3188 DATABASE_PATH=./data/shot.db ADMIN_TOKEN=t WEBHOOK_SHARED_SECRET=s \
 *     SECRETS_KEY=$(openssl rand -base64 32) DEFAULT_EXIT_DELAY_SEC=60 pnpm start &
 *   pnpm exec tsx scripts/screenshots.mts
 */
import { chromium } from "@playwright/test";

const BASE = process.env.SHOT_BASE ?? "http://localhost:3188";
const TOKEN = process.env.SHOT_ADMIN_TOKEN ?? "t";
const SECRET = process.env.SHOT_WEBHOOK_SECRET ?? "s";
const OUT = "docs/screenshots";

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
// A configured console (unreachable on purpose) so the admin opens on Overview, not the setup wizard.
await admin("PUT", "/api/admin/settings", {
  group: "console",
  values: { protectApiBaseUrl: "https://192.0.2.10", protectApiKey: "demo-key", protectDefaultCameraId: "cam-lobby" },
});
await admin("PUT", "/api/admin/settings", {
  group: "panel",
  values: { audioEnabled: "false", quietHoursStart: "0", quietHoursEnd: "0", helpText: "Problem? Call Sam at 555-0100" },
});
await admin("POST", "/api/admin/pins", { label: "Alex Martin", pin: "1234", isDuress: false });
await admin("POST", "/api/admin/pins", { label: "Sam Lee", pin: "5678", isDuress: false });
await hook("front", "close");
await hook("back", "close");

const browser = await chromium.launch();
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

await browser.close();

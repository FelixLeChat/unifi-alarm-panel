/**
 * Regenerates the README screenshots in docs/screenshots/ against a throwaway
 * instance with demo data (fake names, fake PINs, the fake console from
 * scripts/mock-protect-server.ts). Needs internet for the kiosk weather strip
 * (Open-Meteo), and ffmpeg for the GIFs.
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
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.SHOT_BASE ?? "http://localhost:3188";
const TOKEN = process.env.SHOT_ADMIN_TOKEN ?? "t";
const SECRET = process.env.SHOT_WEBHOOK_SECRET ?? "s";
const OUT = "docs/screenshots";
const DB_PATH = process.env.SHOT_DB ?? "./data/shot.db";
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

// The console is configured here (the setup wizard is not screenshotted), so the admin opens on Overview.
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
await admin("POST", "/api/admin/pins", { label: "Jordan Rivera", pin: "2468", isDuress: false });
await admin("POST", "/api/admin/pins", { label: "Front desk (duress)", pin: "1357", isDuress: true });

// Six months of weekday arm/disarm history for the Overview heatmap. The audit table is
// append-only but takes an explicit timestamp, so this writes straight into the demo database.
{
  const db = new Database(DB_PATH);
  const insert = db.prepare("INSERT INTO audit (ts, actor_label, event, detail_json) VALUES (?, ?, ?, ?)");
  let seed = 7;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const at = (daysAgo: number, hour: number, minute: number) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - daysAgo);
    d.setUTCHours(hour, minute, Math.floor(rand() * 60), 0);
    return d.toISOString();
  };
  for (let daysAgo = 1; daysAgo <= 170; daysAgo++) {
    const day = new Date(Date.now() - daysAgo * 86_400_000).getUTCDay();
    const weekend = day === 0 || day === 6;
    if (weekend && rand() > 0.08) continue;
    if (!weekend && rand() < 0.06) continue;
    const who = ["Alex Martin", "Sam Lee", "Jordan Rivera"][Math.floor(rand() * 3)];
    insert.run(at(daysAgo, 12, 40 + Math.floor(rand() * 30)), who, "disarmed", JSON.stringify({ from: "ARMED" }));
    insert.run(at(daysAgo, 21, 30 + Math.floor(rand() * 40)), null, "armed", null);
  }
  db.close();
}
await hook("front", "close");
await hook("back", "close");

const panel = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const shot = async (page: typeof panel, name: string, clip?: { x: number; y: number; width: number; height: number }) => {
  await sleep(2500);
  await page.screenshot({ path: `${OUT}/${name}.png`, clip });
};

// Disarmed, with the welcome message from a PIN disarm.
await panel.goto(`${BASE}/panel`);
await post("/api/panel/arm");
await sleep(500);
await post("/api/disarm", { pin: "1234" });
await shot(panel, "panel-disarmed");

// Exit delay with a door left open (the door check shows it under the countdown).
await post("/api/panel/arm");
await sleep(500);
await hook("front", "open");
await shot(panel, "panel-door-open");

// Armed: shorten the exit delay so it settles, then show the armed panel.
await post("/api/disarm", { pin: "1234" });
await hook("front", "close");
await admin("PUT", "/api/admin/config", { config: { exitDelaySec: 3 } });
await post("/api/panel/arm");
await sleep(4500);
await shot(panel, "panel-armed");
await post("/api/disarm", { pin: "1234" });

// Short GIFs of the three moments a still can't show: arming, an entry delay and an alarm.
// Needs ffmpeg. Delays are 8s so each countdown reads on screen.
await admin("PUT", "/api/admin/config", { config: { exitDelaySec: 8, entryDelaySec: 8 } });
const record = async (name: string, run: (page: typeof panel) => Promise<void>) => {
  const dir = mkdtempSync(join(tmpdir(), "uap-rec-"));
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, recordVideo: { dir, size: { width: 1280, height: 800 } } });
  const page = await context.newPage();
  await page.goto(`${BASE}/panel`);
  await sleep(1500);
  await run(page);
  const video = page.video()!;
  await context.close();
  execFileSync("ffmpeg", [
    "-y", "-loglevel", "error", "-ss", "0.6", "-i", await video.path(),
    "-vf", "fps=10,scale=800:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer:bayer_scale=4",
    `${OUT}/${name}.gif`,
  ]);
  rmSync(dir, { recursive: true, force: true });
};
const tapPin = async (page: typeof panel, pin: string) => {
  for (const digit of pin) {
    await page.locator(`[data-digit="${digit}"]`).click();
    await sleep(300);
  }
};

await record("panel-arming", async (page) => {
  await page.locator("#action-btn").click();
  await sleep(700);
  await page.locator("#arm-confirm-yes").click({ timeout: 3000 }).catch(() => {});
  await sleep(12_500);
});
await record("panel-entry-delay", async (page) => {
  await sleep(300);
  await hook("back", "open");
  await sleep(3500);
  await hook("back", "close");
  await sleep(500);
  await tapPin(page, "5678");
  await sleep(2500);
});
await post("/api/panel/arm");
await sleep(9500);
await record("panel-alarm", async (page) => {
  await sleep(300);
  await hook("lab", "motion");
  await sleep(5000);
  await tapPin(page, "1234");
  await sleep(2500);
});

// Admin screens.
const adminPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await adminPage.goto(`${BASE}/admin`);
await adminPage.locator("#admin-token").fill(TOKEN);
await adminPage.getByRole("button", { name: "Enter" }).click();
await adminPage.getByRole("heading", { name: "Overview" }).waitFor();
await shot(adminPage, "admin-overview", { x: 0, y: 0, width: 1440, height: 480 });
for (const [label, file, clip] of [
  ["Sensors", "admin-sensors", undefined],
  ["PINs", "admin-pins", { x: 0, y: 0, width: 1440, height: 700 }],
  ["Audit log", "admin-audit-log", undefined],
] as const) {
  await adminPage.getByText(label, { exact: true }).click();
  await shot(adminPage, file, clip && { ...clip });
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
await adminPage.goto(`${BASE}/admin/settings`);
await adminPage.getByRole("heading", { name: "Notifications" }).waitFor();
await adminPage.getByRole("heading", { name: "ntfy", exact: true }).scrollIntoViewIfNeeded();
await sleep(500);
await adminPage.getByRole("heading", { name: "ntfy", exact: true }).locator("xpath=../..").screenshot({ path: `${OUT}/admin-notifications.png` });

await browser.close();

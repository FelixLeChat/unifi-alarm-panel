import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, getDb } from "@/lib/db";
import { checkNotifications } from "../settings-check";
import { saveSettings, seedSettingsFromEnv, getSetting } from "../settings";
import { buildNotifier, getNotifier, NullNotifier, SlackChannel } from ".";

const originalKey = process.env.SECRETS_KEY;
const SLACK = "https://hooks.slack.example/x";
const NTFY = "https://ntfy.internal";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.DATABASE_PATH = ":memory:";
  process.env.SECRETS_KEY = Buffer.alloc(32, 7).toString("base64");
  closeDb();
  fetchMock = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  closeDb();
  vi.unstubAllGlobals();
  if (originalKey === undefined) delete process.env.SECRETS_KEY;
  else process.env.SECRETS_KEY = originalKey;
});

const sentTo = () => fetchMock.mock.calls.map((c) => String(c[0]));

describe("alert routing", () => {
  it("an install from before routing gets every kind on every configured channel", async () => {
    saveSettings("notifications", { slackWebhookUrl: SLACK, ntfyUrl: NTFY, ntfyTopic: "alarms" });
    const notifier = buildNotifier();

    for (const kind of ["ALARM", "DURESS", "HEALTH"] as const) await notifier.send({ kind, at: "now" });

    expect(sentTo().filter((u) => u === SLACK)).toHaveLength(3);
    expect(sentTo().filter((u) => u === `${NTFY}/alarms`)).toHaveLength(3);
  });

  it("sends each kind only to the channels it is routed to, DURESS included", async () => {
    saveSettings("notifications", {
      slackWebhookUrl: SLACK,
      ntfyUrl: NTFY,
      ntfyTopic: "alarms",
      slackAlertKinds: "ALARM,HEALTH",
      ntfyAlertKinds: "DURESS",
    });
    const notifier = buildNotifier();

    await notifier.send({ kind: "DURESS", at: "now" });
    expect(sentTo()).toEqual([`${NTFY}/alarms`]);

    fetchMock.mockClear();
    await notifier.send({ kind: "ALARM", at: "now" });
    await notifier.send({ kind: "HEALTH", message: "x", at: "now" });
    expect(sentTo()).toEqual([SLACK, SLACK]);
  });

  it("a channel with no kinds, or switched off, receives nothing", async () => {
    saveSettings("notifications", {
      slackWebhookUrl: SLACK,
      ntfyUrl: NTFY,
      ntfyTopic: "alarms",
      slackAlertKinds: "none",
      ntfyEnabled: "false",
    });
    const notifier = buildNotifier();

    for (const kind of ["ALARM", "DURESS", "HEALTH"] as const) await notifier.send({ kind, at: "now" });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rebuilds the notifier when routing is saved", () => {
    saveSettings("notifications", { slackWebhookUrl: SLACK });
    expect(getNotifier()).toBeInstanceOf(SlackChannel);
    saveSettings("notifications", { slackEnabled: "false" });
    expect(getNotifier()).toBeInstanceOf(NullNotifier);
    saveSettings("notifications", { slackEnabled: "true" });
    expect(getNotifier()).toBeInstanceOf(SlackChannel);
  });

  it("rejects an unknown alert kind", () => {
    expect(saveSettings("notifications", { slackAlertKinds: "ALARM,SIREN" }).ok).toBe(false);
    expect(saveSettings("notifications", { slackAlertKinds: "none" }).ok).toBe(true);
    expect(saveSettings("notifications", { slackEnabled: "maybe" }).ok).toBe(false);
  });
});

describe("per-channel test alert", () => {
  it("tests only the named channel, and skips one that isn't configured", async () => {
    saveSettings("notifications", { slackWebhookUrl: SLACK, ntfyUrl: NTFY, ntfyTopic: "alarms" });

    expect(await checkNotifications("ntfy")).toEqual([{ name: "ntfy", status: "ok", detail: "Test alert sent." }]);
    expect(sentTo()).toEqual([`${NTFY}/alarms`]);
    expect(await checkNotifications("telegram")).toEqual([
      expect.objectContaining({ name: "Telegram", status: "skipped" }),
    ]);
    expect(await checkNotifications()).toHaveLength(2);
  });

  it("still sends to a switched-off channel and says so", async () => {
    saveSettings("notifications", { slackWebhookUrl: SLACK, slackEnabled: "false" });

    const [result] = await checkNotifications("slack");

    expect(result.status).toBe("ok");
    expect(result.detail).toContain("switched off");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("env seeding for the new channels", () => {
  it("imports Telegram and Signal values on first boot, secrets encrypted", () => {
    const db = getDb();
    db.prepare("DELETE FROM settings").run();
    seedSettingsFromEnv(db, {
      TELEGRAM_BOT_TOKEN: "123:abc",
      TELEGRAM_CHAT_ID: "-1001",
      SIGNAL_API_URL: "http://signal-cli:8080",
      SIGNAL_NUMBER: "+15145550100",
      SIGNAL_RECIPIENTS: "+15145550101,group.abc",
    });

    expect(getSetting("telegramBotToken", db)).toBe("123:abc");
    expect(getSetting("telegramChatId", db)).toBe("-1001");
    expect(getSetting("signalRecipients", db)).toBe("+15145550101,group.abc");
    const stored = db.prepare("SELECT value, secret FROM settings WHERE key = 'telegramBotToken'").get() as {
      value: string;
      secret: number;
    };
    expect(stored.secret).toBe(1);
    expect(stored.value).not.toContain("123:abc");
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb } from "@/lib/db";
import { getNotifier, NullNotifier, SlackNotifier } from "./notifier";
import { getProtectClient, UnifiProtectClient } from "./protect-client";
import { saveSettings } from "./settings";

const originalKey = process.env.SECRETS_KEY;

beforeEach(() => {
  process.env.DATABASE_PATH = ":memory:";
  process.env.SECRETS_KEY = Buffer.alloc(32, 5).toString("base64");
  closeDb();
});

afterEach(() => {
  closeDb();
  if (originalKey === undefined) delete process.env.SECRETS_KEY;
  else process.env.SECRETS_KEY = originalKey;
});

// A save in the admin UI must reach long-lived clients without a restart.
describe("settings hot reload", () => {
  it("rebuilds the Protect client after a console save, and reuses it otherwise", () => {
    const before = getProtectClient();
    expect(getProtectClient()).toBe(before);
    saveSettings("console", { protectApiBaseUrl: "https://192.168.1.1", protectApiKey: "k" });
    const after = getProtectClient();
    expect(after).not.toBe(before);
    expect(after).toBeInstanceOf(UnifiProtectClient);
  });

  it("rebuilds the notifier after a notifications save", () => {
    expect(getNotifier()).toBeInstanceOf(NullNotifier);
    saveSettings("notifications", { slackWebhookUrl: "https://hooks.slack.example/x" });
    expect(getNotifier()).toBeInstanceOf(SlackNotifier);
    saveSettings("notifications", { slackWebhookUrl: null });
    expect(getNotifier()).toBeInstanceOf(NullNotifier);
  });
});

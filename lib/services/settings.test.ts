import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "@/lib/db";
import {
  describeSettings,
  getSetting,
  getSettingsRevision,
  isConsoleConfigured,
  saveSettings,
  seedSettingsFromEnv,
} from "./settings";

const KEY = Buffer.alloc(32, 7).toString("base64");
const PEM = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";

let db: Database.Database;
const originalKey = process.env.SECRETS_KEY;

beforeEach(() => {
  process.env.SECRETS_KEY = KEY;
  db = createDb(":memory:");
});

afterEach(() => {
  db.close();
  if (originalKey === undefined) delete process.env.SECRETS_KEY;
  else process.env.SECRETS_KEY = originalKey;
});

describe("saveSettings", () => {
  it("stores plain values and reads them back", () => {
    expect(saveSettings("console", { protectApiBaseUrl: "https://192.168.1.1", protectHost: "192.168.1.1" }, db)).toEqual({
      ok: true,
      changed: ["protectApiBaseUrl", "protectHost"],
    });
    expect(getSetting("protectApiBaseUrl", db)).toBe("https://192.168.1.1");
  });

  it("encrypts secrets at rest and decrypts them for server code", () => {
    saveSettings("notifications", { slackBotToken: "xoxb-real-token" }, db);
    const raw = db.prepare("SELECT value, secret FROM settings WHERE key = 'slackBotToken'").get() as { value: string; secret: number };
    expect(raw.secret).toBe(1);
    expect(raw.value).not.toContain("xoxb-real-token");
    expect(getSetting("slackBotToken", db)).toBe("xoxb-real-token");
  });

  it("never exposes a secret's value in the description, only whether it is set", () => {
    saveSettings("console", { protectApiKey: "api-key-123", protectApiBaseUrl: "https://console.local" }, db);
    const description = describeSettings("console", db);
    expect(JSON.stringify(description)).not.toContain("api-key-123");
    expect(description.secrets.protectApiKey).toEqual({ set: true, readable: true });
    expect(description.values.protectApiBaseUrl).toBe("https://console.local");
    expect(description.values).not.toHaveProperty("protectApiKey");
  });

  it('keeps a stored secret on "", clears it on null', () => {
    saveSettings("console", { protectApiKey: "k1" }, db);
    saveSettings("console", { protectApiKey: "" }, db);
    expect(getSetting("protectApiKey", db)).toBe("k1");
    saveSettings("console", { protectApiKey: null }, db);
    expect(getSetting("protectApiKey", db)).toBeNull();
  });

  it("clears a plain value on empty string", () => {
    saveSettings("panel", { helpText: "Call Sam" }, db);
    saveSettings("panel", { helpText: "" }, db);
    expect(getSetting("helpText", db)).toBeNull();
  });

  it("rejects invalid values and saves nothing from that request", () => {
    const result = saveSettings("panel", { helpText: "fine", weatherLat: "123" }, db);
    expect(result.ok).toBe(false);
    expect(getSetting("helpText", db)).toBeNull();
    expect(saveSettings("notifications", { alertTimezone: "Mars/Olympus" }, db).ok).toBe(false);
    expect(saveSettings("console", { protectApiBaseUrl: "ftp://x" }, db).ok).toBe(false);
    expect(saveSettings("console", { protectCaCert: "not a cert" }, db).ok).toBe(false);
    expect(saveSettings("panel", { quietHoursStart: "24" }, db).ok).toBe(false);
  });

  it("rejects a key from another group or an unknown key", () => {
    expect(saveSettings("panel", { slackBotToken: "x" }, db).ok).toBe(false);
    expect(saveSettings("panel", { nope: "x" }, db).ok).toBe(false);
  });

  it("refuses to store a secret without SECRETS_KEY", () => {
    delete process.env.SECRETS_KEY;
    const result = saveSettings("console", { protectApiKey: "k" }, db);
    expect(result.ok).toBe(false);
    expect(getSetting("protectApiKey", db)).toBeNull();
    // Plain values still save.
    expect(saveSettings("panel", { helpText: "hi" }, db).ok).toBe(true);
  });

  it("treats a secret as unset and unreadable when SECRETS_KEY changed", () => {
    saveSettings("console", { protectApiKey: "k" }, db);
    process.env.SECRETS_KEY = Buffer.alloc(32, 9).toString("base64");
    expect(getSetting("protectApiKey", db)).toBeNull();
    expect(describeSettings("console", db).secrets.protectApiKey).toEqual({ set: true, readable: false });
  });

  it("bumps the revision on every save that changes something", () => {
    const before = getSettingsRevision(db);
    saveSettings("panel", { helpText: "a" }, db);
    expect(getSettingsRevision(db)).toBe(before + 1);
    saveSettings("panel", {}, db);
    expect(getSettingsRevision(db)).toBe(before + 1);
  });

  it("knows when the console is configured", () => {
    expect(isConsoleConfigured(db)).toBe(false);
    saveSettings("console", { protectApiBaseUrl: "https://console.local", protectApiKey: "k" }, db);
    expect(isConsoleConfigured(db)).toBe(true);
  });
});

describe("seedSettingsFromEnv", () => {
  it("imports env values once, encrypting secrets", () => {
    const fresh = createDb(":memory:");
    fresh.prepare("DELETE FROM settings").run();
    seedSettingsFromEnv(fresh, { PROTECT_API_BASE_URL: "https://console.local", PROTECT_API_KEY: "env-key", ALERT_TIMEZONE: "UTC" });
    expect(getSetting("protectApiBaseUrl", fresh)).toBe("https://console.local");
    expect(getSetting("protectApiKey", fresh)).toBe("env-key");

    // Later env changes are ignored: the database is the source of truth now.
    saveSettings("console", { protectApiBaseUrl: "https://edited.local" }, fresh);
    seedSettingsFromEnv(fresh, { PROTECT_API_BASE_URL: "https://from-env.local" });
    expect(getSetting("protectApiBaseUrl", fresh)).toBe("https://edited.local");
    fresh.close();
  });

  it("skips invalid env values instead of failing boot", () => {
    const fresh = createDb(":memory:");
    fresh.prepare("DELETE FROM settings").run();
    seedSettingsFromEnv(fresh, { PANEL_WEATHER_LAT: "north", PANEL_WEATHER_LON: "-73.6" });
    expect(getSetting("weatherLat", fresh)).toBeNull();
    expect(getSetting("weatherLon", fresh)).toBe("-73.6");
    fresh.close();
  });

  it("reads PROTECT_CA_CERT from a file path", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "uap-ca-"));
    const file = path.join(dir, "ca.pem");
    writeFileSync(file, PEM);
    const fresh = createDb(":memory:");
    fresh.prepare("DELETE FROM settings").run();
    seedSettingsFromEnv(fresh, { PROTECT_CA_CERT: file });
    expect(getSetting("protectCaCert", fresh)).toBe(PEM);
    fresh.close();
  });

  it("retries secrets on a later boot when SECRETS_KEY was missing", () => {
    delete process.env.SECRETS_KEY;
    const fresh = createDb(":memory:");
    fresh.prepare("DELETE FROM settings").run();
    seedSettingsFromEnv(fresh, { PROTECT_API_KEY: "env-key", PROTECT_HOST: "192.168.1.1" });
    expect(getSetting("protectHost", fresh)).toBe("192.168.1.1");
    expect(fresh.prepare("SELECT 1 FROM settings WHERE key = 'protectApiKey'").get()).toBeUndefined();

    process.env.SECRETS_KEY = KEY;
    seedSettingsFromEnv(fresh, { PROTECT_API_KEY: "env-key", PROTECT_HOST: "192.168.1.1" });
    expect(getSetting("protectApiKey", fresh)).toBe("env-key");
    fresh.close();
  });
});

import { readFileSync } from "node:fs";
import type Database from "better-sqlite3";
import { getDb } from "@/lib/db";
import { logger } from "@/lib/logger";
import { ntfyFields } from "./notifiers/ntfy";
import { slackFields } from "./notifiers/slack";
import { decryptSecret, encryptSecret, secretsKeyStatus } from "./secrets";
import { bool, httpUrl, secret, SETTINGS_GROUPS, text, type FieldDef, type SettingsGroup } from "./setting-schemas";

export { SETTINGS_GROUPS, type SettingsGroup };

/**
 * Console, notification and panel settings, edited from the admin UI and
 * stored in the `settings` table. The database is the only source of truth:
 * environment variables are read once, on first boot, to seed it (see
 * seedSettingsFromEnv) and ignored afterwards.
 *
 * Secret fields are encrypted at rest (lib/services/secrets.ts), never
 * returned by any API, and read back only by the server code that uses them.
 *
 * Every save bumps a revision counter. Long-lived clients (the Protect
 * client, the notifier, the event stream) compare it on use and rebuild when
 * it moved, which is how a save takes effect without a restart, across
 * every Next bundle at once (see the bundle-isolation note in lib/db/index.ts).
 */

const numberIn = (min: number, max: number) =>
  text(32).refine((v) => Number.isFinite(Number(v)) && Number(v) >= min && Number(v) <= max, `must be a number between ${min} and ${max}`);
const hour = text(2).refine((v) => /^\d{1,2}$/.test(v) && Number(v) <= 23, "must be an hour from 0 to 23");
const timezone = text(64).refine((v) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: v });
    return true;
  } catch {
    return false;
  }
}, "must be an IANA timezone, like Europe/Paris or UTC");
const pem = text(20_000).refine((v) => v.includes("-----BEGIN CERTIFICATE-----"), "must be a PEM certificate");

export const SETTINGS = {
  protectApiBaseUrl: { group: "console", schema: httpUrl, env: "PROTECT_API_BASE_URL" },
  protectApiKey: { group: "console", schema: secret, env: "PROTECT_API_KEY", secret: true },
  protectHost: { group: "console", schema: text(255), env: "PROTECT_HOST" },
  protectAdminUsername: { group: "console", schema: text(255), env: "PROTECT_ADMIN_USERNAME" },
  protectAdminPassword: { group: "console", schema: secret, env: "PROTECT_ADMIN_PASSWORD", secret: true },
  protectCaCert: { group: "console", schema: pem, env: "PROTECT_CA_CERT" },
  protectInsecureTls: { group: "console", schema: bool, env: "PROTECT_INSECURE_TLS" },
  protectLiveViewUrlTemplate: { group: "console", schema: text(2000), env: "PROTECT_LIVE_VIEW_URL_TEMPLATE" },
  protectDefaultCameraId: { group: "console", schema: text(255), env: "PROTECT_DEFAULT_CAMERA_ID" },
  protectConsoleCamerasUrl: { group: "console", schema: httpUrl, env: "PROTECT_CONSOLE_CAMERAS_URL" },
  go2rtcApiBaseUrl: { group: "console", schema: httpUrl, env: "GO2RTC_API_BASE_URL" },

  alertTimezone: { group: "notifications", schema: timezone, env: "ALERT_TIMEZONE" },
  // Each notification channel declares its own fields (lib/services/notifiers/).
  ...slackFields,
  ...ntfyFields,

  weatherLat: { group: "panel", schema: numberIn(-90, 90), env: "PANEL_WEATHER_LAT" },
  weatherLon: { group: "panel", schema: numberIn(-180, 180), env: "PANEL_WEATHER_LON" },
  audioEnabled: { group: "panel", schema: bool, env: "PANEL_AUDIO_ENABLED" },
  quietHoursStart: { group: "panel", schema: hour, env: "PANEL_QUIET_HOURS_START" },
  quietHoursEnd: { group: "panel", schema: hour, env: "PANEL_QUIET_HOURS_END" },
  helpText: { group: "panel", schema: text(120) },
} satisfies Record<string, FieldDef>;

export type SettingKey = keyof typeof SETTINGS;

const REVISION_KEY = "_revision";
const SEEDED_KEY = "_seededFromEnv";

function field(key: SettingKey): FieldDef {
  return SETTINGS[key];
}

function readRow(db: Database.Database, key: string): { value: string; secret: number } | undefined {
  return db.prepare("SELECT value, secret FROM settings WHERE key = ?").get(key) as { value: string; secret: number } | undefined;
}

/** The setting's value, decrypted if secret. Null when unset, or when a secret can't be decrypted (missing or changed SECRETS_KEY). */
export function getSetting(key: SettingKey, db: Database.Database = getDb()): string | null {
  const row = readRow(db, key);
  if (!row) return null;
  return row.secret ? decryptSecret(key, row.value) : row.value;
}

export function getSettingsRevision(db: Database.Database = getDb()): number {
  return Number(readRow(db, REVISION_KEY)?.value ?? 0);
}

function bumpRevision(db: Database.Database): void {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1",
  ).run(REVISION_KEY);
}

export function isConsoleConfigured(db: Database.Database = getDb()): boolean {
  return !!getSetting("protectApiBaseUrl", db) && !!getSetting("protectApiKey", db);
}

export interface SecretState {
  set: boolean;
  /** False when a value is stored but can't be decrypted with the current SECRETS_KEY: it has to be re-entered. */
  readable: boolean;
}

export interface GroupDescription {
  values: Record<string, string | null>;
  secrets: Record<string, SecretState>;
}

/** What the admin UI may see: plain values, and only whether each secret is set. */
export function describeSettings(group: SettingsGroup, db: Database.Database = getDb()): GroupDescription {
  const values: Record<string, string | null> = {};
  const secrets: Record<string, SecretState> = {};
  for (const [key, def] of Object.entries(SETTINGS) as [SettingKey, FieldDef][]) {
    if (def.group !== group) continue;
    if (def.secret) {
      const row = readRow(db, key);
      secrets[key] = { set: !!row, readable: !!row && decryptSecret(key, row.value) !== null };
    } else {
      values[key] = getSetting(key, db);
    }
  }
  return { values, secrets };
}

export type SaveResult = { ok: true; changed: SettingKey[] } | { ok: false; error: string };

/**
 * Saves part of one group. For a plain field, a string sets it and null or ""
 * clears it. For a secret, a string replaces it, "" keeps the stored value
 * (the UI never has it to send back), and null clears it. Keys not in the
 * input are left alone. All-or-nothing: one invalid field saves nothing.
 */
export function saveSettings(
  group: SettingsGroup,
  input: Record<string, string | null>,
  db: Database.Database = getDb(),
): SaveResult {
  const writes: { key: SettingKey; value: string | null; secret: boolean }[] = [];
  for (const [rawKey, raw] of Object.entries(input)) {
    if (!(rawKey in SETTINGS) || field(rawKey as SettingKey).group !== group) {
      return { ok: false, error: `${rawKey} is not a ${group} setting` };
    }
    const key = rawKey as SettingKey;
    const def = field(key);
    if (def.secret && raw === "") continue;
    if (raw === null || raw.trim() === "") {
      writes.push({ key, value: null, secret: !!def.secret });
      continue;
    }
    const parsed = def.schema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: `${key} ${parsed.error.issues[0]?.message ?? "is invalid"}` };
    writes.push({ key, value: parsed.data, secret: !!def.secret });
  }

  if (writes.some((w) => w.secret && w.value !== null) && secretsKeyStatus() !== "ok") {
    return { ok: false, error: "SECRETS_KEY is missing or invalid, so credentials can't be stored. Generate one with `openssl rand -base64 32`, set it, and restart." };
  }

  const upsert = db.prepare(
    "INSERT INTO settings (key, value, secret) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, secret = excluded.secret",
  );
  const remove = db.prepare("DELETE FROM settings WHERE key = ?");
  db.transaction(() => {
    for (const w of writes) {
      if (w.value === null) remove.run(w.key);
      else upsert.run(w.key, w.secret ? encryptSecret(w.key, w.value) : w.value, w.secret ? 1 : 0);
    }
    if (writes.length > 0) bumpRevision(db);
  })();
  return { ok: true, changed: writes.map((w) => w.key) };
}

/**
 * First boot only: copies whatever env values exist into the table, so an
 * existing .env deploy keeps working without retyping anything. Never
 * overwrites a stored value. Marked done once every env value present was
 * imported; a secret that couldn't be encrypted yet (no SECRETS_KEY) leaves
 * it unmarked so the next boot, with the key, finishes the job.
 */
export function seedSettingsFromEnv(db: Database.Database, env: Record<string, string | undefined> = process.env): void {
  if (readRow(db, SEEDED_KEY)) return;
  const exists = db.prepare("SELECT 1 FROM settings WHERE key = ?");
  const insert = db.prepare("INSERT INTO settings (key, value, secret) VALUES (?, ?, ?)");
  const imported: string[] = [];
  let complete = true;

  for (const [key, def] of Object.entries(SETTINGS) as [SettingKey, FieldDef][]) {
    const raw = def.env ? env[def.env]?.trim() : undefined;
    if (!raw || exists.get(key)) continue;
    let value = raw;
    // PROTECT_CA_CERT used to be a file path; the setting holds the PEM itself.
    if (key === "protectCaCert" && !raw.includes("-----BEGIN")) {
      try {
        value = readFileSync(raw, "utf8").trim();
      } catch (err) {
        logger.warn({ err, path: raw }, "PROTECT_CA_CERT points at a file that can't be read; not imported");
        continue;
      }
    }
    const parsed = def.schema.safeParse(value);
    if (!parsed.success) {
      logger.warn({ env: def.env }, `${def.env} is invalid (${parsed.error.issues[0]?.message}); not imported`);
      continue;
    }
    if (def.secret && secretsKeyStatus() !== "ok") {
      complete = false;
      continue;
    }
    insert.run(key, def.secret ? encryptSecret(key, parsed.data) : parsed.data, def.secret ? 1 : 0);
    imported.push(def.env!);
  }

  if (imported.length > 0) {
    bumpRevision(db);
    logger.info({ imported }, "imported settings from the environment; edit them in the admin UI from now on");
  }
  if (complete) {
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(SEEDED_KEY, new Date().toISOString());
  } else {
    logger.warn("credentials in the environment were not imported because SECRETS_KEY is missing or invalid");
  }
}

import type Database from "better-sqlite3";

const DEFAULTS: Record<string, string> = {
  exitDelaySec: process.env.DEFAULT_EXIT_DELAY_SEC ?? "30",
  entryDelaySec: process.env.DEFAULT_ENTRY_DELAY_SEC ?? "30",
};

// Not in DEFAULTS above / not seeded by seedDefaultConfig(): unlike
// exitDelaySec/entryDelaySec (which every deployment has and edits via the
// Delays screen), this only matters to the subset of deployments that
// configure the UniFi console sync at all — seeding it into the config
// table would make it a permanent, always-visible Advanced-table row for
// every install, same opt-in-until-set reasoning as sirenAlarmManagerWebhookId.
const EXTERNAL_ARM_SYNC_DELAY_FALLBACK = process.env.DEFAULT_EXTERNAL_ARM_SYNC_DELAY_SEC ?? "5";

export function seedDefaultConfig(db: Database.Database): void {
  const exists = db.prepare("SELECT 1 FROM config WHERE key = ?");
  const insert = db.prepare("INSERT INTO config (key, value) VALUES (?, ?)");
  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (!exists.get(key)) insert.run(key, value);
  }
}

export function getConfigValue(db: Database.Database, key: string): string | null {
  const row = db.prepare("SELECT value FROM config WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setConfigValue(db: Database.Database, key: string, value: string): void {
  db.prepare("INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    key,
    value,
  );
}

/**
 * Trial-period switch (Settings > Test mode): the alarm runs every normal step
 * (state machine, Slack/ntfy, snapshots, UniFi siren webhook) except that the
 * kiosk plays no sound. Read per status poll, so a toggle lands within ~2s.
 */
export function isPanelTestMode(db: Database.Database): boolean {
  return getConfigValue(db, "panelTestMode") === "true";
}

export function listConfig(db: Database.Database): Record<string, string> {
  const rows = db.prepare("SELECT key, value FROM config").all() as { key: string; value: string }[];
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

// An hour is far past any plausible entry/exit delay, and well under
// setTimeout's 32-bit ceiling (~24.8 days), past which Node silently clamps
// the delay to 1ms.
export const MAX_DELAY_SEC = 3600;

/**
 * Reads a delay config key defensively. A non-numeric value ("abc" typed into
 * the Settings screen's Advanced table) or one past setTimeout's 32-bit
 * ceiling both reach setTimeout as NaN/overflow, where Node clamps them to
 * ~1ms — i.e. no exit delay at all, or an entry delay that alarms the instant
 * a door opens. The API rejects
 * these too (see app/api/admin/config/route.ts); this is the layer that has
 * to hold even for a value written directly into the DB.
 */
function readDelaySec(db: Database.Database, key: string, fallback: string): number {
  const raw = getConfigValue(db, key);
  // Number("") is 0, so a cleared field would otherwise mean "no delay at
  // all" — an entry delay of zero alarms the instant a door opens. A blank
  // value is a mistake, not a deliberate 0, so it falls back like a missing
  // key; an explicit "0" still means zero.
  const value = raw === null || raw.trim() === "" ? fallback : raw;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return Number(fallback);
  return Math.min(parsed, MAX_DELAY_SEC);
}

export function getDelays(db: Database.Database): { exitDelaySec: number; entryDelaySec: number } {
  return {
    exitDelaySec: readDelaySec(db, "exitDelaySec", DEFAULTS.exitDelaySec),
    entryDelaySec: readDelaySec(db, "entryDelaySec", DEFAULTS.entryDelaySec),
  };
}

/**
 * Used only by AlarmEngine.syncExternalArmState() in place of the normal
 * exitDelaySec — a UniFi-triggered arm has already run its real exit delay
 * on UniFi's own side by the time this app observes the profile as fully
 * "armed", so re-running the full local exitDelaySec would double it. This
 * is just a short buffer for poll-interval/clock skew, not a second grace
 * period for someone to leave.
 */
export function getExternalArmSyncDelaySec(db: Database.Database): number {
  return readDelaySec(db, "externalArmSyncDelaySec", EXTERNAL_ARM_SYNC_DELAY_FALLBACK);
}

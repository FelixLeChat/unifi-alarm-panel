export interface Migration {
  id: number;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    sql: `
      CREATE TABLE pins (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        label TEXT NOT NULL,
        hash TEXT NOT NULL,
        is_duress INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );

      CREATE TABLE audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        actor_label TEXT,
        event TEXT NOT NULL,
        detail_json TEXT
      );

      -- Append-only: enforced at the application layer (never UPDATE/DELETE),
      -- and again here so a future bug can't silently rewrite history.
      CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit
      BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;

      CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit
      BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;

      CREATE TABLE sensors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        unifi_id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'instant' CHECK (mode IN ('delayed', 'instant', 'ignore'))
      );

      CREATE TABLE config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE alarm_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        name TEXT NOT NULL,
        since TEXT NOT NULL,
        triggered_by_sensor_id TEXT
      );
    `,
  },
  {
    id: 2,
    sql: `
      -- Which Protect camera to snapshot when this sensor trips. Nullable:
      -- not every sensor (e.g. a motion sensor with no camera nearby) has one.
      ALTER TABLE sensors ADD COLUMN camera_id TEXT;
    `,
  },
  {
    id: 3,
    sql: `
      -- Tracks edits (label/PIN/type) made from the admin PIN detail view.
      -- No column-level default: SQLite's ALTER TABLE ADD COLUMN rejects a
      -- non-constant default (strftime(...)) outright, unlike CREATE TABLE.
      -- Existing rows are backfilled explicitly instead; app code (see
      -- lib/services/pins.ts) always sets updated_at on every insert/update.
      ALTER TABLE pins ADD COLUMN updated_at TEXT;
      UPDATE pins SET updated_at = created_at WHERE updated_at IS NULL;
    `,
  },
  {
    id: 4,
    sql: `
      -- The camera's RTSPS URL (Settings -> Advanced -> RTSP alias on the
      -- console), used to register a live stream with go2rtc for this
      -- sensor's mapped camera. Nullable: not every sensor has a camera, and
      -- not every camera needs live streaming (a snapshot may be enough).
      ALTER TABLE sensors ADD COLUMN rtsp_url TEXT;
    `,
  },
  {
    id: 5,
    sql: `
      -- What kind of physical event this sensor reports (motion vs. a door's
      -- open/close). Admin-set, not inferred: UniFi's webhook payload can't
      -- reliably distinguish device type at the event level (see the comment
      -- on isCameraTriggerEvent() in lib/services/sensors.ts), so unlike mode
      -- this has no default and stays NULL until someone classifies it.
      ALTER TABLE sensors ADD COLUMN sensor_type TEXT;
    `,
  },
  {
    id: 6,
    sql: `
      -- Live open/closed state, derived from webhook eventType via the
      -- sensorOpenEventTypes/sensorClosedEventTypes config keys (see
      -- lib/services/sensors.ts's resolveOpenState) — same config-mapped,
      -- opt-in precedent as cameraTriggerEventTypes. No CHECK constraint,
      -- same reasoning as sensor_type: NULL until a recognized event arrives.
      ALTER TABLE sensors ADD COLUMN current_state TEXT;
    `,
  },
  {
    id: 7,
    sql: `
      -- When the in-flight exit/entry countdown is due to elapse, as an ISO
      -- instant. The setTimeout driving it lives only in memory, so without
      -- persisting the deadline a restart mid-countdown left the state name
      -- restored but the timer gone: ENTRY_DELAY would never escalate to
      -- ALARM (an intruder inside, no alert ever sent) and ARMING would never
      -- settle to ARMED. See AlarmEngine.resumeTimer().
      ALTER TABLE alarm_state ADD COLUMN timer_ends_at TEXT;
    `,
  },
  {
    id: 8,
    sql: `
      -- Console, notification and panel settings edited from the admin UI
      -- (lib/services/settings.ts). Separate from \`config\` on purpose: the
      -- Settings screen's Advanced table writes arbitrary config keys, which
      -- would bypass this table's validation and secret handling. \`secret\`
      -- rows hold AES-256-GCM ciphertext (lib/services/secrets.ts), never
      -- plaintext.
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        secret INTEGER NOT NULL DEFAULT 0
      );
    `,
  },
];

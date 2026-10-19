import type Database from "better-sqlite3";
import type { SensorMode } from "@/lib/state/machine";
import { getConfigValue } from "./config";

export type SensorType = "motion" | "door";

export type SensorState = "open" | "closed";

export interface SensorRecord {
  id: number;
  unifiId: string;
  name: string;
  mode: SensorMode;
  cameraId: string | null;
  rtspUrl: string | null;
  sensorType: SensorType | null;
  lastTrippedAt: string | null;
  /** Trips over the last 7 days — the baseline "how chatty is this sensor normally" the admin UI grades freshness against. */
  tripCount7d: number;
  /** Trips over the last 24h — a quicker "is this thing still busy right now" figure than the 7-day baseline, shown alongside it on the sensor detail pane. */
  tripCount24h: number;
  currentState: SensorState | null;
}

interface SensorRow {
  id: number;
  unifi_id: string;
  name: string;
  mode: string;
  camera_id: string | null;
  rtsp_url: string | null;
  sensor_type: string | null;
  last_tripped_at: string | null;
  trip_count_7d: number;
  trip_count_24h: number;
  current_state: string | null;
}

function fromRow(row: SensorRow): SensorRecord {
  return {
    id: row.id,
    unifiId: row.unifi_id,
    name: row.name,
    mode: row.mode as SensorMode,
    cameraId: row.camera_id,
    rtspUrl: row.rtsp_url,
    sensorType: row.sensor_type as SensorType | null,
    lastTrippedAt: row.last_tripped_at,
    tripCount7d: row.trip_count_7d,
    tripCount24h: row.trip_count_24h,
    currentState: row.current_state as SensorState | null,
  };
}

// Every audit event a sensor trip can produce (see lib/state/machine.ts)
// stores the tripping sensor's unifiId under detail_json's "sensorId" key.
// Both figures come from ONE grouped pass over the audit table rather than a
// correlated subquery each: the audit log is append-only and grows forever,
// and two correlated scans per sensor turned the admin Sensors screen into
// 2N full scans of it, getting slower every week the office runs.
//
// trip_count_7d is the sensor's own recent cadence — "hasn't tripped in 12h"
// says nothing on its own (normal for a back door, alarming for a busy
// corridor), so the admin UI grades silence against it rather than against a
// fixed threshold (see sensorHealth in app/admin/shared.ts). The 7-day cutoff
// is written in the same ISO shape the schema stores `ts` in; SQLite's own
// space-separated datetime() would compare wrong at the boundary.
function tripStatsJoin(forOneSensor: boolean): string {
  return `
  LEFT JOIN (
    SELECT json_extract(detail_json, '$.sensorId') AS sensor_id,
           MAX(ts) AS last_tripped_at,
           SUM(CASE WHEN ts > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days') THEN 1 ELSE 0 END) AS trip_count_7d,
           SUM(CASE WHEN ts > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day') THEN 1 ELSE 0 END) AS trip_count_24h
      FROM audit
     WHERE json_extract(detail_json, '$.sensorId') ${forOneSensor ? "= ?" : "IS NOT NULL"}
     GROUP BY sensor_id
  ) trips ON trips.sensor_id = sensors.unifi_id
`;
}

const SENSOR_COLUMNS = `
  sensors.id, sensors.unifi_id, sensors.name, sensors.mode, sensors.camera_id, sensors.rtsp_url,
  sensors.sensor_type, sensors.current_state, trips.last_tripped_at,
  COALESCE(trips.trip_count_7d, 0) AS trip_count_7d,
  COALESCE(trips.trip_count_24h, 0) AS trip_count_24h
`;

export function getSensor(db: Database.Database, unifiId: string): SensorRecord | null {
  const row = db
    .prepare(
      // The single-sensor read is on the webhook path (resolveSensorMode,
      // the engine's door lookup), so its audit scan is narrowed to that one
      // sensor rather than grouping the whole table the way the list does.
      `SELECT ${SENSOR_COLUMNS} FROM sensors ${tripStatsJoin(true)} WHERE sensors.unifi_id = ?`,
    )
    .get(unifiId, unifiId) as SensorRow | undefined;
  return row ? fromRow(row) : null;
}

export function listSensors(db: Database.Database): SensorRecord[] {
  const rows = db
    .prepare(
      `SELECT ${SENSOR_COLUMNS} FROM sensors ${tripStatsJoin(false)} ORDER BY sensors.id`,
    )
    .all() as SensorRow[];
  return rows.map(fromRow);
}

export function upsertSensor(
  db: Database.Database,
  unifiId: string,
  name: string | undefined,
  mode: SensorMode,
  cameraId?: string | null,
  rtspUrl?: string | null,
  sensorType?: SensorType | null,
): void {
  const existing = getSensor(db, unifiId);
  db.prepare(
    `INSERT INTO sensors (unifi_id, name, mode, camera_id, rtsp_url, sensor_type) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(unifi_id) DO UPDATE SET
       name = excluded.name,
       mode = excluded.mode,
       camera_id = excluded.camera_id,
       rtsp_url = excluded.rtsp_url,
       sensor_type = excluded.sensor_type`,
  ).run(
    unifiId,
    name ?? existing?.name ?? unifiId,
    mode,
    cameraId !== undefined ? cameraId : (existing?.cameraId ?? null),
    rtspUrl !== undefined ? rtspUrl : (existing?.rtspUrl ?? null),
    sensorType !== undefined ? sensorType : (existing?.sensorType ?? null),
  );
}

/**
 * Removes a sensor row entirely (not a revoke/soft-delete like PINs) — a
 * sensor is just a locally-cached label for whatever UniFi last told us
 * about a device, not a security credential with its own history worth
 * preserving. If that device trips again later, resolveSensorMode() just
 * re-registers it with the default mode, same as any other unknown sensor.
 */
export function deleteSensor(db: Database.Database, unifiId: string): void {
  db.prepare("DELETE FROM sensors WHERE unifi_id = ?").run(unifiId);
}

/**
 * UniFi's Alarm Manager doesn't distinguish "a physical UP-Sense sensor
 * tripped" from "a camera triggered its own Motion alarm" at the device-id
 * level — both just report their own MAC in the webhook's device field, and
 * the Protect Integration API has no MAC field to reverse-look-up against
 * (confirmed against its real schema — camera objects expose only
 * id/modelKey/state/name, no mac).
 *
 * There IS a signal in one specific real deployment: a physical sensor's
 * trigger key came through prefixed "sensor_" (sensor_door_opened,
 * sensor_tamper), while a camera's own Activity trigger didn't ("motion").
 * But that's an artifact of one JSONPath mapping (webhookEventTypePath =
 * alarm.triggers.0.key), not a rule this app can assume — the DEFAULT,
 * documented webhook shape (DEFAULT_EVENT_TYPE_PATH in webhook-intake.ts)
 * uses plain values like "open"/"close" for physical sensors too, which a
 * blind "not sensor_-prefixed" guess would misclassify as a camera. Tried
 * that first; it broke a real physical-sensor alerting test. So this is
 * config-mapped and opt-in (empty by default = no behavior change) rather
 * than inferred, same reasoning as the two path configs.
 */
function isCameraTriggerEvent(db: Database.Database, eventType: string | undefined): boolean {
  if (eventType === undefined) return false;
  const configured = getConfigValue(db, "cameraTriggerEventTypes");
  if (!configured) return false;
  return configured
    .split(",")
    .map((s) => s.trim())
    .includes(eventType);
}

/**
 * A sensor UniFi has never told us about gets registered with a safe
 * default mode (rather than silently dropped) so an admin can retune it
 * later via /api/admin/config. When the trigger's eventType matches the
 * configured `cameraTriggerEventTypes` list (see isCameraTriggerEvent),
 * self-map cameraId to the device's own id — it already *is* the camera, so
 * there's no separate device to attach one to.
 */
/**
 * Same config-mapped, opt-in precedent as isCameraTriggerEvent above: a
 * raw eventType only means "open"/"closed" when the deployment has told us
 * so via sensorOpenEventTypes/sensorClosedEventTypes (both unset by default
 * = no behavior change), because the literal values are console-dependent.
 */
function resolveOpenState(db: Database.Database, eventType: string | undefined): "open" | "closed" | null {
  if (eventType === undefined) return null;
  const openTypes = getConfigValue(db, "sensorOpenEventTypes");
  if (openTypes && openTypes.split(",").map((s) => s.trim()).includes(eventType)) return "open";
  const closedTypes = getConfigValue(db, "sensorClosedEventTypes");
  if (closedTypes && closedTypes.split(",").map((s) => s.trim()).includes(eventType)) return "closed";
  return null;
}

/**
 * Updates a sensor's live open/closed state from a webhook eventType. An
 * unmatched or unconfigured eventType leaves current_state untouched —
 * never guess. Call after the sensor row is known to exist (e.g. after
 * resolveSensorMode).
 */
export function updateSensorState(db: Database.Database, unifiId: string, eventType?: string): SensorState | null {
  const state = resolveOpenState(db, eventType);
  if (state === null) return null;
  setSensorState(db, unifiId, state);
  return state;
}

/**
 * Sets open/closed directly, for a source that already knows which it is
 * without any config mapping — the realtime stream reports a sensor's
 * `isOpened` as a boolean (see lib/services/protect-event-stream.ts), where
 * a webhook only carries a deployment-specific event-type string.
 */
export function setSensorState(db: Database.Database, unifiId: string, state: SensorState): void {
  db.prepare("UPDATE sensors SET current_state = ? WHERE unifi_id = ?").run(state, unifiId);
}

/**
 * Sensors that should block arming right now: door sensors, not opted out
 * via mode 'ignore' (an ignored sensor is already excluded from the whole
 * alarm system), currently reporting open. See AlarmEngine.arm()/armWithoutPin().
 */
export function listOpenGatingSensors(db: Database.Database): { id: number; name: string }[] {
  return db
    .prepare(
      `SELECT id, name FROM sensors WHERE sensor_type = 'door' AND mode != 'ignore' AND current_state = 'open' ORDER BY id`,
    )
    .all() as { id: number; name: string }[];
}

/** Every door the panel lists, open or not (ignored sensors are out of the alarm system, so out of the list). */
export function listDoorStatuses(db: Database.Database): { id: number; name: string; open: boolean }[] {
  const rows = db
    .prepare(`SELECT id, name, current_state FROM sensors WHERE sensor_type = 'door' AND mode != 'ignore' ORDER BY id`)
    .all() as { id: number; name: string; current_state: string | null }[];
  return rows.map((r) => ({ id: r.id, name: r.name, open: r.current_state === "open" }));
}

export function resolveSensorMode(db: Database.Database, unifiId: string, eventType?: string): SensorMode {
  return registerIfUnknown(db, unifiId, isCameraTriggerEvent(db, eventType));
}

/**
 * The same "known sensor, or register it with the safe default" resolution,
 * for a source that knows outright whether the device is a camera rather
 * than having to infer it from a config-mapped event type — the realtime
 * stream reads the device's own model key (see protect-event-stream.ts).
 */
export function resolveSensorModeForDevice(
  db: Database.Database,
  unifiId: string,
  isCamera: boolean,
  name?: string,
): SensorMode {
  return registerIfUnknown(db, unifiId, isCamera, name);
}

function registerIfUnknown(
  db: Database.Database,
  unifiId: string,
  isCameraTrigger: boolean,
  name?: string,
): SensorMode {
  const existing = getSensor(db, unifiId);
  if (existing) {
    // The webhook registers a sensor under its raw id; the stream is the first source that knows the device's name.
    if (name && existing.name === unifiId && name !== unifiId) {
      db.prepare("UPDATE sensors SET name = ? WHERE unifi_id = ?").run(name, unifiId);
    }
    return existing.mode;
  }

  const defaultMode = (getConfigValue(db, "defaultSensorMode") as SensorMode | null) ?? "delayed";
  db.prepare("INSERT INTO sensors (unifi_id, name, mode, camera_id) VALUES (?, ?, ?, ?)").run(
    unifiId,
    name ?? unifiId,
    defaultMode,
    isCameraTrigger ? unifiId : null,
  );
  return defaultMode;
}

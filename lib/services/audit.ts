import type Database from "better-sqlite3";

export interface AuditOptions {
  actorLabel?: string;
  detail?: unknown;
}

export function recordAudit(db: Database.Database, event: string, opts: AuditOptions = {}): void {
  db.prepare("INSERT INTO audit (actor_label, event, detail_json) VALUES (?, ?, ?)").run(
    opts.actorLabel ?? null,
    event,
    opts.detail !== undefined ? JSON.stringify(opts.detail) : null,
  );
}

export interface AuditRow {
  id: number;
  ts: string;
  actorLabel: string | null;
  event: string;
  detail: unknown;
}

interface AuditDbRow {
  id: number;
  ts: string;
  actor_label: string | null;
  event: string;
  detail_json: string | null;
}

function toAuditRow(row: AuditDbRow): AuditRow {
  return {
    id: row.id,
    ts: row.ts,
    actorLabel: row.actor_label,
    event: row.event,
    detail: row.detail_json ? JSON.parse(row.detail_json) : null,
  };
}

/**
 * `sensorId`, when given, matches the same `detail_json.sensorId` field
 * every sensor-trip audit event carries (see tripStatsJoin in
 * lib/services/sensors.ts, which grades a sensor's own health against this
 * same field) — any event naming this sensor counts, not just the ones the
 * state machine treats as an actual "trip" while armed.
 */
export function listAudit(db: Database.Database, limit: number, before?: number, sensorId?: string): AuditRow[] {
  const conditions: string[] = [];
  const params: (number | string)[] = [];
  if (before !== undefined) {
    conditions.push("id < ?");
    params.push(before);
  }
  if (sensorId !== undefined) {
    conditions.push("json_extract(detail_json, '$.sensorId') = ?");
    params.push(sensorId);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const rows = db
    .prepare(`SELECT id, ts, actor_label, event, detail_json FROM audit ${where} ORDER BY id DESC LIMIT ?`)
    .all(...params, limit) as AuditDbRow[];

  return rows.map(toAuditRow);
}

export interface LastArmDisarmEvent {
  event: "armed" | "disarmed";
  ts: string;
  actorLabel: string | null;
}

/**
 * The Overview screen's "Last armed / disarmed" card used to derive this by
 * filtering the general, capped last-50-events list — which silently went
 * blank on any real deployment where 50+ other audit rows (sensor trips,
 * webhook noise) had happened since the last actual arm/disarm. This is a
 * dedicated, uncapped query instead.
 */
export function getLastArmDisarmEvent(db: Database.Database): LastArmDisarmEvent | null {
  const row = db
    .prepare("SELECT ts, actor_label, event FROM audit WHERE event IN ('armed', 'disarmed') ORDER BY id DESC LIMIT 1")
    .get() as { ts: string; actor_label: string | null; event: string } | undefined;
  return row ? { event: row.event as "armed" | "disarmed", ts: row.ts, actorLabel: row.actor_label } : null;
}

/** Rows with `ts` in [startIso, endIsoExclusive), oldest first — used by the daily archive job to pull exactly one day at a time. */
export function listAuditBetween(db: Database.Database, startIso: string, endIsoExclusive: string): AuditRow[] {
  const rows = db
    .prepare("SELECT id, ts, actor_label, event, detail_json FROM audit WHERE ts >= ? AND ts < ? ORDER BY id ASC")
    .all(startIso, endIsoExclusive) as AuditDbRow[];
  return rows.map(toAuditRow);
}

// Events that represent an actual sensor trip while the system was armed
// (entry delay or full alarm) — the "what just tripped" moments the Events
// screen groups into incidents. Deliberately excludes trips while disarmed
// or during the exit delay (arming): those aren't alarm-relevant.
const TRIGGER_EVENTS = new Set([
  "entry_delay_started",
  "alarm_instant",
  "alarm_instant_during_entry_delay",
  "alarm_entry_timeout",
  "sensor_trip_during_entry_delay",
  "sensor_trip_during_alarm",
]);
const ALARM_EVENTS = new Set(["alarm_instant", "alarm_instant_during_entry_delay", "alarm_entry_timeout"]);

const INCIDENT_GAP_MS = 5 * 60_000;
// ponytail: bounded scan, not a paginated system of record — this powers a
// "what just happened" glance, not exhaustive history (the Audit screen and
// its CSV export already cover that). Raise if incidents ever need deeper
// history than this comfortably reaches.
const RAW_SCAN_LIMIT = 1000;

export interface EventIncidentSensor {
  sensorId: string;
  tripCount: number;
  firstTs: string;
  lastTs: string;
}

export interface EventIncident {
  id: number;
  startedAt: string;
  endedAt: string;
  triggeredAlarm: boolean;
  resolvedAt: string | null;
  resolvedBy: string | null;
  sensors: EventIncidentSensor[];
}

function detailSensorId(detail: unknown): string | null {
  if (!detail || typeof detail !== "object") return null;
  const v = (detail as Record<string, unknown>).sensorId;
  return typeof v === "string" ? v : null;
}

interface WorkingIncident extends Omit<EventIncident, "sensors"> {
  sensorMap: Map<string, EventIncidentSensor>;
}

/**
 * Groups sensor trips that happened while armed into one incident per
 * rolling INCIDENT_GAP_MS window, so one continuous trip (a motion sensor
 * re-firing every few seconds) doesn't splinter into many rows — a new trip
 * extends the current incident as long as it's within INCIDENT_GAP_MS of the
 * *last* trip in it, rather than the window being capped from the first.
 * Each incident's resolution is the next "disarmed" event after its last
 * trip, however long that takes — no cap there, since an alarm can run for
 * a while before someone clears it.
 */
export function listEventIncidents(db: Database.Database, limit: number): EventIncident[] {
  const rows = (
    db.prepare("SELECT id, ts, actor_label, event, detail_json FROM audit ORDER BY id DESC LIMIT ?").all(RAW_SCAN_LIMIT) as AuditDbRow[]
  )
    .map(toAuditRow)
    .reverse(); // oldest first, so a rolling window can be built forward in time

  const incidents: WorkingIncident[] = [];
  let current: WorkingIncident | null = null;

  for (const row of rows) {
    if (TRIGGER_EVENTS.has(row.event)) {
      const gapExceeded = !current || new Date(row.ts).getTime() - new Date(current.endedAt).getTime() > INCIDENT_GAP_MS;
      if (gapExceeded) {
        current = { id: row.id, startedAt: row.ts, endedAt: row.ts, triggeredAlarm: false, resolvedAt: null, resolvedBy: null, sensorMap: new Map() };
        incidents.push(current);
      }
      const incident = current as WorkingIncident;
      incident.endedAt = row.ts;
      if (ALARM_EVENTS.has(row.event)) incident.triggeredAlarm = true;
      const sensorId = detailSensorId(row.detail);
      if (sensorId) {
        const existing = incident.sensorMap.get(sensorId);
        if (existing) {
          existing.tripCount += 1;
          existing.lastTs = row.ts;
        } else {
          incident.sensorMap.set(sensorId, { sensorId, tripCount: 1, firstTs: row.ts, lastTs: row.ts });
        }
      }
    } else if (row.event === "disarmed" && current && !current.resolvedAt) {
      current.resolvedAt = row.ts;
      current.resolvedBy = row.actorLabel;
    }
  }

  return incidents
    .slice(-limit)
    .reverse()
    .map(({ sensorMap, ...incident }) => ({ ...incident, sensors: [...sensorMap.values()] }));
}

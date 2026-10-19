import { useCallback, useRef, useState } from "react";

// Type-only imports: the admin bundle never pulls server code in through these.
import type { AlarmStateName, SensorMode } from "@/lib/state/machine";
import type { SensorState, SensorType } from "@/lib/services/sensors";
export type { AlarmStateName, SensorMode, SensorState, SensorType };

export interface StatusResponse {
  state: AlarmStateName;
  since: string;
  remainingSec: number | null;
  welcomeName: string | null;
  triggeredBy: { sensorId: string } | null;
  version: string;
  uptimeSec: number;
}

export interface PinSummary {
  id: number;
  label: string;
  isDuress: boolean;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}


export interface SensorRecord {
  id: number;
  unifiId: string;
  name: string;
  mode: SensorMode;
  cameraId: string | null;
  rtspUrl: string | null;
  sensorType: SensorType | null;
  lastTrippedAt: string | null;
  tripCount7d: number;
  tripCount24h: number;
  currentState: SensorState | null;
  /** Live device liveness from UniFi, when a SuperAdmin credential is configured (see lib/services/protect-device-health.ts). */
  device: SensorDeviceHealth | null;
}

export interface SensorDeviceHealth {
  online: boolean;
  lastSeenAt: string | null;
  batteryPercent: number | null;
  batteryLow: boolean;
  tampered: boolean;
  /** Radio signal in dBm — the bars the Protect UI shows. Null for a wired device. */
  signalDbm: number | null;
}

export interface LastArmDisarmEvent {
  event: "armed" | "disarmed";
  ts: string;
  actorLabel: string | null;
}

export interface AuditRow {
  id: number;
  ts: string;
  actorLabel: string | null;
  event: string;
  detail: unknown;
}

export interface EventIncidentSensor {
  sensorId: string;
  sensorName: string;
  cameraId: string | null;
  rtspUrl: string | null;
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

export type Screen = "overview" | "sensors" | "pins" | "delays" | "audit" | "events" | "tasks" | "settings";

// Eyebrow label: mono, uppercase, tracked — the recurring label pattern
// used above nearly every field/section in this redesign.
export const EYEBROW = "font-mono text-eyebrow-s leading-none tracking-eyebrow uppercase text-muted-foreground font-medium";

export const TRANSITION = "transition-opacity duration-150 ease-[cubic-bezier(0.4,0,0.2,1)]";

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

// "requested:<tag>" (marker written, not yet picked up by the root updater
// timer) and "applying:<tag>" (deploy/update.sh actively running) both mean
// "don't let the user fire another one" — see app/api/admin/update/route.ts.
// Both the header banner (AppShell) and the Tasks screen trigger the same
// update, so this lives here once rather than drifting between the two.
export function isUpdateApplyInProgress(applyStatus: string | null | undefined): boolean {
  return Boolean(applyStatus?.startsWith("requested:") || applyStatus?.startsWith("applying:"));
}

export function updateApplyProgressLabel(applyStatus: string | null | undefined, latestVersion: string | null): string | null {
  if (applyStatus?.startsWith("applying:")) return `Updating to ${latestVersion}…`;
  if (applyStatus?.startsWith("requested:")) return "Update requested: waiting for the updater…";
  return null;
}

// "done:<tag>" and "failed:<tag>[ (reason)]" (see deploy/apply-pending-update.sh)
// are terminal states, worth a line of their own — requested:/applying: are
// already covered by the button via updateApplyProgressLabel above, so
// surfacing them here too would just repeat the same message twice.
export function formatApplyStatus(applyStatus: string | null | undefined): { text: string; tone: "muted" | "destructive" } | null {
  if (applyStatus?.startsWith("done:")) {
    return { text: `Last update applied: ${applyStatus.slice("done:".length)}.`, tone: "muted" };
  }
  if (applyStatus?.startsWith("failed:")) {
    const rest = applyStatus.slice("failed:".length);
    const [tag, ...reasonParts] = rest.split(" ");
    const reason = reasonParts.join(" ").replace(/^\((.*)\)$/, "$1");
    return { text: `Last update failed for ${tag}${reason ? `: ${reason}` : ""}.`, tone: "destructive" };
  }
  return null;
}

export function formatClockTime(iso: string): string {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "Today 17:21", "Yesterday 17:21", "Friday 17:21" within the last week, else "2026-10-01 17:21". */
export function formatDayClockTime(iso: string): string {
  const d = new Date(iso);
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const daysAgo = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86_400_000);
  const day =
    daysAgo <= 0 ? "Today"
    : daysAgo === 1 ? "Yesterday"
    : daysAgo < 7 ? d.toLocaleDateString("en-US", { weekday: "long" })
    : formatDateOnly(iso);
  return `${day} ${formatClockTime(iso)}`;
}

export function formatDateOnly(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function formatAuditTimestamp(iso: string): string {
  const d = new Date(iso);
  return `${formatDateOnly(iso)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function relativeDay(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOf(now) - startOf(d)) / 86_400_000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return formatDateOnly(iso);
}

export type SensorHealth = "green" | "yellow" | "red" | "unknown";

export interface SensorHealthVerdict {
  level: SensorHealth;
  /** Why, in the words the tooltip shows — a bare dot that can't explain itself is what made the old logic untrustworthy. */
  reason: string;
}

// How many times its own typical gap a sensor may stay silent before the
// dot turns. Deliberately generous: this measures office traffic, which is
// bursty (a long weekend is not a fault), so it only fires on silence well
// outside the sensor's own normal rhythm.
const QUIET_YELLOW_FACTOR = 3;
const QUIET_RED_FACTOR = 10;

/**
 * A sensor's status, in priority order: what UniFi says about the physical
 * device first, then trip freshness — and only ever relative to that
 * sensor's own cadence.
 *
 * The rule this replaces graded every sensor on a fixed 12h/72h scale,
 * which measured how busy the office was, not whether anything worked: a
 * back door nobody uses went red by design, and the one failure that
 * actually mattered (the whole webhook feed dead for two days) painted six
 * sensors individually instead of naming its single cause. So a dead feed
 * now greys every dot out and is reported once, by the caller, rather than
 * being blamed on each sensor in turn.
 */
export function sensorHealth(sensor: SensorRecord, feedStale: boolean): SensorHealthVerdict {
  if (sensor.device && !sensor.device.online) {
    return { level: "red", reason: "Offline in UniFi Protect" };
  }
  if (sensor.device?.tampered) {
    return { level: "red", reason: "Tampering reported by UniFi Protect" };
  }
  if (sensor.device?.batteryLow) {
    const pct = sensor.device.batteryPercent;
    return { level: "yellow", reason: `Low battery${pct != null ? ` (${pct}%)` : ""}` };
  }
  // A device UniFi itself confirms is online, untampered, and battery-fine
  // is alive — full stop. That's a direct liveness signal, unlike trip
  // cadence below (an inference from silence, for sensors with no device
  // health at all). A camera watching a quiet corner for days is not
  // unhealthy; grading it against how often it used to trip would call it
  // red for doing exactly what a quiet corner is supposed to do.
  if (sensor.device) {
    return { level: "green", reason: "Connected: reporting healthy in UniFi Protect" };
  }
  if (feedStale) {
    return { level: "unknown", reason: "No sensor feed: this sensor's status is unknown, not necessarily bad" };
  }
  if (!sensor.lastTrippedAt) {
    return { level: "unknown", reason: "Never tripped: no baseline to judge against yet" };
  }

  const hoursSince = (Date.now() - new Date(sensor.lastTrippedAt).getTime()) / 3_600_000;
  if (sensor.tripCount7d === 0) {
    return { level: "unknown", reason: `Nothing in the last 7 days: too quiet to have a baseline (last trip ${Math.round(hoursSince)}h ago)` };
  }

  const expectedGapHours = (7 * 24) / sensor.tripCount7d;
  const ratio = hoursSince / expectedGapHours;
  const cadence = `typically every ${formatHours(expectedGapHours)}, quiet for ${formatHours(hoursSince)}`;
  if (ratio > QUIET_RED_FACTOR) return { level: "red", reason: `Far quieter than normal: ${cadence}` };
  if (ratio > QUIET_YELLOW_FACTOR) return { level: "yellow", reason: `Quieter than normal: ${cadence}` };
  return { level: "green", reason: `Normal: ${cadence}` };
}

function formatHours(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

/** Most recent audit row for the given event ("armed"/"disarmed"), or null. Assumes `audit` is sorted newest-first (as /api/admin/audit returns it). */
export function findLastActor(audit: AuditRow[], event: "armed" | "disarmed"): string | null {
  return audit.find((r) => r.event === event)?.actorLabel ?? null;
}

export interface HeatCell {
  date: string;
  count: number;
  level: 0 | 1 | 2 | 3;
}

function dateKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function mondayOf(d: Date): Date {
  const dow = (d.getDay() + 6) % 7; // Mon=0..Sun=6
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - dow);
}

function levelFor(count: number): 0 | 1 | 2 | 3 {
  if (count === 0) return 0;
  if (count <= 2) return 1;
  if (count <= 4) return 2;
  return 3;
}

/** Buckets armed/disarmed audit rows into a 26-week x 7-day (Monday-first) grid, oldest week first. */
export function buildHeatmap(auditWindow: AuditRow[], weeks = 26): HeatCell[][] {
  const countsByDate = new Map<string, number>();
  for (const row of auditWindow) {
    if (row.event !== "armed" && row.event !== "disarmed") continue;
    const key = dateKey(new Date(row.ts));
    countsByDate.set(key, (countsByDate.get(key) ?? 0) + 1);
  }

  const thisMonday = mondayOf(new Date());
  const cols: HeatCell[][] = [];
  for (let w = weeks - 1; w >= 0; w--) {
    const colMonday = new Date(thisMonday.getFullYear(), thisMonday.getMonth(), thisMonday.getDate() - w * 7);
    const col: HeatCell[] = [];
    for (let row = 0; row < 7; row++) {
      const d = new Date(colMonday.getFullYear(), colMonday.getMonth(), colMonday.getDate() + row);
      const key = dateKey(d);
      const count = countsByDate.get(key) ?? 0;
      col.push({ date: key, count, level: levelFor(count) });
    }
    cols.push(col);
  }
  return cols;
}

/** Flips true then back to false after `durationMs` — drives the brief "Saved" state a button shows after a successful save, on the Sensors, PINs, and Delays screens. */
export function useTransientFlag(durationMs = 3000) {
  const [active, setActive] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const trigger = useCallback(() => {
    setActive(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setActive(false), durationMs);
  }, [durationMs]);

  return [active, trigger] as const;
}

import type Database from "better-sqlite3";
import { getConfigValue } from "./config";

/**
 * UniFi Alarm Manager fires this webhook on every sensor event, regardless
 * of arm state — the exact JSON shape depends on the console
 * (see README, "Settings and config keys"), so the field locations are config-mapped rather
 * than hard-coded, and an unrecognized shape is tolerated, not fatal.
 */

export interface ParsedSensorEvent {
  sensorId: string;
  eventType?: string;
}

const DEFAULT_SENSOR_ID_PATH = "sensorId";
const DEFAULT_EVENT_TYPE_PATH = "eventType";

const RAW_PAYLOAD_LIMIT = 20;

interface WebhookIntakeState {
  recentPayloads: { ts: string; raw: string }[];
  lastWebhookAt: number | null;
  bootAt: number;
  /** Which source last delivered a sensor event — "the feed" is now the webhook OR the realtime stream (see sensor-ingest.ts). */
  lastEventSource: "webhook" | "stream" | null;
}

// Written by /api/hooks/sensor's route handler, read by /api/health and by
// checkConnectivity() (driven by instrumentation.ts's scheduler) — each
// compiles into its own Turbopack/webpack bundle, so a plain module-scoped
// variable gave each its own copy: a real webhook arriving would never be
// visible outside the bundle that received it, and /api/health's
// lastWebhookAgeSec (and the Connectivity watchdog's sensor heartbeat) would
// stay stuck at null forever regardless of whether webhooks were actually
// arriving. Same fix as lib/db/index.ts's getDb() and
// connectivity-watchdog.ts's own status — live on globalThis instead.
declare global {
  var __uapWebhookIntake: WebhookIntakeState | undefined;
}

function getState(): WebhookIntakeState {
  if (!globalThis.__uapWebhookIntake) {
    globalThis.__uapWebhookIntake = { recentPayloads: [], lastWebhookAt: null, bootAt: Date.now(), lastEventSource: null };
  }
  return globalThis.__uapWebhookIntake;
}

/**
 * Stamps the feed heartbeat for a sensor event from either source. The
 * webhook additionally records its raw body (recordRawPayload below); the
 * realtime stream has no raw body to keep, just the fact that it delivered.
 */
export function recordSensorEvent(source: "webhook" | "stream"): void {
  const state = getState();
  state.lastWebhookAt = Date.now();
  state.lastEventSource = source;
}

export function getLastEventSource(): "webhook" | "stream" | null {
  return getState().lastEventSource;
}

export function recordRawPayload(raw: string): void {
  const state = getState();
  state.lastWebhookAt = Date.now();
  state.recentPayloads.push({ ts: new Date(state.lastWebhookAt).toISOString(), raw });
  if (state.recentPayloads.length > RAW_PAYLOAD_LIMIT) state.recentPayloads.shift();
}

export function getRecentRawPayloads(): { ts: string; raw: string }[] {
  return [...getState().recentPayloads];
}

/**
 * Seconds of silence on the sensor feed — measured from process start when
 * no webhook has arrived yet, never null. A null here used to mean "nothing
 * received", which every caller read as "nothing wrong": a feed that was
 * dead across a restart stayed invisible forever (confirmed live — two days
 * of door openings with lastWebhookAgeSec: null and a watchdog reporting
 * healthy). Silence since boot is exactly as alarming as silence since the
 * last event, so it is counted the same way; hasEverReceivedWebhook()
 * carries the "which kind of silence" nuance for the UI copy.
 */
export function getLastWebhookAgeSec(): number {
  const { lastWebhookAt, bootAt } = getState();
  return Math.floor((Date.now() - (lastWebhookAt ?? bootAt)) / 1000);
}

export function hasEverReceivedWebhook(): boolean {
  return getState().lastWebhookAt !== null;
}

function getByPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object" && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

const MAX_SENSOR_ID_LENGTH = 128;

export function parseSensorWebhook(db: Database.Database, body: unknown): ParsedSensorEvent | null {
  const sensorIdPath = getConfigValue(db, "webhookSensorIdPath") ?? DEFAULT_SENSOR_ID_PATH;
  const eventTypePath = getConfigValue(db, "webhookEventTypePath") ?? DEFAULT_EVENT_TYPE_PATH;

  const sensorIdRaw = getByPath(body, sensorIdPath);
  // Only a string or a number can name a sensor: an object or array would collapse to "[object Object]" or "a,b" and register as a sensor row. The length cap matches the go2rtc stream-name shape (isSafeStreamName).
  if (typeof sensorIdRaw !== "string" && typeof sensorIdRaw !== "number") return null;
  const sensorId = String(sensorIdRaw).trim();
  if (sensorId === "" || sensorId.length > MAX_SENSOR_ID_LENGTH) return null;

  const eventTypeRaw = getByPath(body, eventTypePath);
  return {
    sensorId,
    eventType: eventTypeRaw !== undefined && eventTypeRaw !== null ? String(eventTypeRaw) : undefined,
  };
}

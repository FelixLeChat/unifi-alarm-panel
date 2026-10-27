import type Database from "better-sqlite3";
import type { AlarmEngine } from "@/lib/engine";
import { logger } from "@/lib/logger";
import { recordAudit } from "./audit";
import { ingestSensorTrip } from "./sensor-ingest";
import { resolveSensorMode, updateSensorState } from "./sensors";
import { parseSensorWebhook, recordRawPayload } from "./webhook-intake";

export interface WebhookResult {
  status: number;
  body: { ok: boolean };
}

/**
 * The engine (not this function) decides what a trip means — armed vs.
 * disarmed, delayed vs. instant. This just gets a raw UniFi payload into a
 * (sensorId, mode) pair without ever throwing, however malformed the body.
 */
export function handleSensorWebhook(db: Database.Database, engine: AlarmEngine, rawBody: string): WebhookResult {
  recordRawPayload(rawBody);
  logger.debug({ raw: rawBody }, "sensor webhook received");

  let json: unknown = null;
  try {
    json = rawBody ? JSON.parse(rawBody) : null;
  } catch {
    json = null;
  }

  const parsed = parseSensorWebhook(db, json);
  if (!parsed) {
    // The raw body is the whole point here — without it, "why didn't this
    // register" is unanswerable from the audit log alone. Truncated as a
    // safety net against a pathological payload, not because it's expected.
    recordAudit(db, "webhook_unparseable", { detail: { raw: rawBody.slice(0, 2000) } });
    // Ack anyway so UniFi doesn't treat this as a failed delivery and retry-storm us.
    return { status: 200, body: { ok: true } };
  }

  const mode = resolveSensorMode(db, parsed.sensorId, parsed.eventType);
  const openState = updateSensorState(db, parsed.sensorId, parsed.eventType);
  // A door closing updates the state that gates arming and stops there, the same rule the realtime stream applies (see classifyStreamEvent). Only a deployment that configured sensorClosedEventTypes can tell a close apart.
  if (openState === "closed") return { status: 200, body: { ok: true } };
  // Via the shared ingest so a trip the realtime stream just delivered for
  // this same sensor isn't counted twice (see sensor-ingest.ts).
  ingestSensorTrip(engine, parsed.sensorId, mode, "webhook");
  return { status: 200, body: { ok: true } };
}

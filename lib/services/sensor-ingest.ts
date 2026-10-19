import type { AlarmEngine } from "@/lib/engine";
import type { SensorMode } from "@/lib/state/machine";
import { logger } from "@/lib/logger";
import { recordSensorEvent } from "./webhook-intake";

/**
 * The one door every sensor trip walks through, whichever source saw it: the
 * UniFi Alarm Manager webhook (lib/services/sensor-webhook.ts) or the
 * console's realtime event stream (lib/services/protect-event-stream.ts).
 *
 * There are two sources on purpose. The webhook is a push this app cannot
 * see the health of — an automation on a console we don't control, with no
 * delivery receipt — and it silently stopped for four days while every
 * sensor, the console, and its event log were demonstrably fine. The stream
 * is this app pulling the same occurrences itself. Either one alone keeps
 * the alarm working; both together mean one failing is a degraded mode, not
 * a blind one.
 */

export type TripSource = "webhook" | "stream";

/**
 * How long after a trip from one source the same sensor's trip from the
 * *other* source is treated as the same physical event. Both sources
 * describe the same door opening, and the engine must see it once.
 *
 * Deliberately only cross-source: two trips from the same source are two
 * events, exactly as they were before the second source existed. A motion
 * sensor re-reporting every 8 seconds keeps every one of those trips.
 */
const CROSS_SOURCE_WINDOW_MS = 5_000;

interface LastTrip {
  at: number;
  source: TripSource;
}

// globalThis for the same bundle-splitting reason as getDb()/getEngine():
// the webhook arrives in a route handler's bundle and the stream runs in
// instrumentation.ts's, so a module-scoped Map would give each its own copy
// and the two sources would never see each other's trips — which is exactly
// the state this de-duplication exists to prevent.
declare global {
  var __uapLastTripBySensor: Map<string, LastTrip> | undefined;
}

function lastTrips(): Map<string, LastTrip> {
  if (!globalThis.__uapLastTripBySensor) globalThis.__uapLastTripBySensor = new Map();
  return globalThis.__uapLastTripBySensor;
}

/** Exported for tests; the process only ever has one of these. */
export function resetTripDedupe(): void {
  globalThis.__uapLastTripBySensor = new Map();
}

export function isCrossSourceDuplicate(unifiId: string, source: TripSource, now = Date.now()): boolean {
  const previous = lastTrips().get(unifiId);
  return previous !== undefined && previous.source !== source && now - previous.at < CROSS_SOURCE_WINDOW_MS;
}

/**
 * Hands one trip to the state machine, unless the other source already
 * delivered the same physical event a moment ago. Returns whether the
 * engine saw it.
 */
export function ingestSensorTrip(
  engine: AlarmEngine,
  unifiId: string,
  mode: SensorMode,
  source: TripSource,
): boolean {
  const now = Date.now();
  // Stamped even for a duplicate: the feed is demonstrably alive either way,
  // and the heartbeat's question is "is anything arriving", not "was this
  // trip novel".
  recordSensorEvent(source);

  if (isCrossSourceDuplicate(unifiId, source, now)) {
    logger.debug({ unifiId, source }, "sensor trip already seen from the other source");
    return false;
  }

  // Stamped after the engine took it: if handleSensorTrip throws, the other source's copy must still count.
  engine.handleSensorTrip(unifiId, mode);
  lastTrips().set(unifiId, { at: now, source });
  return true;
}

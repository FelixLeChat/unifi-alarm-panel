import type Database from "better-sqlite3";
import type { ProtectClient, TypedEvent } from "unifi-protect";
import type { AlarmEngine } from "@/lib/engine";
import { logger } from "@/lib/logger";
import { getCredentials } from "./protect-alarm-sync";
import { getProtectDispatcher, isProtectTlsInsecure } from "./protect-tls";
import { getSetting } from "./settings";
import { normalizeMac } from "./protect-device-health";
import { ingestSensorTrip } from "./sensor-ingest";
import { resolveSensorModeForDevice, setSensorState } from "./sensors";

/**
 * A second, pull-based source for sensor trips: the console's own realtime
 * event WebSocket, the same stream Protect's UI renders its activity list
 * from, via the reverse-engineered `unifi-protect` package (already a
 * dependency).
 *
 * Why this exists alongside the webhook: the Alarm Manager webhook is a
 * push from a console this app does not control, configured in a UI, with
 * no delivery receipt of any kind. It stopped for four days while every
 * sensor was healthy, the console was recording every motion and door event
 * in its own log, and this app sat silent — with no way to tell "the office
 * is quiet" from "the feed is dead". Nothing about that failure is fixable
 * from this side; the only real answer is to stop depending on it alone.
 *
 * What the two sources see differently:
 *
 * - A physical sensor (UP-Sense) reports through `devicePatched` on the
 *   `sensor` model key — `isMotionDetected` / `isOpened` booleans on the
 *   device record, not an occurrence.
 * - A camera's motion arrives as a `motionDetected` occurrence, keyed by
 *   the camera's Protect id rather than its MAC.
 *
 * Both are translated to the same (MAC, mode) pair a webhook produces, and
 * handed to the same ingest (sensor-ingest.ts), which de-duplicates across
 * the two sources. The alarm's behavior does not depend on which one won.
 */

/**
 * What one realtime event means to the alarm: which device, whether it
 * trips, and what it says about a door's open state. One shape rather than
 * two independent ones, so a device is registered exactly once, with its
 * real name — resolving the trip and the state change separately named the
 * first-registered row after its MAC.
 */
export interface StreamSensorEvent {
  unifiId: string;
  name?: string;
  isCamera: boolean;
  trips: boolean;
  openState?: "open" | "closed";
}

export interface EventStreamDeps {
  db: Database.Database;
  engine: AlarmEngine;
}

/**
 * Whether this second source is actually up — previously invisible: a dead
 * stream (bad credential, console unreachable) looked identical to "no
 * events right now" from the outside, silently falling back to
 * webhook-only reliability with nothing in the UI or an alert saying so.
 * Same globalThis reasoning as connectivity-watchdog.ts's own status.
 */
export type StreamStatus = "disabled" | "connected" | "disconnected";

interface StreamState {
  status: StreamStatus;
  lastError: string | null;
  connectedAt: string | null;
}

declare global {
  var __uapStreamState: StreamState | undefined;
}

function setStreamState(status: StreamStatus, lastError: string | null = null): void {
  const previous = globalThis.__uapStreamState;
  globalThis.__uapStreamState = {
    status,
    lastError,
    connectedAt: status === "connected" ? new Date().toISOString() : (previous?.connectedAt ?? null),
  };
}

export function getStreamStatus(): StreamState {
  return globalThis.__uapStreamState ?? { status: "disabled", lastError: null, connectedAt: null };
}

interface DeviceRef {
  mac: string;
  name?: string;
}

/**
 * Protect addresses devices by its own id on the wire; this app keys
 * sensors by MAC (what the webhook reports). The map comes from the
 * client's own state snapshot, refreshed whenever the controller re-sends a
 * bootstrap or adds a device.
 */
export function buildDeviceIndex(client: ProtectClient): Map<string, DeviceRef> {
  const index = new Map<string, DeviceRef>();
  const state = client.state.snapshot();
  // Both collections are id-keyed ReadonlyMaps, not plain objects — worth
  // stating, because treating them as objects silently indexes nothing.
  for (const device of [...state.cameras.values(), ...state.sensors.values()]) {
    if (device.id && device.mac) index.set(device.id, { mac: normalizeMac(device.mac), name: device.name });
  }
  return index;
}

/**
 * Translates one realtime event into what the alarm should do about it, or
 * null for the great majority that mean nothing to it (battery levels,
 * signal changes, recording settings). Pure — every decision this makes is
 * testable without a console.
 */
export function classifyStreamEvent(event: TypedEvent, devices: Map<string, DeviceRef>): StreamSensorEvent | null {
  if (event.kind === "motionDetected") {
    const device = devices.get(event.cameraId);
    // An unknown id means the index is behind the controller; skipping is
    // right — inventing a sensor row from an id this app can't name would
    // put an unidentifiable entry in the alarm's own sensor list.
    if (!device) return null;
    return { unifiId: device.mac, name: device.name, isCamera: true, trips: true };
  }

  if (event.kind === "devicePatched" && event.modelKey === "sensor") {
    const device = devices.get(event.id);
    if (!device) return null;
    const patch = event.patch as { isMotionDetected?: boolean; isOpened?: boolean };
    const base = { unifiId: device.mac, name: device.name, isCamera: false };

    if (patch.isOpened === true) return { ...base, trips: true, openState: "open" };
    // A door closing updates the state that gates arming, and stops there.
    if (patch.isOpened === false) return { ...base, trips: false, openState: "closed" };
    if (patch.isMotionDetected === true) return { ...base, trips: true };
  }

  return null;
}

function handleEvent(event: TypedEvent, devices: Map<string, DeviceRef>, deps: EventStreamDeps): void {
  const classified = classifyStreamEvent(event, devices);
  if (!classified) return;

  const { db, engine } = deps;
  const { unifiId, name, isCamera, trips, openState } = classified;
  // Registers the row (named, and self-mapped to its own camera where that
  // applies) the first time this device is seen, exactly as the webhook
  // path does; an already-known sensor keeps whatever mode an admin set.
  const mode = resolveSensorModeForDevice(db, unifiId, isCamera, name);
  if (openState) setSensorState(db, unifiId, openState);
  if (trips) ingestSensorTrip(engine, unifiId, mode, "stream");
}

/**
 * Consumes the firehose until the signal aborts. Exported separately from
 * the connect/retry loop so the mapping can be driven by a fake client in
 * tests — the part that must be right is which events become trips, and
 * that shouldn't need a controller to exercise.
 */
export async function consumeEventStream(
  client: ProtectClient,
  deps: EventStreamDeps,
  signal?: AbortSignal,
): Promise<void> {
  let devices = buildDeviceIndex(client);
  logger.info({ devices: devices.size }, "Protect event stream connected");
  setStreamState("connected");

  for await (const event of client.events({ signal })) {
    try {
      // A fresh bootstrap or a newly adopted device can rename or renumber
      // things; rebuild before classifying so a trip is never dropped for a
      // device the index simply hadn't heard of yet.
      if (event.kind === "bootstrapLoaded" || event.kind === "deviceAdded") devices = buildDeviceIndex(client);
      handleEvent(event, devices, deps);
    } catch (err) {
      // One malformed or unexpected event must never end the subscription —
      // that would take the whole second source down silently.
      logger.error({ err, kind: event.kind }, "Protect event stream handler threw");
    }
  }
}

const RECONNECT_DELAY_MS = 30_000;

/**
 * Connects and keeps reconnecting until the signal aborts. The library
 * recovers the events channel on its own (its ConnectionMonitor handles a
 * dropped or stalled socket); this outer loop covers the case it can't —
 * the initial connect failing because the console is unreachable or
 * rebooting, which at boot would otherwise leave this source permanently
 * off with only a log line to say so.
 */
export async function runEventStream(
  connect: () => Promise<ProtectClient>,
  deps: EventStreamDeps,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    let client: ProtectClient | null = null;
    try {
      client = await connect();
      await consumeEventStream(client, deps, signal);
      // The library's own event iterator ended without throwing (a graceful
      // close) — still means this source stopped delivering, same as a throw.
      if (!signal.aborted) setStreamState("disconnected", "event stream ended");
    } catch (err) {
      if (signal.aborted) return;
      logger.warn({ err }, "Protect event stream dropped — reconnecting");
      setStreamState("disconnected", String(err));
    } finally {
      await client?.[Symbol.asyncDispose]().catch(() => {});
    }
    if (signal.aborted) return;
    await new Promise((resolve) => setTimeout(resolve, RECONNECT_DELAY_MS));
  }
}

let running: { signature: string; controller: AbortController } | null = null;

/**
 * Starts, restarts or stops the stream to match the current settings. Off,
 * like the arm-state sync and the device health poll, unless the SuperAdmin
 * credential is configured — the same credential all three share (see
 * README's note on why this endpoint class needs SuperAdmin at all). Run by
 * the scheduler every few seconds (see protectEventStreamJob), so a console
 * change saved in the admin UI reconnects without a restart. Only
 * instrumentation.ts calls this, so the module-scoped `running` is safe.
 */
export function syncProtectEventStream(deps: EventStreamDeps): void {
  const creds = getCredentials();
  const insecure = isProtectTlsInsecure();
  const signature = creds
    ? JSON.stringify([creds.host, creds.username, creds.password, insecure, getSetting("protectCaCert")])
    : "";
  if (running?.signature === signature) return;

  running?.controller.abort();
  running = null;
  if (!creds) {
    setStreamState("disabled");
    return;
  }

  const controller = new AbortController();
  running = { signature, controller };
  void (async () => {
    const { ProtectClient } = await import("unifi-protect");
    await runEventStream(
      () =>
        ProtectClient.connect({
          host: creds.host,
          username: creds.username,
          password: creds.password,
          // The console serves a self-signed cert, and the same policy the
          // rest of the app uses applies here: trust the CA certificate
          // setting when it's set (the dispatcher carries it), and only skip
          // verification when insecure TLS explicitly says to. The
          // WebSocket upgrade can't ride the dispatcher, so it takes the
          // library's own flag — hence both. See lib/services/protect-tls.ts.
          dispatcher: getProtectDispatcher(),
          verifyTls: !insecure,
          signal: controller.signal,
        }),
      deps,
      controller.signal,
    );
  })().catch((err) => logger.error({ err }, "Protect event stream stopped"));
}

export function protectEventStreamJob(deps: EventStreamDeps) {
  return { name: "protect-event-stream", intervalMs: 15_000, run: () => syncProtectEventStream(deps) };
}

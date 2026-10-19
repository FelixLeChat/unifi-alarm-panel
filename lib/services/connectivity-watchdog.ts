import { logger } from "@/lib/logger";
import { getNotifier } from "@/lib/services/notifiers";
import { getProtectClient } from "@/lib/services/protect-client";
import { getSetting } from "@/lib/services/settings";
import { checkDeviceHealth, getDeviceHealthStatus, type DeviceHealth } from "@/lib/services/protect-device-health";
import { getStreamStatus } from "@/lib/services/protect-event-stream";
import { getLastEventSource, getLastWebhookAgeSec, hasEverReceivedWebhook } from "@/lib/services/webhook-intake";

export interface ConnectivityStatus {
  sensorHeartbeatAgeSec: number;
  sensorHeartbeatStale: boolean;
  /** false = silence measured from process start, not from a real event. */
  sensorHeartbeatEverReceived: boolean;
  cameraReachable: boolean | null; // null = PROTECT_DEFAULT_CAMERA_ID not configured / not checked yet
  checkedAt: string | null;
  /** Latest per-device liveness from UniFi (see protect-device-health.ts); empty when no SuperAdmin credential is configured. */
  devices: DeviceHealth[];
  deviceHealthCheckedAt: string | null;
  /** Is the realtime-stream fallback (protect-event-stream.ts) actually up right now — previously invisible, so a dead stream looked identical to "webhook-only is fine". */
  streamStatus: "disabled" | "connected" | "disconnected";
  /** Why the stream last dropped or failed to connect (e.g. a TLS error) — the status alone can't tell a bad cert from an unreachable console. */
  streamLastError: string | null;
  /** Which source delivered the most recent sensor event, webhook or stream — null if neither ever has. */
  lastEventSource: "webhook" | "stream" | null;
}

/** What the watchdog itself measures; the device/stream fields are merged in by the getter, read live rather than stored in this snapshot. */
type WatchdogStatus = Omit<
  ConnectivityStatus,
  "devices" | "deviceHealthCheckedAt" | "streamStatus" | "streamLastError" | "lastEventSource"
> & {
  /** Whether the current silence has already been notified — kept apart from sensorHeartbeatStale because a silence with the stream connected is logged but not notified, and must still alert if the stream later drops. */
  silenceNotified: boolean;
};

const STALE_THRESHOLD_SEC = 2 * 60 * 60;

const INITIAL_STATUS: WatchdogStatus = {
  sensorHeartbeatAgeSec: 0,
  sensorHeartbeatStale: false,
  sensorHeartbeatEverReceived: false,
  cameraReachable: null,
  checkedAt: null,
  silenceNotified: false,
};

// See the matching comment in lib/db/index.ts: instrumentation.ts (which
// drives the scheduler that calls checkConnectivity) is compiled into its
// own bundle, separate from the route handlers that call
// getConnectivityStatus() — a plain module-scoped `let` would give each its
// own copy, so the status lives on globalThis instead, same as __uapDb.
declare global {
  var __uapConnectivityStatus: WatchdogStatus | undefined;
}

export function getConnectivityStatus(): ConnectivityStatus {
  const deviceHealth = getDeviceHealthStatus();
  const stream = getStreamStatus();
  const status = { ...(globalThis.__uapConnectivityStatus ?? INITIAL_STATUS) } as Partial<WatchdogStatus>;
  delete status.silenceNotified;
  return {
    ...(status as Omit<WatchdogStatus, "silenceNotified">),
    devices: Object.values(deviceHealth.devices),
    deviceHealthCheckedAt: deviceHealth.checkedAt,
    streamStatus: stream.status,
    streamLastError: stream.lastError,
    lastEventSource: getLastEventSource(),
  };
}

/**
 * Periodic "pull sensor/camera status" system task. Reuses the webhook
 * heartbeat /api/health already tracks and the same getSnapshot() an alert
 * uses — this just polls them proactively and alerts on a state change
 * (quiet→stale, reachable→unreachable) instead of only surfacing the number
 * when something asks for it.
 *
 * The stale edge notifies, it doesn't only log: a dead sensor feed is
 * indistinguishable from a quiet office in the UI, and the one time this
 * happened for real nobody noticed for two days.
 */
export async function checkConnectivity(): Promise<void> {
  const previous = getConnectivityStatus();
  const previousSilenceNotified = globalThis.__uapConnectivityStatus?.silenceNotified ?? false;
  const sensorHeartbeatAgeSec = getLastWebhookAgeSec();
  const sensorHeartbeatEverReceived = hasEverReceivedWebhook();
  const sensorHeartbeatStale = sensorHeartbeatAgeSec > STALE_THRESHOLD_SEC;
  const streamStatus = getStreamStatus().status;
  if (sensorHeartbeatStale && !previous.sensorHeartbeatStale) {
    logger.warn({ sensorHeartbeatAgeSec, streamStatus }, "sensor webhook heartbeat stale");
  }
  // A connected stream that is also silent is a quiet office, not a dead feed:
  // the stream delivers every sensor change the console sees, so only notify
  // when it isn't covering (down or disabled). Notifying on every 2h of
  // evening quiet trained everyone to ignore this alert.
  const shouldNotify = sensorHeartbeatStale && streamStatus !== "connected";
  if (shouldNotify && !previousSilenceNotified) {
    const minutes = Math.round(sensorHeartbeatAgeSec / 60);
    // Both the webhook AND the realtime stream feed the same heartbeat (see
    // sensor-ingest.ts), so this fires only when neither has seen anything —
    // but "webhook feed looks dead" used to be the message either way, which
    // read as a false alarm on a quiet office whenever the stream was in fact
    // the one that was down. Naming the stream's own state here means the
    // next time this fires, whether it's a real dead webhook (stream still
    // covering) or a genuinely blind stretch (stream also down/disabled) is
    // answered by the alert itself instead of another round of guessing.
    const streamNote =
      streamStatus === "disabled"
        ? "stream fallback is disabled (no SuperAdmin credential configured)"
        : "stream fallback is disconnected too";
    void getNotifier()
      .send({
        kind: "HEALTH",
        message: sensorHeartbeatEverReceived
          ? `No sensor events received for ${minutes} minutes (${streamNote}).`
          : `No sensor events received since this server started ${minutes} minutes ago — check the UniFi Alarm Manager webhook config (${streamNote}).`,
        at: new Date().toISOString(),
      })
      .catch((err) => logger.error({ err }, "notifier threw"));
  }

  const cameraId = getSetting("protectDefaultCameraId");
  let cameraReachable = previous.cameraReachable;
  if (cameraId) {
    cameraReachable = (await getProtectClient().getSnapshot(cameraId)) !== null;
    if (!cameraReachable && previous.cameraReachable !== false) {
      logger.warn({ cameraId }, "default camera unreachable");
    }
  }

  globalThis.__uapConnectivityStatus = {
    sensorHeartbeatAgeSec,
    sensorHeartbeatStale,
    sensorHeartbeatEverReceived,
    cameraReachable,
    checkedAt: new Date().toISOString(),
    silenceNotified: shouldNotify ? true : sensorHeartbeatStale && previousSilenceNotified,
  };
}

/** Everything the Tasks screen's "Check now" button should refresh, including the slow 2h device-health poll. */
export async function checkConnectivityNow(): Promise<void> {
  await Promise.all([checkConnectivity(), checkDeviceHealth()]);
}

export const connectivityWatchdogJob = {
  name: "connectivity-watchdog",
  intervalMs: 5 * 60 * 1000,
  run: checkConnectivity,
};

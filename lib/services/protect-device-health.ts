import { logger } from "@/lib/logger";
import { getDb } from "@/lib/db";
import { recordAudit } from "./audit";
import { getNotifier } from "./notifiers";
import { getClient, getCredentials, ProtectAlarmPermissionError } from "./protect-alarm-sync";

/**
 * Per-device liveness pulled from UniFi's *private* Protect API
 * (`/proxy/protect/api/sensors`, `/proxy/protect/api/cameras`) — the same
 * SuperAdmin credential and session the Alarm Manager arm-state sync
 * already uses (see protect-alarm-sync.ts).
 *
 * Why not the documented Integration API: it exposes cameras only, with no
 * `mac` field (see isCameraTriggerEvent's comment in sensors.ts), so a
 * device record there can't be matched to a sensor row at all. The private
 * collections carry `mac` — which is exactly what a webhook reports as its
 * device id — plus `isConnected`, the radio signal, `upSince`, `lastSeen`
 * and, for physical sensors, `batteryStatus`. That's a real liveness signal,
 * unlike "has this sensor tripped lately", which only measures office traffic.
 *
 * These are the same records the Protect UI's own device list renders from,
 * so the green dot / signal bars / battery icon there and the status here
 * read the same numbers. One caveat learned against the live console:
 * `lastSeen` is NOT what the UI's green dot reflects — sensors sitting at a
 * healthy -63 dBm reported a `lastSeen` four days old, so treat it as "last
 * reported activity", never as "last contact".
 *
 * Polled slowly on purpose (2h): a flat battery or an unadopted sensor is a
 * days-long condition, not a seconds-long one, and this costs a SuperAdmin
 * login where the rest of the app deliberately doesn't use one.
 */
export interface DeviceHealth {
  mac: string;
  name: string;
  kind: "sensor" | "camera";
  online: boolean;
  lastSeenAt: string | null;
  batteryPercent: number | null;
  batteryLow: boolean;
  tampered: boolean;
  /** Radio signal in dBm — the bars the Protect UI draws next to each device. Null for a wired camera. */
  signalDbm: number | null;
  /** When the device last came up. Moves on a reconnect, so a recent value means the link dropped recently. */
  upSince: string | null;
}

export interface DeviceHealthStatus {
  /** Keyed by normalized MAC — the same form a sensor row's unifiId takes. */
  devices: Record<string, DeviceHealth>;
  checkedAt: string | null;
  /** Non-null when the last poll failed; the previous device map is kept as-is. */
  error: string | null;
}

interface RawDevice {
  mac?: string;
  name?: string;
  isConnected?: boolean;
  state?: string;
  lastSeen?: number | null;
  upSince?: number | null;
  batteryStatus?: { isLow?: boolean; percentage?: number | null } | null;
  tamperingDetectedAt?: number | null;
  // Where the signal lives depends on the radio: Bluetooth for a UP-Sense,
  // LoRa for a relay/fob, wifi for a wireless camera. Same number the
  // Protect UI renders as bars, whichever one carries it.
  bluetoothConnectionState?: { signalStrength?: number | null } | null;
  wirelessConnectionState?: { signalState?: { signalStrength?: number | null } | null } | null;
  wifiConnectionState?: { signalStrength?: number | null } | null;
}

const INITIAL_STATUS: DeviceHealthStatus = { devices: {}, checkedAt: null, error: null };

// Same globalThis reasoning as connectivity-watchdog.ts's own status: the
// scheduler (instrumentation.ts) and the route handlers that read this
// compile into separate bundles, so a module-scoped `let` would give each
// its own copy and the poll's result would never reach the admin UI.
declare global {
  var __uapDeviceHealth: DeviceHealthStatus | undefined;
}

export function getDeviceHealthStatus(): DeviceHealthStatus {
  return globalThis.__uapDeviceHealth ?? INITIAL_STATUS;
}

/** UniFi reports `58:d6:1f:49:a7:15`; a webhook reports `58D61F49A715`. */
export function normalizeMac(mac: string): string {
  return mac.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
}

export function toDeviceHealth(raw: RawDevice, kind: "sensor" | "camera"): DeviceHealth | null {
  if (!raw.mac) return null;
  return {
    mac: normalizeMac(raw.mac),
    name: raw.name ?? raw.mac,
    kind,
    // `isConnected` is the field both collections carry; `state` is the
    // human-facing string ("CONNECTED"/"DISCONNECTED") and is only consulted
    // when the boolean is missing, rather than assuming either one is always
    // present on every firmware.
    online: raw.isConnected ?? (raw.state ? raw.state.toUpperCase() === "CONNECTED" : false),
    lastSeenAt: raw.lastSeen ? new Date(raw.lastSeen).toISOString() : null,
    batteryPercent: raw.batteryStatus?.percentage ?? null,
    batteryLow: raw.batteryStatus?.isLow === true,
    tampered: raw.tamperingDetectedAt != null,
    signalDbm:
      raw.bluetoothConnectionState?.signalStrength ??
      raw.wirelessConnectionState?.signalState?.signalStrength ??
      raw.wifiConnectionState?.signalStrength ??
      null,
    upSince: raw.upSince ? new Date(raw.upSince).toISOString() : null,
  };
}

/**
 * One line per newly-degraded device, comparing this poll against the last
 * one — the edge, not the level, so a sensor that's been offline for a week
 * doesn't re-alert every 2 hours. A device that was unknown before (first
 * poll after a restart) still counts as an edge if it's degraded now:
 * a restart must not swallow a condition that's still true.
 */
export function degradations(previous: Record<string, DeviceHealth>, current: Record<string, DeviceHealth>): string[] {
  const lines: string[] = [];
  for (const [mac, device] of Object.entries(current)) {
    const before = previous[mac];
    if (!device.online && before?.online !== false) {
      lines.push(`${device.name} (${mac}) is offline in UniFi Protect`);
    }
    if (device.batteryLow && before?.batteryLow !== true) {
      lines.push(
        `${device.name} (${mac}) has a low battery${device.batteryPercent != null ? ` (${device.batteryPercent}%)` : ""}`,
      );
    }
    if (device.tampered && before?.tampered !== true) {
      lines.push(`${device.name} (${mac}) reported tampering`);
    }
  }
  return lines;
}

export async function checkDeviceHealth(): Promise<void> {
  const creds = getCredentials();
  // Same opt-in as the arm-state sync: no SuperAdmin credential configured
  // means this is a no-op rather than an error, and the admin UI just has
  // no device health to show.
  if (!creds) return;

  const client = getClient(creds);
  let devices: Record<string, DeviceHealth>;
  try {
    const [sensors, cameras] = await Promise.all([
      client.authedGet<RawDevice[]>("/proxy/protect/api/sensors", "sensors"),
      client.authedGet<RawDevice[]>("/proxy/protect/api/cameras", "cameras"),
    ]);
    devices = {};
    for (const [raw, kind] of [
      ...sensors.map((s) => [s, "sensor"] as const),
      ...cameras.map((c) => [c, "camera"] as const),
    ]) {
      const device = toDeviceHealth(raw, kind);
      if (device) devices[device.mac] = device;
    }
  } catch (err) {
    if (err instanceof ProtectAlarmPermissionError) {
      logger.error({ err }, "Protect device health poll misconfigured");
    } else {
      logger.warn({ err }, "Protect device health poll failed");
    }
    const previous = getDeviceHealthStatus();
    globalThis.__uapDeviceHealth = { ...previous, error: String(err), checkedAt: new Date().toISOString() };
    return;
  }

  const previous = getDeviceHealthStatus();
  globalThis.__uapDeviceHealth = { devices, checkedAt: new Date().toISOString(), error: null };

  for (const line of degradations(previous.devices, devices)) {
    logger.warn({ line }, "device health degraded");
    recordAudit(getDb(), "device_health_degraded", { actorLabel: "UniFi", detail: { message: line } });
    void getNotifier()
      .send({ kind: "HEALTH", message: line, at: new Date().toISOString() })
      .catch((err) => logger.error({ err }, "notifier threw"));
  }
}

export const protectDeviceHealthJob = {
  name: "protect-device-health",
  intervalMs: 2 * 60 * 60 * 1000,
  run: checkDeviceHealth,
};

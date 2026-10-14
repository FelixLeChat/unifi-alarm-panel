export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { z } from "zod";
import { verifyAdminToken } from "@/lib/auth/admin";
import { getDb } from "@/lib/db";
import { getLastArmDisarmEvent, recordAudit } from "@/lib/services/audit";
import { listConfig, setConfigValue } from "@/lib/services/config";
import { removeGo2rtcStream, upsertGo2rtcStream } from "@/lib/services/go2rtc-client";
import { getDeviceHealthStatus, normalizeMac } from "@/lib/services/protect-device-health";
import { deleteSensor, getSensor, listSensors, upsertSensor } from "@/lib/services/sensors";
import { getLastWebhookAgeSec, hasEverReceivedWebhook } from "@/lib/services/webhook-intake";

// Keys whose value must parse as a sane number. The Delays and Settings
// screens bound their own inputs, but the Settings screen's Advanced table
// writes arbitrary key/value pairs straight through — and a NaN or
// past-32-bit delay reaches setTimeout, which clamps both to ~1ms: no exit
// delay at all, or an entry delay that alarms the instant a door opens.
// getDelays()/rate-limit.ts clamp defensively too; this is the layer that
// gives the admin a 400 instead of silently storing something dangerous.
const NUMERIC_CONFIG_KEYS: Record<string, { min: number; max: number }> = {
  exitDelaySec: { min: 0, max: 3600 },
  entryDelaySec: { min: 0, max: 3600 },
  externalArmSyncDelaySec: { min: 0, max: 3600 },
  rateLimitMaxAttempts: { min: 1, max: 100 },
  rateLimitWindowSec: { min: 1, max: 86_400 },
  rateLimitLockoutSec: { min: 1, max: 86_400 },
};

function invalidNumericKey(config: Record<string, string | number>): string | null {
  for (const [key, value] of Object.entries(config)) {
    const bounds = NUMERIC_CONFIG_KEYS[key];
    if (!bounds) continue;
    // Rejected explicitly: Number("") is 0, which would otherwise sail through
    // a min of 0 and store a cleared field as "no delay at all".
    if (typeof value === "string" && value.trim() === "") return key;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < bounds.min || parsed > bounds.max) return key;
  }
  return null;
}

const configPutSchema = z.object({
  config: z.record(z.string().min(1), z.union([z.string(), z.number()])).optional(),
  sensors: z
    .array(
      z.object({
        unifiId: z.string().trim().min(1),
        name: z.string().trim().min(1).optional(),
        mode: z.enum(["delayed", "instant", "ignore"]),
        cameraId: z.string().trim().min(1).nullable().optional(),
        // rtsp:// and rtsps:// both accepted — go2rtc-client.ts only rewrites
        // the latter (UniFi's self-signed-cert workaround), a plain rtsp://
        // source is a legitimate input too (e.g. non-UniFi cameras, testing).
        // Anything else (an http(s) live-view link, a snapshot URL, ...) is a
        // paste-the-wrong-thing mistake best caught here, not several layers
        // deep in a go2rtc/ffmpeg error.
        rtspUrl: z
          .string()
          .trim()
          .min(1)
          .regex(/^rtsps?:\/\//, "must start with rtsp:// or rtsps://")
          .nullable()
          .optional(),
        sensorType: z.enum(["motion", "door"]).nullable().optional(),
      }),
    )
    .optional(),
});

// Same 15-minute threshold the connectivity watchdog alerts on — a feed
// this quiet means the sensor dots below it are reporting nothing at all.
const SENSOR_FEED_STALE_SEC = 15 * 60;

export async function GET(req: Request) {
  if (!verifyAdminToken(req)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const db = getDb();
  // Device liveness and the feed heartbeat ride along with the sensor list
  // rather than getting their own fetch: the Sensors screen can't render an
  // honest status dot without both (see sensorHealth in app/admin/shared.ts),
  // and a sensor row on its own only ever knew how busy the office was.
  const deviceHealth = getDeviceHealthStatus().devices;
  const sensors = listSensors(db).map((sensor) => {
    const device = deviceHealth[normalizeMac(sensor.unifiId)] ?? null;
    return {
      ...sensor,
      device: device
        ? {
            online: device.online,
            lastSeenAt: device.lastSeenAt,
            batteryPercent: device.batteryPercent,
            batteryLow: device.batteryLow,
            tampered: device.tampered,
            signalDbm: device.signalDbm,
          }
        : null,
    };
  });
  const ageSec = getLastWebhookAgeSec();
  return NextResponse.json({
    config: listConfig(db),
    sensors,
    lastArmDisarm: getLastArmDisarmEvent(db),
    sensorFeed: { ageSec, stale: ageSec > SENSOR_FEED_STALE_SEC, everReceived: hasEverReceivedWebhook() },
  });
}

export async function PUT(req: Request) {
  if (!verifyAdminToken(req)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const parsed = configPutSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  const config = parsed.data.config ?? {};
  const badKey = invalidNumericKey(config);
  if (badKey) {
    const { min, max } = NUMERIC_CONFIG_KEYS[badKey];
    return NextResponse.json({ ok: false, error: `${badKey} must be a number between ${min} and ${max}` }, { status: 400 });
  }

  const db = getDb();
  for (const [key, value] of Object.entries(config)) {
    setConfigValue(db, key, String(value));
  }
  for (const sensor of parsed.data.sensors ?? []) {
    upsertSensor(db, sensor.unifiId, sensor.name, sensor.mode, sensor.cameraId, sensor.rtspUrl, sensor.sensorType);

    // Keep go2rtc's stream registry in sync with the saved rtspUrl. A go2rtc
    // hiccup logs a warning but never fails this request — same reasoning as
    // protect-client's snapshot fetches (upsert/removeGo2rtcStream never throw).
    if (sensor.rtspUrl !== undefined) {
      const saved = getSensor(db, sensor.unifiId);
      const streamName = saved?.cameraId ?? sensor.unifiId;
      if (sensor.rtspUrl) {
        await upsertGo2rtcStream(streamName, sensor.rtspUrl);
      } else {
        await removeGo2rtcStream(streamName);
      }
    }
  }
  recordAudit(db, "config_updated", {
    detail: { configKeys: Object.keys(config), sensorIds: (parsed.data.sensors ?? []).map((s) => s.unifiId) },
  });

  return NextResponse.json({ config: listConfig(db), sensors: listSensors(db) });
}

export async function DELETE(req: Request) {
  if (!verifyAdminToken(req)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const unifiId = new URL(req.url).searchParams.get("unifiId");
  if (!unifiId) {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  const db = getDb();
  const existing = getSensor(db, unifiId);
  deleteSensor(db, unifiId);
  if (existing?.rtspUrl) {
    await removeGo2rtcStream(existing.cameraId ?? existing.unifiId);
  }
  recordAudit(db, "sensor_deleted", { detail: { unifiId } });
  return NextResponse.json({ ok: true });
}

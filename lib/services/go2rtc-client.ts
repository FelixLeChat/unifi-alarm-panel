import type Database from "better-sqlite3";
import { logger } from "@/lib/logger";
import { listSensors } from "./sensors";
import { getSetting } from "./settings";

/**
 * Talks to the go2rtc sidecar's local HTTP API (see deploy/go2rtc.yaml) to
 * register/unregister live camera streams and to build the URL this server
 * proxies for the admin UI's MJPEG preview. go2rtc itself does the
 * RTSPS->browser work (see README for the deploy-side setup); this file is
 * just the thin client, same shape as protect-client.ts.
 */
function baseUrl(): string {
  return (getSetting("go2rtcApiBaseUrl") ?? "http://127.0.0.1:1984").replace(/\/+$/, "");
}

/**
 * UniFi's RTSPS URLs use a self-signed cert that go2rtc's own TLS
 * verification rejects. go2rtc's documented workaround for UniFi
 * specifically: use `rtspx://` instead of `rtsps://` (skips verification)
 * and drop the `?enableSrtp` suffix, which that scheme doesn't support.
 * https://github.com/AlexxIT/go2rtc/blob/master/internal/rtsp/README.md
 */
export function toGo2rtcSource(rtspUrl: string): string {
  const url = new URL(rtspUrl.replace(/^rtsps:\/\//, "rtspx://"));
  url.searchParams.delete("enableSrtp");
  return url.toString();
}

/**
 * Registers (or replaces) a camera's live stream under `name`. Two
 * producers, not one: the direct RTSPS pull only carries H264, and go2rtc's
 * MJPEG output needs an actual JPEG/raw producer to encode from — verified
 * against a real go2rtc instance, which rejects an MJPEG consumer on an
 * H264-only stream with "codecs not matched: video:H264 => video:JPEG,
 * video:RAW". The second producer transcodes via go2rtc's own ffmpeg
 * integration, pulling from this stream's first producer by name (so ffmpeg
 * only ever talks to go2rtc on localhost, never touching the camera's TLS
 * directly) — same pattern as internal/mjpeg/README.md's "both H264 and
 * MJPEG codecs" example. Repeating the `src` param registers both producers
 * in one call (also verified directly against go2rtc — a second PUT with
 * the same name replaces rather than adds to the producer list).
 *
 * Never throws — a failed registration must not block saving the sensor.
 */
export async function upsertGo2rtcStream(name: string, rtspUrl: string): Promise<boolean> {
  const params = new URLSearchParams({ name });
  params.append("src", toGo2rtcSource(rtspUrl));
  params.append("src", `ffmpeg:${name}#video=mjpeg`);
  try {
    const res = await fetch(`${baseUrl()}/api/streams?${params}`, { method: "PUT" });
    if (!res.ok) logger.warn({ name, status: res.status }, "go2rtc stream registration failed");
    return res.ok;
  } catch (err) {
    logger.warn({ err, name }, "go2rtc stream registration threw");
    return false;
  }
}

/** Unregisters a camera's live stream. Never throws — same reasoning as upsertGo2rtcStream. */
export async function removeGo2rtcStream(name: string): Promise<void> {
  try {
    const res = await fetch(`${baseUrl()}/api/streams?${new URLSearchParams({ src: name })}`, { method: "DELETE" });
    if (!res.ok) logger.warn({ name, status: res.status }, "go2rtc stream removal failed");
  } catch (err) {
    logger.warn({ err, name }, "go2rtc stream removal threw");
  }
}

/**
 * go2rtc's stream registry is in-memory and doesn't survive its own
 * restart (a separate process/service from this app — see
 * deploy/unifi-alarm-panel-go2rtc.service) — until now, the only way to
 * bring live view back after that was re-saving each sensor by hand in the
 * admin UI. Called once on boot (see instrumentation.ts) to re-register
 * every sensor that has an rtspUrl. Streams register in parallel and each
 * upsert never throws on its own (see upsertGo2rtcStream), so one bad
 * camera/URL can't block the rest or boot itself.
 */
export async function resyncGo2rtcStreams(db: Database.Database): Promise<void> {
  const sensors = listSensors(db).filter((s) => s.rtspUrl);
  if (sensors.length === 0) return;
  await Promise.all(sensors.map((s) => upsertGo2rtcStream(s.cameraId ?? s.unifiId, s.rtspUrl!)));
  logger.info({ count: sensors.length }, "go2rtc streams re-synced on boot");
}

/** The MJPEG endpoint this server-side proxies to the admin UI's <img> — never sent to the browser directly (go2rtc is bound to localhost, unauthenticated). */
export function go2rtcMjpegUrl(name: string): string {
  return `${baseUrl()}/api/stream.mjpeg?${new URLSearchParams({ src: name })}`;
}

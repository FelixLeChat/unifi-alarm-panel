# UniFi integration

How this app talks to UniFi, what was tried, and what is confirmed. See [INSTALL.md](INSTALL.md) for setup.

## Two sensor-event sources, on purpose

- **Webhook:** UniFi Alarm Manager posts to `POST /api/hooks/sensor`.
- **Realtime stream:** this app listens to the console's own event WebSocket (`lib/services/protect-event-stream.ts`, via the `unifi-protect` package).

The webhook alone was the original design. It failed the way pushes fail: the automation stopped delivering for four days while every sensor was healthy, and this app couldn't tell "the office is quiet" from "the feed is dead".

The stream pulls the same occurrences itself. A physical UP-Sense reports through `devicePatched` on the `sensor` model key (`isOpened` / `isMotionDetected`). A camera's motion comes as a `motionDetected` occurrence keyed by Protect id. Both map to the same (MAC, mode) pair a webhook produces.

Both sources converge on `lib/services/sensor-ingest.ts`, which drops a trip the other source already delivered for that sensor within 5s. Cross-source only, so repeated trips from one source stay separate events. Either source alone runs the alarm correctly. The stream needs the SuperAdmin credential below and is a no-op without it. A door closing updates the open/closed state that gates arming and never trips.

## Silence alerts

The connectivity watchdog alerts (Slack/ntfy `HEALTH`) after 2h without a sensor event, once, on the edge into staleness. The silence is measured from the last event or from process start, never "unknown".

If the stream is connected, silence means a quiet office: it is logged, not notified. It still alerts if the stream is down or disabled, including when the stream drops mid-silence. `GET /api/health` exposes `streamStatus`, `streamLastError` and `lastEventSource`.

If the stream never connects, check TLS first. `NODE_TLS_REJECT_UNAUTHORIZED=0` does not apply to the `unifi-protect` library's own agent. Paste the console's CA certificate, or turn on "Skip certificate check", in Settings > UniFi console instead.

## Sensor status

The dot next to each sensor in `/admin/sensors` grades its silence against its own 7-day trip cadence (`sensorHealth` in `app/admin/shared.ts`), not a fixed clock. A back door nobody uses is not a fault. A corridor sensor going quiet for a day is.

The only signal that really means "this device is broken" comes from UniFi. `lib/services/protect-device-health.ts` polls the console's private `/proxy/protect/api/sensors` and `/cameras` every 2 hours for `isConnected`, `lastSeen` and `batteryStatus`, keyed by MAC (what a webhook reports as its device id). It needs the SuperAdmin credential and is a no-op without it. `pnpm protect:device-health` prints the same data.

## UniFi's own arm/disarm state

Arming from the UniFi console (Protect app, a keypad) can't be pushed to this app by an automation. Checked against a real console (2026-09-14):

- Alarm Manager has no "system armed" or "system disarmed" trigger in any category.
- Its "Webhook" trigger is inbound only (the mechanism `sirenAlarmManagerWebhookId` uses).
- The published Integration API has zero arm/disarm endpoints.

So this app polls instead. Two private APIs were tried:

1. **`armMode` on the NVR config (dead end).** Read through [`hjdhjd/unifi-protect`](https://github.com/hjdhjd/unifi-protect). Tested live through a full disarmed, arming, armed transition: `armMode.status` never left `"disabled"`. It is the legacy Alarm Manager's field and reads `disabled` on any console migrated to the modern one, which adopting sensors forces. Same wall hit in [`sirkirby/unifi-mcp` #619](https://github.com/sirkirby/unifi-mcp/issues/619). `pnpm protect:arm-state` stays as a record of what was ruled out.
2. **`GET /api/v2/alarms/profiles` (what runs).** Each arm profile carries a `state` (`disarmed` / `arming` / `armed` / `breached`), `state_set_at` and, while arming, `state_promotion_due_at`. Confirmed live through `disarmed → arming → armed → breached → disarmed` with about 1-2s latency. Auth is a UniFi OS cookie session (`POST /api/auth/login`) plus a CSRF token from the session JWT, sent as `x-csrf-token`.

**Account requirement:** `/api/v2/alarms/*` needs a **SuperAdmin** account. A "Protect only" custom admin with the Alarm Manager permission set to `Manage` still gets a plain-text `403`. `sirkirby/unifi-mcp` documents the same result. Use a dedicated **local** UniFi OS account (Settings → Admins & Users → "Local Account Only") rather than a personal login, knowing it carries full console rights.

## How the sync works

`lib/services/protect-alarm-sync.ts` polls every 3s (`protectAlarmSyncJob`, registered in `instrumentation.ts`). Off unless the SuperAdmin account (console host, username, password) is set in Settings > UniFi console. The session is cached and re-logged only on a `401`. A `403` is logged as a permission problem and not retried.

- **Edges, not levels.** The result feeds `AlarmEngine.syncExternalArmState(armed)` only when UniFi's own state changes. Handing over the level on every poll made UniFi authoritative: arming from this app's panel (which never writes to UniFi) was undone 3s later by a still-`disarmed` console, and a PIN disarm was re-armed 3s later with the occupant inside.
- **First poll after a restart** mirrors the arming direction only. "UniFi says disarmed" can't be told apart from "this app was armed from its own panel".
- **`reduceArmState()`** ORs every profile into one armed signal and skips any state outside the observed domain. `arming` is not armed. `breached` is armed and must never collapse to "not armed".
- **No forced `ALARM` on a UniFi breach.** A real trip already reaches `ALARM` through the sensor path. A `protect_breach_detected` audit entry is recorded once on the rising edge.
- **No second exit delay.** By the time UniFi reports `armed`, its own countdown already ran. A console-triggered arm uses `externalArmSyncDelaySec` (default 5s, enough for the poll interval and clock skew) instead of `exitDelaySec`.
- **Not gated by open doors.** The sync always mirrors UniFi's state.

## Camera streaming (go2rtc)

The Sensors screen shows a static snapshot by default. Set a sensor's RTSPS URL (console: Settings → Advanced → RTSP alias) to get a live feed. That needs [go2rtc](https://github.com/AlexxIT/go2rtc) as a sidecar: `deploy/install-go2rtc.sh`, `deploy/go2rtc.yaml`, `deploy/unifi-alarm-panel-go2rtc.service`.

This app registers streams with go2rtc's local API when a sensor is saved (`lib/services/go2rtc-client.ts`) and proxies the MJPEG output to the admin `<img>` (`app/api/admin/cameras/live/route.ts`). go2rtc binds to `127.0.0.1` only.

- MJPEG needs a real `ffmpeg` on the box and go2rtc's own `rtsp: listen:` enabled on loopback (ffmpeg pulls the stream back from go2rtc). `install-go2rtc.sh` installs ffmpeg. A box provisioned before that fix registers fine, then fails at the stream request with `exec: "ffmpeg": executable file not found in $PATH` in `journalctl -u unifi-alarm-panel-go2rtc`.
- UniFi's RTSPS cert is self-signed. `toGo2rtcSource()` swaps `rtsps://` for `rtspx://` and drops `?enableSrtp`, so paste the URL as UniFi gives it.
- The stream registry is in memory and doesn't survive a go2rtc restart. The app re-registers on boot. Re-saving a sensor also does it.

## Camera ids

The console's cloud UI (`unifi.ui.com/consoles/<id>/protect/devices/<camera-id>`) shows a different id than the local Integration API's camera `_id`. Using the cloud one is the most common cause of the snapshot endpoint returning `400`. Run `pnpm protect:cameras` and use one of the `id`s it prints.

The Integration API's camera schema has no `mac` field, so camera-to-sensor matching is config-driven (`cameraTriggerEventTypes`), not inferred.

# Runbook

One page for whoever is on call, not necessarily whoever built this. See [INSTALL.md](INSTALL.md) for setup, [DEVELOPMENT.md](DEVELOPMENT.md) for dev, and [UNIFI.md](UNIFI.md) for the UniFi side.

## Add or remove a PIN

**Admin UI** (fastest): `/admin` → PINs → "Add PIN", or "Revoke" on an existing row. Needs `ADMIN_TOKEN`. PINs are exactly 4 digits and can't duplicate another PIN.

**CLI**, on the box:

```bash
pnpm pin:add "Alex" 1234
```

**Remote**, if you can reach the box over HTTP but have no shell on it: `curl -X POST http://<box>:3000/api/admin/pins -H "X-Admin-Token: <that box's ADMIN_TOKEN>" -H 'content-type: application/json' -d '{"label":"Alex","pin":"1234","isDuress":false}'`.

PINs are hashed on write and never returned by any API or shown in any UI. To replace one, revoke it and issue a new one.

## What an alert means

- **ALARM:** a sensor tripped while armed (instantly for an "instant" sensor, or after the entry delay ran out with nobody disarming). The alert (Slack, ntfy, Telegram or Signal) carries a camera snapshot and a live-view link when one is mapped. The admin header pill shows `ALARM - <sensor name>`.
- **ALARM from a PIN lockout:** too many wrong PINs at the panel. It fires whatever the arm state, and the audit log shows `alarm_pin_lockout`. Check the panel and the camera by the door.
- **DURESS:** someone disarmed with a duress PIN. **It looks and behaves like a normal disarm at the panel, on purpose.** The only places it shows are the separate "DURESS" Slack/ntfy message and the raw event type in the audit log. Treat it as someone possibly under coercion, not a false alarm.
- **HEALTH:** no sensor event for 2h and the realtime stream isn't connected, so the feed may be dead. See "Sensor events stopped" below.

## Sensor events stopped

A quiet office is normal. The `HEALTH` alert means it's quiet and this app can't see the console's own event stream either.

```bash
curl localhost:3000/api/health
```

- `lastWebhookAgeSec` is how long since the last event.
- `connectivity.streamStatus` is `connected`, `disconnected` or `disabled`. If `disconnected`, read `connectivity.streamLastError` (a TLS error means the console CA certificate or "Skip certificate check" setting is missing).
- `disabled` means the SuperAdmin account isn't set in Settings > UniFi console, so only the Alarm Manager webhook feeds the app. Check the automation in the console.

## The kiosk tablet is unreachable

The panel is a web page (`/panel`). Arming and disarming were never tied to that one tablet. Open the same URL on any phone or laptop on the office LAN. Keep a cheap spare tablet for a longer outage.

If the backend is down, the panel shows an offline banner and nothing can arm or disarm until it's back. See "The app itself is down".

## Restoring from a backup

Every PIN, the audit history, config and sensor mappings live in one SQLite file. A background job snapshots it daily to `<directory of DATABASE_PATH>/backups/alarm-YYYY-MM-DD-HHmm.db` and keeps the 14 most recent.

```bash
sudo systemctl stop unifi-alarm-panel
cp /path/to/data/backups/alarm-2026-09-01-0300.db /path/to/data/alarm.db
sudo systemctl start unifi-alarm-panel
```

Everything between that backup and now (PIN changes, audit events) is lost. This is a last resort for a corrupted DB or a bad manual edit.

## An update is stuck

"Update to latest" in the admin UI queues a request. A root-owned timer applies it within a minute (download, symlink swap, restart). If the button stays on "Update requested", the timer is probably missing or stopped:

```bash
systemctl status unifi-alarm-panel-updater.timer
```

If it's inactive or not found, install it ([INSTALL.md](INSTALL.md)) or apply the update by hand:

```bash
cd /opt/unifi-alarm-panel
./deploy/update.sh          # latest release
./deploy/update.sh v1.0.2   # a specific tag, also how you roll back
```

When an update finishes, the admin UI reloads itself within a couple of seconds.

## The app itself is down

```bash
sudo systemctl status unifi-alarm-panel
sudo journalctl -u unifi-alarm-panel -f     # live logs
curl localhost:3000/api/health                  # engine and DB status, heartbeat age, version, connectivity
```

`ok: false` means something is wrong. A stale `lastWebhookAgeSec` alone may just be a quiet office (see above). If the process is running but wedged, `sudo systemctl restart unifi-alarm-panel`. State is persisted to SQLite, and a countdown that was running resumes on its original schedule (`resumed an in-flight alarm countdown after a restart` in the log). `panel_recovered_default_disarmed` in the audit log means the stored state was unreadable and the app came up disarmed. Verify the real state.

Camera streaming (go2rtc) is a separate service and restarts independently of arm/disarm: `sudo systemctl restart unifi-alarm-panel-go2rtc`. Its stream registry doesn't survive its own restart, but the app re-registers on boot. If a stream is still dark a minute after restarting go2rtc, restart `unifi-alarm-panel` too.

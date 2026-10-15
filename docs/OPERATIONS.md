# Operations

Day-to-day running of an install: updates, the audit log, backups and the health watchdog. Install steps are in [INSTALL.md](INSTALL.md).

## Audit log

The `audit` table is append-only (a DB trigger blocks `UPDATE` and `DELETE`), so it is never pruned. The admin Audit log screen pages through it 100 events at a time. Settings changes are logged with the names of the fields that changed, never their values.

A background job (`lib/services/audit-archive.ts`, every 6h) also writes one CSV per completed day to `<directory of DATABASE_PATH>/audit-archive/audit-YYYY-MM-DD.csv`. It's a convenience export for grep or a spreadsheet, not a retention mechanism.

## Backups

The SQLite file (`DATABASE_PATH`) is the only datastore: every PIN, the audit history, settings, config and sensor mappings. `lib/services/db-backup.ts` runs once on boot, then every 24h. It writes a snapshot to `<directory of DATABASE_PATH>/backups/alarm-YYYY-MM-DD-HHmm.db` through SQLite's online backup API (safe with WAL, no need to stop the service) and keeps the 14 most recent.

To restore, stop the service, copy a backup over the live file, restart:

```bash
sudo systemctl stop unifi-alarm-panel
cp /path/to/data/backups/alarm-2026-09-01-0300.db /path/to/data/alarm.db
sudo systemctl start unifi-alarm-panel
```

Backups sit on the same disk as the live DB. They cover a bad deploy or a botched edit, not the box dying. Copy `backups/` off-box periodically (not automated), and keep `SECRETS_KEY` somewhere separate from them.

**Watchdog:** `lib/scheduler.ts` runs a connectivity watchdog every 5 minutes. It checks the sensor-feed heartbeat and, if a default camera is set, that camera's reachability. A `HEALTH` alert fires once when the feed goes 2h without an event and the realtime stream isn't connected. See [docs/UNIFI.md](UNIFI.md).

**SuperAdmin account:** the console host, username and password of a SuperAdmin local account (Settings > UniFi console) turn on the arm-state sync, the realtime stream and device health. All three are no-ops without it.

**Console self-signed cert:** paste the console's CA certificate in Settings > UniFi console, or turn on "Skip certificate check" as a last resort. Do **not** set `NODE_TLS_REJECT_UNAUTHORIZED=0`. It disables certificate verification for the whole process (Slack, ntfy, the GitHub update check), and the realtime stream ignores it anyway.

**Optional LAN TLS:** `apt install caddy`, then drop `deploy/Caddyfile` in as `/etc/caddy/Caddyfile`. It reverse-proxies to `localhost:3000` with a self-signed cert. The panel and the webhook both work over plain HTTP on a trusted LAN.

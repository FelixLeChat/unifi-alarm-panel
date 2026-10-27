# Development

How the code is laid out and how to run it locally. The rules for changes (commit format, checks, what to be careful with) are in [CONTRIBUTING.md](https://github.com/FelixLeChat/unifi-alarm-panel/blob/main/CONTRIBUTING.md).

## Repo layout

```
app/
  panel/            kiosk UI, server-rendered + public/panel.js (vanilla, no React)
  admin/            admin UI, React + shadcn/ui (eight screens and the setup wizard)
  api/              route handlers (arm/disarm/status/health, sensor webhook, admin API)
lib/
  state/            pure alarm state machine (no I/O, fully unit-tested)
  engine/           singleton wiring timers, persistence, notifier and Protect client to the state machine
  scheduler.ts      named-interval job runner for background tasks
  db/               SQLite connection + migrations
  services/         pins, audit, config, settings + secrets, sensors, notifiers/ (Slack, ntfy,
                    Telegram, Signal), Protect client,
                    go2rtc client, rate-limit, and the scheduled jobs (update-check, connectivity-watchdog,
                    protect-alarm-sync, protect-device-health, protect-event-stream, audit-archive, db-backup)
  auth/             admin-token + webhook-shared-secret guards
components/ui/      shadcn/ui components and the Material Symbols icon modules (see docs/design.md)
scripts/            CLI helpers (pin:add, sensor:trip, protect:mock, generate-sounds.py, screenshots.mts)
public/sounds/      panel sounds (WAV)
deploy/             systemd units, bootstrap/build/update scripts, go2rtc configs, optional Caddyfile,
                    proxmox/ (one-command LXC installer)
docs/               see the table below
```

| Doc | What it covers |
|---|---|
| [UNIFI.md](UNIFI.md) | Sensor-event sources, arm-state sync, camera streaming |
| [RUNBOOK.md](RUNBOOK.md) | One page for whoever is on call |
| [design.md](design.md) | Design system and per-surface rules |
| [architecture/](https://github.com/FelixLeChat/unifi-alarm-panel/tree/main/docs/architecture) | Source JSON and interactive HTML for the README "How it works" diagram; regenerate with the Archify skill |
| [sounds/index.html](sounds/index.html) | Listening page for the panel sounds |

One **Next.js + TypeScript** app: API routes, kiosk UI and admin UI. It runs as a single long-lived Node process (`output: "standalone"`, no horizontal scaling) so the server-side timers and in-memory state work. State persists to SQLite for restart recovery.

**Restart recovery covers an in-flight countdown.** `alarm_state` stores the exit/entry deadline next to the state, and the engine re-arms its timer from it on boot. A reboot or an update partway through an entry delay still escalates to `ALARM` on the original schedule (immediately if the deadline passed while the process was down). Look for `resumed an in-flight alarm countdown after a restart` in the log.


## Where a sensor trip goes

1. UniFi Alarm Manager posts to `POST /api/hooks/sensor` (or the realtime stream delivers a `devicePatched` event, `lib/services/protect-event-stream.ts`).
2. `lib/auth/webhook.ts` checks the shared secret, then `lib/services/sensor-webhook.ts` hands the raw body to `lib/services/webhook-intake.ts`, which reads the sensor id and event type from the configured JSON paths.
3. `lib/services/sensors.ts` registers an unknown sensor with the default mode, resolves the mode (`delayed`, `instant`, `ignore`) and updates the door's open or closed state. A close updates the state and stops there.
4. `lib/services/sensor-ingest.ts` drops a copy the other source delivered in the last 5 seconds, then calls `AlarmEngine.handleSensorTrip`.
5. `lib/engine/index.ts` dispatches `SENSOR_TRIP` to the pure state machine in `lib/state/machine.ts` and runs the effects it returns: start or cancel a timer, write the audit row, send the alert with a snapshot, trigger the siren, persist the state.

A new config key goes in `lib/services/settings.ts` (typed, with an env seed and secret handling) when the admin Settings screen should own it, or in the `config` table through `lib/services/config.ts` when it is an advanced key edited as a raw value.

## Dev container or Codespaces

The fastest start: open the repo in a dev container (VS Code, "Reopen in Container") or [GitHub Codespaces](https://codespaces.new/FelixLeChat/unifi-alarm-panel). `.devcontainer/` gives you Node 26, pnpm, the build toolchain for the native modules, the dependencies and a `.env` with fresh secrets and `ADMIN_TOKEN=dev`. Then:

```bash
pnpm dev            # http://localhost:3000/admin, sign in with "dev"
pnpm protect:mock   # fake UniFi Protect on :8089, no hardware needed
```

`node_modules` and `.next` live in container volumes, so a checkout that already ran `pnpm install` on the host is fine. The first start compiles a native module on arm64, which takes a minute.

## Run it locally

```bash
pnpm install
cp .env.example .env        # set ADMIN_TOKEN, WEBHOOK_SHARED_SECRET and SECRETS_KEY

pnpm test                   # vitest: state machine, engine, services, route handlers
pnpm test:e2e               # playwright: real browser, builds and starts its own server on a fresh DB
pnpm shots:baseline         # screenshot every admin screen, dialog and panel state into visual-baseline/ (gitignored)
pnpm shots                  # same walk, compared against visual-baseline/ (strict colour, 200 stray pixels allowed)
pnpm lint
pnpm exec tsc --noEmit

pnpm dev                    # http://localhost:3000 (/, /panel, /admin)
```

Seed a PIN from the CLI (or use `/admin`):

```bash
pnpm pin:add "Alex" 1234
curl -X POST localhost:3000/api/arm -H 'content-type: application/json' -d '{"pin":"1234"}'
curl localhost:3000/api/status
```

PINs are exactly 4 digits, and a duplicate code is rejected (409).

## Faking UniFi locally

No hardware needed to exercise the full alarm flow:

```bash
pnpm protect:mock                  # fake UniFi Protect on :8089, with viewable placeholder snapshots
pnpm sensor:trip front-door open   # simulates UniFi Alarm Manager's outbound webhook
```

In the setup wizard (or Settings > UniFi console), set the console URL to `http://localhost:8089` and any API key, then "Test connection" lists the mock's two cameras. `sensor:trip` posts to `/api/hooks/sensor` like the real webhook. While armed, it should reach `ALARM` and, if the sensor has a camera mapped (or a default camera is set), pull a snapshot from `protect:mock`. For Slack, use a throwaway [webhook.site](https://webhook.site) URL as the webhook, or any local HTTP listener for Slack and ntfy. With no channel set, alerts no-op (that's what the tests use).

A sensor row is created the first time UniFi posts an event naming it. There is no "add sensor" step, and the Sensors screen shows "No sensors found" until one arrives. Then map it to a camera on that screen.

`GET /api/health` reports engine and DB status, the sensor-feed heartbeat age, the running version, and the connectivity watchdog's view (default camera reachability, realtime-stream status and last error, which source delivered the last event). The per-device list is admin-only, on `GET /api/admin/connectivity`.

## Preview the docs site

The docs in this folder are also published as a site (MkDocs Material, built by `.github/workflows/docs.yml` and hosted on GitHub Pages). To preview it:

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements-docs.txt
mkdocs serve        # http://127.0.0.1:8000, rebuilds as you save
mkdocs build --strict   # what CI runs: a broken link fails
```

Publishing needs two one-time steps: enable Pages (Settings > Pages > Source: GitHub Actions) and add the repository variable `PAGES_ENABLED=true`. Until the variable is set, CI only builds the site.

A new page goes in the `nav` list in `mkdocs.yml`. Link to files outside `docs/` (source, scripts) with a full `github.com/.../blob/main/` URL, because the site can't resolve them.

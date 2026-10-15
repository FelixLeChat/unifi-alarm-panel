@AGENTS.md

# unifi-alarm-panel

Self-hosted UniFi-centric alarm system: a Next.js app that is the kiosk PIN panel (`/panel`), the admin UI (`/admin`) and the backend, in one process. Read [README.md](README.md) first, then [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for repo layout and dev commands and [docs/INSTALL.md](docs/INSTALL.md) for deploy steps. [docs/UNIFI.md](docs/UNIFI.md) covers the UniFi integration and [docs/RUNBOOK.md](docs/RUNBOOK.md) the on-call steps.

**The one thing to understand:** armed/disarmed state, PINs and the audit log live on this server, not in UniFi. UniFi (Alarm Manager) is an event source and camera layer that webhooks every sensor trip here. The console's arm state is mirrored in only on an edge (someone armed from the UniFi app), never re-applied as a level. Don't design anything that treats UniFi's arm state as authoritative.

## Outbound calls

LAN-only by design, no cloud services, no telemetry. The only outbound calls are Slack, ntfy (if self-hosted), the local UniFi console, GitHub (update check), `api.telegram.org` (only when the Telegram channel is set up) and one accepted exception: Open-Meteo for the panel's weather strip, proxied server-side through `GET /api/panel/context` with a ~30 min cache so the kiosk itself never calls out. Signal goes through a self-hosted signal-cli-rest-api container on the LAN, so it adds no host to this list.

## Runtime model, don't break this

Single long-lived Node process (`output: "standalone"`), one instance, no Edge or serverless runtime. The entry/exit timers and engine state are in memory (`lib/engine/index.ts`, a singleton) and persisted to SQLite for restart recovery, including the in-flight deadline. Not designed for horizontal scaling.

- `lib/state/`: pure alarm state machine, no I/O, fully unit-tested.
- `lib/engine/`: wires timers, SQLite, notifier and Protect client to the state machine.
- `lib/services/`: pins, audit, config, settings + secrets, sensors, notifiers (Slack, ntfy, Telegram, Signal), Protect client, go2rtc client, rate-limit, and the scheduled jobs (update-check, connectivity-watchdog, protect-alarm-sync, protect-device-health, protect-event-stream, audit-archive, db-backup).
- `app/panel/`: server-rendered kiosk, vanilla JS on purpose (`public/panel.js`), no React or hydration dependency.
- `app/admin/`: React, eight screens (Overview, Sensors, PINs, Delays, Audit log, Events, Tasks, Settings) and the first-run setup wizard, token-gated by `ADMIN_TOKEN`.

## Settings live in the database

Console, notification and panel settings are edited in the admin UI and stored in the `settings` table (`lib/services/settings.ts`). Env vars only seed them once, on first boot. Only `ADMIN_TOKEN`, `WEBHOOK_SHARED_SECRET`, `SECRETS_KEY` and runtime basics (`PORT`, `DATABASE_PATH`, `LOG_LEVEL`, `UPDATE_CHECK_REPO`) stay in the environment.

- Read a setting with `getSetting(key)`, never `process.env`. Add a new one to `SETTINGS` with a zod schema, then to `GROUP_SECTIONS` in `app/admin/SettingsGroupForm.tsx`.
- Every save bumps `getSettingsRevision()`. Long-lived clients (`getProtectClient`, `getNotifier`) compare it and rebuild; the event stream's job compares its own credentials. Don't cache a setting-derived object anywhere else without the same check, or a save won't apply until restart.

## Notification channels

One module per channel in `lib/services/notifiers/` (`slack.ts`, `ntfy.ts`, `telegram.ts`, `signal.ts`), a shared `index.ts` (`getNotifier()`, `CHANNELS`, `listChannels()`), `routing.ts` (alert kinds, per-channel routing) and the `Channel` / `ChannelDef` types in `types.ts`. A channel declares its settings fields (secret ones flagged), `isConfigured()`, `send()` (retry once, never throw) and `test()` (one attempt, throws a readable reason). Routing is two settings per channel, `<id>Enabled` (unset means on) and `<id>AlertKinds` (unset means every kind), so an install from before routing keeps receiving everything.

To add a channel:

1. Create `notifiers/<id>.ts`: export `<id>Fields` (`satisfies Record<string, FieldDef>`, with `<id>Enabled` and `<id>AlertKinds`), a `Channel` class, and a `ChannelDef`.
2. Add the id to `ChannelId` in `types.ts`, the def to `CHANNELS` in `index.ts`, and `...<id>Fields` to `SETTINGS` in `settings.ts`. A channel module must not import `settings.ts` (it imports the fields), or the module cycle breaks `SETTINGS`.
3. Add a section with `channel: "<id>"` to the notifications group in `GROUP_SECTIONS` (`app/admin/SettingsGroupForm.tsx`). The card gets the switch, the alert-type checkboxes and the test button from that.
4. Secrets: flag `secret: true`, and never put one in a log line or error message. Telegram's token is in its URL path, so `telegram.ts` never includes the URL in an error.
5. Tests with a mocked `fetch`, docs/CONFIGURATION.md and the `.env.example` seed list, and the outbound list above if the channel calls a host that isn't on the LAN.

DURESS goes only to the channels the admin routed it to. Never add a channel that shows or sounds on site.

## Security-sensitive, don't casually change

- PINs are hashed (argon2), never logged, never returned by any API.
- A duress PIN disarms normally and must never be distinguishable from a normal PIN in the UI, an API response, the panel sounds or the audit log.
- PIN attempts share one lockout bucket (`PIN_BUCKET` in `lib/engine/index.ts`), never one per source: the source is `X-Forwarded-For`, which the caller controls, and Next only fills it in when it's absent. Don't make PIN lockout per-source again.
- The admin-token and webhook-secret guards share the PIN rate-limit and lockout service, each in its own namespace. Don't let a fix to one remove throttling from the others, and keep caller-controlled values (like `X-Forwarded-For`) out of another namespace's key.
- Stored credentials (secret fields in `SETTINGS`) are AES-256-GCM encrypted with `SECRETS_KEY`, never returned by any API (the UI gets `{ set, readable }`), never logged, and the audit log records changed field names only.
- Never set `NODE_TLS_REJECT_UNAUTHORIZED=0`. Use the CA certificate or "skip certificate check" console settings, which only apply to the Protect client.

## Sharp edges worth knowing before touching UniFi, camera or streaming code

- The private `/api/v2/alarms/*` endpoint (arm-state sync) needs a SuperAdmin account. A Protect-scoped admin gets `403`. The legacy `armMode` field is a confirmed dead end.
- go2rtc's MJPEG output needs a real `ffmpeg` on the box and go2rtc's own `rtsp: listen:` on loopback. ffmpeg pulls the stream back from go2rtc, not from the camera. See the comment in `deploy/go2rtc.yaml`.
- go2rtc's stream registry is in memory and doesn't survive a go2rtc restart. Re-saving a sensor in the admin UI re-registers it.
- A stream name is spliced into go2rtc's `ffmpeg:<name>#video=mjpeg` source, and `#` starts go2rtc options (including raw ffmpeg arguments). `isSafeStreamName` in `lib/services/go2rtc-client.ts` gates every registration; keep camera and sensor IDs going through it.
- The Protect Integration API's camera schema has no `mac` field. Camera-to-sensor matching is config-driven (`cameraTriggerEventTypes` in `/api/admin/config`), not inferred.
- `sensorOpenEventTypes` / `sensorClosedEventTypes` have no defaults. The door check on arming does nothing until they hold real values from the console.
- `instrumentation.ts` has a bundle-isolation gotcha. Shared state that must be visible across bundles sits on `globalThis` (see `__uapStreamState`).

## Design system

shadcn/ui, base-luma style, neutral theme. [docs/design.md](docs/design.md) holds the app's own decisions (the kiosk's plain CSS, the orange Arm button). PRODUCT.md says who uses it and why.

- Add components from upstream shadcn (`pnpm dlx shadcn@latest add <name>`), then check the generated imports.
- Style with semantic tokens (`bg-primary`, `text-muted-foreground`, `bg-emphasis`), never raw hex values. The type scale (`text-body-s`, `text-title-xs`, ...) and the extra tokens (`success`, `warning`, `emphasis`) are defined in `app/globals.css`.
- Fonts are Figtree, Fraunces and JetBrains Mono through `next/font/google`, downloaded at build time, so the running app never calls out.

## Docs

Keep the docs in step with the code. A change to config keys, env vars, scripts, admin screens or the deploy path updates the docs in the same PR ([docs/CONFIGURATION.md](docs/CONFIGURATION.md), [docs/INSTALL.md](docs/INSTALL.md), and [README.md](README.md) if the quick start changes). Write the way the existing docs do: short, concrete (ids, values, dates), no em dashes.

## Verify before claiming done

Mocked tests prove internal logic, not that a real integration works. For anything touching go2rtc, ffmpeg, UniFi Protect or admin UI rendering, run it for real. See the global CLAUDE.md's "Verify Against the Real Thing" rule.

```bash
pnpm test           # vitest
pnpm test:e2e       # playwright, real browser
pnpm lint && pnpm exec tsc --noEmit
pnpm dev            # http://localhost:3000
```

@AGENTS.md

# unifi-alarm-panel

Self-hosted UniFi-centric alarm system: a Next.js app that is the kiosk PIN panel (`/panel`), the admin UI (`/admin`) and the backend, in one process. Read [README.md](README.md) first for repo layout, dev commands and deploy steps. [docs/UNIFI.md](docs/UNIFI.md) covers the UniFi integration and [docs/RUNBOOK.md](docs/RUNBOOK.md) the on-call steps.

**The one thing to understand:** armed/disarmed state, PINs and the audit log live on this server, not in UniFi. UniFi (Alarm Manager) is an event source and camera layer that webhooks every sensor trip here. The console's arm state is mirrored in only on an edge (someone armed from the UniFi app), never re-applied as a level. Don't design anything that treats UniFi's arm state as authoritative.

## Outbound calls

LAN-only by design, no cloud services, no telemetry. The only outbound calls are Slack, ntfy (if self-hosted), the local UniFi console, GitHub (update check) and one accepted exception: Open-Meteo for the panel's weather strip, proxied server-side through `GET /api/panel/context` with a ~30 min cache so the kiosk itself never calls out.

## Runtime model, don't break this

Single long-lived Node process (`output: "standalone"`), one instance, no Edge or serverless runtime. The entry/exit timers and engine state are in memory (`lib/engine/index.ts`, a singleton) and persisted to SQLite for restart recovery, including the in-flight deadline. Not designed for horizontal scaling.

- `lib/state/`: pure alarm state machine, no I/O, fully unit-tested.
- `lib/engine/`: wires timers, SQLite, notifier and Protect client to the state machine.
- `lib/services/`: pins, audit, config, settings + secrets, sensors, notifier (Slack/ntfy), Protect client, go2rtc client, rate-limit, and the scheduled jobs (update-check, connectivity-watchdog, protect-alarm-sync, protect-device-health, protect-event-stream, audit-archive, db-backup).
- `app/panel/`: server-rendered kiosk, vanilla JS on purpose (`public/panel.js`), no React or hydration dependency.
- `app/admin/`: React, eight screens (Overview, Sensors, PINs, Delays, Audit log, Events, Tasks, Settings) and the first-run setup wizard, token-gated by `ADMIN_TOKEN`.

## Settings live in the database

Console, notification and panel settings are edited in the admin UI and stored in the `settings` table (`lib/services/settings.ts`). Env vars only seed them once, on first boot. Only `ADMIN_TOKEN`, `WEBHOOK_SHARED_SECRET`, `SECRETS_KEY` and runtime basics (`PORT`, `DATABASE_PATH`, `LOG_LEVEL`, `UPDATE_CHECK_REPO`) stay in the environment.

- Read a setting with `getSetting(key)`, never `process.env`. Add a new one to `SETTINGS` with a zod schema, then to `GROUP_SECTIONS` in `app/admin/SettingsGroupForm.tsx`.
- Every save bumps `getSettingsRevision()`. Long-lived clients (`getProtectClient`, `getNotifier`) compare it and rebuild; the event stream's job compares its own credentials. Don't cache a setting-derived object anywhere else without the same check, or a save won't apply until restart.

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

Keep the docs in step with the code. A change to config keys, env vars, scripts, admin screens or the deploy path updates [README.md](README.md) in the same PR. Write the way the existing docs do: short, concrete (ids, values, dates), no em dashes.

## Verify before claiming done

Mocked tests prove internal logic, not that a real integration works. For anything touching go2rtc, ffmpeg, UniFi Protect or admin UI rendering, run it for real. See the global CLAUDE.md's "Verify Against the Real Thing" rule.

```bash
pnpm test           # vitest
pnpm test:e2e       # playwright, real browser
pnpm lint && pnpm exec tsc --noEmit
pnpm dev            # http://localhost:3000
```

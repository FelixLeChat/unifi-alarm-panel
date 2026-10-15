# Security

## Reporting a vulnerability

Please don't open a public issue. Report it privately through GitHub: **Security > Report a vulnerability** on this repository. You'll get an answer within a week.

Include what you found, how to reproduce it, and what an attacker could do with it.

## Supported versions

Security fixes go into the latest release. Upgrade to it before reporting something that an older version has.

## What this app protects

- **PINs** are hashed with argon2, never logged and never returned by any API.
- **A duress PIN** disarms normally and is indistinguishable from a normal PIN in the UI, the API, the panel sounds and the audit log.
- **Stored credentials** (Protect API key, SuperAdmin password, Slack webhook and token, Telegram bot token) are encrypted with AES-256-GCM using `SECRETS_KEY`, never returned by any API, and the audit log records only which fields changed. A copy of the database or a backup is useless without `SECRETS_KEY`.
- **PIN attempts** share one lockout count across every caller, so forging `X-Forwarded-For` doesn't buy more guesses. Five wrong PINs lock the keypad and raise the alarm.
- **The admin token and webhook secret** have their own per-source lockouts in the same rate-limit service, each in its own namespace.

## Running it safely

- Keep it on a trusted LAN. Don't expose `/admin` or `/api` to the internet.
- Generate long random values for `ADMIN_TOKEN`, `WEBHOOK_SHARED_SECRET` and `SECRETS_KEY`, and keep `SECRETS_KEY` separate from your database backups.
- Prefer the console's CA certificate over "Skip certificate check". Never set `NODE_TLS_REJECT_UNAUTHORIZED=0`.
- The SuperAdmin account is optional. Leave it unset unless you need the arm-state sync and the realtime event stream.

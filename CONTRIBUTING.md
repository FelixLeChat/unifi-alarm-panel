# Contributing

How to get a change into `main`. See [docs/INSTALL.md](docs/INSTALL.md) and [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for setup and [CLAUDE.md](CLAUDE.md) for the runtime model and the security rules.

## Where to go

| I want to... | Go to |
| --- | --- |
| Ask for help installing or configuring | [Discussions, Q&A](https://github.com/FelixLeChat/unifi-alarm-panel/discussions/new?category=q-a) |
| Report a bug | [Issues](https://github.com/FelixLeChat/unifi-alarm-panel/issues/new/choose) |
| Suggest a feature or a bigger change | [Discussions, Ideas](https://github.com/FelixLeChat/unifi-alarm-panel/discussions/new?category=ideas), before you write code |
| Fix a bug or improve the docs | A pull request: small ones need no discussion first |
| Report a security vulnerability | [SECURITY.md](SECURITY.md), never a public issue |

Be kind: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). If AI helped, read [AI_POLICY.md](AI_POLICY.md): a person reads and sends everything.

## Setup

```bash
pnpm install
cp .env.example .env
pnpm dev                    # http://localhost:3000 (/, /panel, /admin)
```

No UniFi hardware needed. `pnpm protect:mock` fakes the console and `pnpm sensor:trip front-door open` fakes a sensor webhook ([docs/DEVELOPMENT.md](docs/DEVELOPMENT.md), "Faking UniFi locally").

UI components come from upstream shadcn/ui: `pnpm dlx shadcn@latest add <name>`. Check the result: the CLI can write imports that don't match `components.json` aliases, or add packages you don't need.

## Workflow

1. Branch off `main`: `feat/...`, `fix/...`, `docs/...`, `chore/...`.
2. Make the change. Keep the diff to what the change needs.
3. Run the checks below.
4. Open a PR. The template asks for what changed, why and how you verified it.
5. CI must pass (`ci` and `e2e` jobs). Squash-merge.

## Commits and PR titles

[Conventional Commits](https://www.conventionalcommits.org/): `type(scope): description`.

- Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.
- Scopes seen here: `alarm`, `panel`, `admin`, `settings`, `protect`, `engine`, `deploy`, `docker`, `deps`, `e2e`.
- Breaking change: `feat!:` or a `BREAKING CHANGE:` footer.
- A PR with one commit is validated on that commit, so its subject must be conventional too.
- Write the body as plain paragraphs. Don't hard-wrap at 72 columns.

## Checks

```bash
pnpm lint
pnpm typecheck
pnpm test                   # vitest
pnpm test:e2e               # playwright, builds and starts its own server on a fresh DB
```

For a UI-only change, run `pnpm shots:baseline` on `main` first, then `pnpm shots` on your branch. It walks the admin screens and dialogs (login to Settings, the PIN, sensor and disarm dialogs) at 1440 and 390 pixels wide, and the panel's disarmed, confirm, open-door, test-mode, armed, alarm and portrait states plus one 390 pixel overflow check, in the one theme users can reach. The compare is strict on colour (`threshold: 0`) and tolerates 200 stray pixels for font anti-aliasing. A diff you didn't mean to make shows up under `test-results-visual/`. Baselines depend on the OS and fonts, so they are not committed.

CI also runs `pnpm audit --audit-level=high` and `pnpm build`. A vulnerable transitive dependency fails the build.

Tests prove the logic is consistent. They don't prove an integration works. If you touched the admin UI, the panel, go2rtc, ffmpeg or UniFi Protect, run it for real and say in the PR what you saw.

## What to be careful with

- **PINs and duress:** hashed, never logged, never returned. A duress PIN must look like a normal disarm everywhere: UI, API, sounds, audit log.
- **Stored credentials:** encrypted with `SECRETS_KEY` (`lib/services/secrets.ts`), never returned by an API, never logged, never written to the audit log (field names only).
- **Rate limiting:** the PIN, admin-token and webhook-secret guards share one service, each in its own namespace. A fix to one must not remove throttling from the others.
- **Runtime model:** one long-lived Node process, in-memory timers. No Edge, no serverless, no second instance.
- **Panel:** `app/panel/` stays server-rendered with vanilla JS (`public/panel.js`). No React, no hydration dependency.
- **Next.js:** this version has breaking changes. Read the relevant guide in `node_modules/next/dist/docs/` before writing code ([AGENTS.md](AGENTS.md)).
- **UI:** use the semantic tokens from the design system, never raw hex. See [docs/design.md](docs/design.md).

## Docs

A change to config keys, env vars, scripts, admin screens or the deploy path updates the docs in the same PR ([docs/CONFIGURATION.md](docs/CONFIGURATION.md), [docs/INSTALL.md](docs/INSTALL.md), and [README.md](README.md) if the quick start changes). Write short and concrete (ids, values, dates). No em dashes.

## Releases

Push a `v*` tag. `.github/workflows/release.yml` builds the standalone tarball, attaches it to the GitHub Release, and pushes `ghcr.io/felixlechat/unifi-alarm-panel:<tag>` and `:latest`. A systemd box picks it up through `deploy/update.sh` or the admin UI's "Update available" banner; a Docker host with `docker compose pull`.

## Reporting a security issue

Don't open a public issue. See [SECURITY.md](SECURITY.md).

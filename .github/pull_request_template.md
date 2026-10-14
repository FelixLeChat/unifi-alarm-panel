## What

<!-- One or two sentences. The PR title is a Conventional Commit: type(scope): description -->

## Why

<!-- The problem, the incident or the ask. Link the issue if there is one: Closes # -->

## How I verified it

- [ ] `pnpm lint`, `pnpm typecheck` and `pnpm test` pass
- [ ] `pnpm test:e2e` passes (required for admin UI, panel, go2rtc or UniFi changes)
- [ ] Tried it for real (browser, `protect:mock` or a real console). What I saw:

## Checklist

- [ ] Docs updated if config keys, env vars, scripts, admin screens or deploy changed
- [ ] No PIN, token or secret logged or returned by an API
- [ ] A duress PIN is still indistinguishable from a normal one (if touched)
- [ ] Rate-limit namespaces untouched, or throttling kept on all three guards (if touched)

## Notes for the reviewer

<!-- Anything risky, anything you skipped, anything that needs a deploy step. Delete if empty. -->

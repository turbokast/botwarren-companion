## What and why

<!-- A short description. Link the issue if there is one ("Fixes #123"). -->

## What can a paired device, the relay or the website now see or do?

<!-- The Companion's contract: the relay and the website carry ciphertext only, and a device can only approve, deny or send a host-defined preset reply to a request that is pending. State what the change reads on the user's computer, what it sends, and what a remote device can newly do. "Nothing new" is a fine answer. -->

## Checklist

- [ ] Every commit is signed off (`git commit -s`): I certify the [Developer Certificate of Origin](https://developercertificate.org/) and license my contribution under Apache-2.0 (the DCO check fails otherwise)
- [ ] `pnpm typecheck` and `pnpm test` pass locally (and `pnpm test:e2e` if the web client changed)
- [ ] Tests added or updated for the change, including a negative test for anything security-relevant (tamper, replay, wrong sender, expired, stale)
- [ ] No keys, tokens, pairing codes, message content, paths or real session data in code, fixtures, logs or this description
- [ ] Protocol, envelope, pairing or signing change: `docs/PROTOCOL.md` is updated and the test vectors still pass (a change to canonical bytes needs an issue first)
- [ ] No new network destination, no telemetry, no new runtime dependency (or an issue discussing it first)
- [ ] `CHANGELOG.md` has a line under `## [Unreleased]` for anything a user would notice
- [ ] Changes under `.github/workflows/` use only actions pinned to a full commit SHA, with the narrowest `permissions:`

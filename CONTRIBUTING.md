# Contributing to the Botwarren Companion

Thanks for helping. This program has one job that must never regress: **a relay or a server can carry your messages but never read or forge them, and a remote device can do no more than approve, deny or send a preset reply to the request that is pending now.** Most review time goes to that, so please read this page before opening a pull request. By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). Vulnerabilities go to support@turbokast.com, not to public issues (see [SECURITY.md](SECURITY.md)).

## Licence and sign-off (DCO)

The project is licensed under the [Apache License 2.0](LICENSE). **Contributions are accepted under the same licence** (Apache-2.0, as described in section 5 of the licence): you license your contribution to TurboKast Ltd and to everyone who receives the software under those terms.

We use the [Developer Certificate of Origin](https://developercertificate.org/) instead of a contributor licence agreement. Certify it by signing off every commit:

```sh
git commit -s -m "Describe the change"
```

This adds a `Signed-off-by: Your Name <you@example.com>` line, which means you have the right to submit the work under the project's licence (DCO 1.1, reproduced at the link). Use your real name. A pull request with unsigned commits cannot be merged; `git rebase --signoff main` fixes a branch.

## Ground rules

1. **No homemade cryptography.** Primitives come from WebCrypto (HPKE per RFC 9180 over X25519, HKDF-SHA256 and AES-256-GCM; Ed25519). A change to the envelope, the pairing, the key schedule or any signed byte string needs an issue first, an update to [docs/PROTOCOL.md](docs/PROTOCOL.md), and the test vectors still passing. Canonical bytes never change silently: the known-answer tests exist to catch that.
2. **The relay never learns content, and never needs to.** No frame body, header field, id, name, address or ticket goes into a log line or a counter label. The relay tests plant canaries in every field and fail if one reaches a log or storage; keep them passing.
3. **A device can do three things.** Approve, deny, or send a preset reply (text defined on the user's own computer, never by the client) to the request that is pending now, matching the hash the device displayed. A new action type is a design change: it defaults to "confirm on this computer" and starts with an issue.
4. **Fail open for the terminal, fail closed for the remote.** A hook or the daemon being down must never block the user's own terminal. An action that does not verify is dropped, not guessed.
5. **Signed or it does not run.** The web client is checked by the loader against a signed manifest; the component is installed only from a signed manifest. Never add a path that runs or serves something that is not covered by a verified signature and hash.
6. **No telemetry, no analytics, no third-party origin.** The web client loads nothing from outside its own origin (see its CSP). The companion talks only to the relay address it was enrolled with, and refuses relays outside its allow-list.
7. **No new runtime dependencies without discussion.** `zod`, `ws` and `qrcode-generator` are the runtime packages. Open an issue first if you think another is needed.
8. **No secrets or real content in the repository.** Fixtures use obviously fake values, and fake secrets are assembled at run time (see the masking tests) so that no secret-shaped literal sits in the source.

## Development

```sh
pnpm install
pnpm typecheck          # strict TypeScript; no enums, no parameter properties (Node runs the sources directly)
pnpm test               # vitest, one file at a time
pnpm test:e2e           # the signed web client in a real browser (playwright install chromium first)
```

Requires Node.js 22.18 or newer (`.nvmrc` says 24, which is what CI and releases use) and pnpm 11 (`corepack enable` picks the pinned version). Run one test file at a time on a busy machine (`pnpm --filter @botwarren/companion exec vitest run test/e2e.test.ts`); several tests start real loopback sockets and use real timers. The Claude Code bridge is tested against the official MCP SDK client and a temporary home directory; **no test touches a real `~/.claude`**, and a change must not either. Windows and macOS code paths (the named pipe, file modes, the installer integration) get a manual run noted in the pull request when you change them.

`apps/companion/vendor/agent/` holds verbatim copies of ship agent files (the pinned public keys, manifest schema and verifier, archive writer, KMS client). Do not edit them here: changes are made in the ship agent repository and re-vendored.

## Pull requests

Small, focused, with tests (including a negative test for anything security-relevant: tampered, replayed, wrong sender, expired, stale). State what can newly be seen or done by a paired device, the relay or the website, and add a line under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md) if a user would notice the change. Do not commit keys, tokens, `.env` files or pairing codes. CI runs typecheck and tests on Linux, macOS and Windows, the web client in a browser, a reproducible-build check, CodeQL, a dependency review and the DCO check; pull requests from forks run without any secrets. The first run from a new contributor needs the maintainer to approve it. Merges are squash merges, so you do not need to tidy your branch history, but every commit must be signed off.

Workflow changes (`.github/workflows/`) are held to the same bar as code: actions pinned to a full commit SHA with the version in a comment, the narrowest `permissions:` per job, no secrets on `pull_request`. The `Workflow lint` job runs `actionlint` and `zizmor` on them.

## Where to ask

Questions and ideas: [Discussions](https://github.com/turbokast/botwarren-companion/discussions) (see [SUPPORT.md](SUPPORT.md)). How decisions are made: [GOVERNANCE.md](GOVERNANCE.md).

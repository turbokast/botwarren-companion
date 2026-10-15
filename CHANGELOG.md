# Changelog

All notable changes to the Botwarren Companion are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) (while the major version is 0, any minor release may change behaviour; releases are marked pre-release on GitHub).

A release is only built from a dated entry in this file: the release workflow takes the section for the tag's version as the body of the GitHub Release and fails if it is missing (see [docs/RELEASING.md](docs/RELEASING.md)).

## [Unreleased]

## [0.1.1] - 2026-10-15

Makes the first release usable: how to get the command, an install for computers without a ship agent, renewal of the signed manifest, and a relay image fix.

### Added

- **Manual installers for a computer without a ship agent:** `install.sh` (Linux, macOS) and `install.ps1` (Windows), published at `https://downloads.botwarren.com/companion/` and attached to each release. They verify before anything runs: the Ed25519 signature of the component manifest against the component key pinned inside the script (checked first; a development key is refused unless a test allows it for an address on the computer itself), then the bundle's size and SHA-256, then its contents (exactly four named files, no paths or links), and the manifest's expiry, counter (anti-rollback), epoch, blocked list, protocol and Node version; only then they extract and self-test. Per-user locations, no administrator rights, https only; `--service` also runs the daemon in the background (systemd `--user`, launchd, or the Windows Startup folder), `--dry-run` verifies and writes nothing, `--uninstall` removes it all (devices revoked, hooks removed, keys deleted first). The scripts are generated from one program (`apps/companion/install/installer.mjs`); a test fails if they are out of date, if the pinned keys differ from the ship agent's component keys, or if a release does not embed the pinned production key. Tested against signed fixtures with a throw-away key, the same verdicts as the ship agent's verifier, shellcheck, and an end-to-end run of the real script.
- **`botwarren-companion enroll` at a terminal** shows this computer's public key and accepts the enrolment pasted from the account page ("Enrol a computer"), for an install without a ship agent. With JSON on stdin it behaves as before.
- **A scheduled re-sign** (`.github/workflows/resign.yml`, monthly, behind the same `release` environment approvals): renews the current component manifest, which is valid for 90 days, when fewer than 45 days remain. It re-verifies the published manifest and bundle against the pinned key and hash, changes only the manifest counter and dates, signs with the same Cloud KMS key through GitHub OIDC, checks the result and uploads the signature then the manifest. Documented in [docs/RELEASING.md](docs/RELEASING.md).

### Fixed

- The relay image: `/srv` is made world-readable before the process drops to the unprivileged `relay` user, so a build context extracted with restrictive directory modes no longer crashes the relay at start (`ERR_MODULE_NOT_FOUND` caused by `EACCES`); the relay deploy helper relaxes the extractor's `0700` directories as well. This made the first production deploy of 0.1.0 fail.

### Changed

- `docs`, README: how the `botwarren-companion` command is reached (the ship agent 0.7.1 adds it next to `botwarren` and passes `botwarren companion <command>` through), and the two install paths.

## [0.1.0] - 2026-10-15

First release: opt-in, end-to-end encrypted remote approvals for coding agents. Pre-release; no independent security review yet.

### Added

- **The companion** (`botwarren-companion`): a daemon on your computer that holds the keys, tracks your agent sessions, and answers from your paired devices. Commands: `pair`, `status`, `devices` (and `devices revoke`), `pause`, `resume`, `confirm`, `log`, `claude install-hooks | uninstall-hooks | register-channel | doctor`, `uninstall`.
- **The protocol (version 1, [docs/PROTOCOL.md](docs/PROTOCOL.md)):** HPKE (RFC 9180: DHKEM X25519, HKDF-SHA256, AES-256-GCM) over WebCrypto, Ed25519 signatures with domain separation, signed envelopes with replay counters, expiry and padding, key rotation (7 days, only when every device was seen in the last 24 hours), host-signed device certificates, server-signed enrolment tickets, and one-time-code pairing with a six-digit check shown on both sides. Checked against the RFC 9180 (A.1.1), RFC 8032 and RFC 5869 test vectors.
- **The relay** (`apps/relay`): carries sealed frames, verifies the ticket and certificate chain on every connection without holding keys, keeps nothing durable (a 15 minute in-memory queue), rate limits, kill switches (global, account, host, device) and a signed kill list from botwarren.com, and serves the signed web client from its own cookie-less origin with a strict content security policy.
- **The signed web client** (`apps/companion/client`): a verifying loader with the pinned public component key checks the manifest signature and every file hash before the app starts; device keys are non-extractable browser keys; shows the pending question or permission request and the last three messages, and answers with approve, deny or a preset reply.
- **Claude Code integration:** a minimal MCP channel server (permission relay and channel events, checked against the official SDK client) and fail-open hooks (`PermissionRequest`, `Notification`, `Stop`) that report and do not hold the terminal by default; the settings installer shows a diff, asks, backs up and removes only what it added.
- **Local policy:** `deny` always works remotely; `approve` and preset replies can be set to need confirmation on the computer; a rate limit; a pause switch; masking of token-shaped strings before anything is encrypted; replies are host-defined presets only.
- **Release tooling and the release workflow:** a reproducible build of the client and of the installable component, an independent rebuild whose hashes must match, signing of both with the Botwarren Cloud KMS **component signing key** (`kms-comp-2026a`, separate from the ship agent's update-signing key and used by its own service account) through GitHub OIDC workload identity federation (domain-separated signatures: `botwarren-client-v1` and `botwarren-component-v1`), verification against the pinned public key, GitHub build-provenance attestations, the relay image inputs (the signed client inside a build context), and publication to the downloads host and a GitHub Release whose body is this changelog entry.
- Repository health: CodeQL, OpenSSF Scorecard, dependency review, `zizmor` and `actionlint`, DCO check, CI on Linux, macOS and Windows plus the web client in a real browser, `SECURITY.md`, `CONTRIBUTING.md`, `GOVERNANCE.md`, `SUPPORT.md`, issue forms and a pull request template.

### Known limits

- No independent security review has been done.
- The web client is served by Botwarren: a compromised Botwarren origin could serve different code (see [docs/CLIENT_SECURITY.md](docs/CLIENT_SECURITY.md)).
- Answering from a phone relies on Claude Code Channels, a research preview that needs Claude Code 2.1.234 or later.
- Windows and macOS are covered by CI tests but have had little manual testing (the local socket or named pipe, file modes, the installer integration).
- The relay is a single machine; forward secrecy is per key rotation, not per message.

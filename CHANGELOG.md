# Changelog

All notable changes to the Botwarren Companion are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) (while the major version is 0, any minor release may change behaviour; releases are marked pre-release on GitHub).

A release is only built from a dated entry in this file: the release workflow takes the section for the tag's version as the body of the GitHub Release and fails if it is missing (see [docs/RELEASING.md](docs/RELEASING.md)).

## [Unreleased]

## [0.1.3] - 2026-10-15

Fixes what the second real-world test found on an Android phone: alerts that never came and never said why, a relay queue that kept overflowing, and long messages cut at 600 characters. The relay needs the 0.1.3 image for long messages (against a 0.1.2 relay everything keeps working in the short form).

### Added

- **Send a test alert.** On the phone's Alerts card: phone to computer to relay to push service and back to the phone, with each leg reported as it is confirmed and, when one fails, which one (new message kinds `pushtest` and `pushtestack`; the test payload is sealed like any alert). One test every 10 seconds and ten an hour per phone; it does not use the real alerts' hourly allowance.
- **Long messages, in a terminal view.** The "last things it said" and the pending request's command are shown in monospace on a dark terminal surface: whitespace and line breaks kept, colour codes removed, soft wrap with sideways scrolling for a word longer than the screen, a "No wrap" switch, Copy, Expand (up to 62% of the screen) and an own scroll area with a maximum height so Approve and Deny stay in reach. Expansion and scroll position survive redraws. Controls are at least 44 px. Design: Claude Design project, board "Companion Terminal View".
- **Per-device capability.** A 0.1.3 page says `caps:["long1"]` in its `sync`; the computer then sends the long form (up to 24,000 characters per text, the whole state in one frame of at most 64 KB padded; new size buckets 16 KB, 32 KB, 64 KB). Text that still does not fit is cut at the END and the phone says how many characters were cut. A request whose command was cut cannot be approved from the phone. An older page (any 0.1.0 to 0.1.2 client, for instance an open tab) gets the short form as before, and cannot approve a request it only saw shortened.
- The relay announces its frame limit in `ready` (`maxFrame`); the computer never sends a frame bigger than the relay it is connected to accepts, so a 0.1.3 computer against a 0.1.2 relay stays in the 8 KB form.
- `botwarren-companion status` and `alerts` report the running daemon's version and warn, with the restart command for the computer's service manager, when it differs from the installed command.

### Fixed

- **Alerts: "Setting up" for ever.** The running Companion on the owner's computer was still 0.1.1 (the update had replaced the files, but nothing had restarted the background service), so it ignored the phone's `push` message and never answered, and the page waited without a limit and then claimed alerts were "set up". Every awaited step now has a time limit and a result that names the step that stopped, in plain words: permission refused or unanswered, relay unreachable or without alerts, worker file not matching its signature / not downloadable / refused / not starting, the browser's push service unreachable (Chrome's FCM; retried once), a withdrawn permission, an offline computer ("Waiting for computer", sent again by itself when it returns), a computer that is online but silent, and a computer that sends its state but never answers the alerts question (an older Companion: the card says so and names the restart command). The page also re-sends its subscription when the computer comes back online, not only when the page connects.
- **The installer said "could not start" when it could not RESTART** a service it had moved to the new version, which hid that the old code kept running. It now says so loudly and names the restart command.
- **Relay queue overflow (321 frames, 124 overflow drops with the phone away).** Two causes. (1) The running computer was the old 0.1.1 daemon, which sends a frame per hook event and no replace key. The relay now also caps what one sender may have queued for one recipient (the newest 12 frames without a key and 8 distinct keys; counter `queue_trimmed`, not an overflow), and the phone's own `sync`, `push` and `keyupdate` frames carry replace keys. (2) A real bug in 0.1.2 itself: the sessions in the state were ordered by their last EVENT, so with several busy sessions every tool call reordered the list, made the state "changed" and defeated the coalescing. They are now ordered by their last change of status, with a stable tie-break. A test simulates an hour of `PostToolUse` churn across three sessions with the phone away and finds at most three frames queued at the relay, no overflow.
- Text from an agent is stripped of terminal colour codes, control characters and bidirectional overrides on the computer before it is sealed (so what is approved is what was shown), and again in the page.
- The relay closes an unauthenticated socket that sends more than 8 KB.

### Changed

- The relay's per-recipient queue holds up to 1 MiB (was 512 KiB) because a long state frame can be 90 KB; per-sender caps keep it small.
- `lastSeen` in the device list of the state is rounded to the minute, so a phone's own traffic does not count as a state change.

## [0.1.2] - 2026-10-15

Fixes the problems found by the first real-world test (a phone that got no alert, a relay queue that overflowed, a command that could not reach a daemon that was running, Claude Code settings that broke on update, a prompt that silently did nothing without a terminal) and adds phone alerts.

### Added

- **Phone alerts: "An agent is waiting for you".** Optional, off until the person turns **Alerts** on in the phone page (gear icon; a one-time offer on the home screen). The phone page registers its own Web Push subscription and gives it to the computer inside the end-to-end encrypted channel (new message kinds `push` and `pushack`); when a request starts waiting, the computer seals one alert for that phone's keys (RFC 8291) and asks the relay only to deliver the ciphertext (a new relay `push` message, at most 600 bytes, real browser push services only, rate limited). The alert says nothing but those words: no tool, command, project or session text; the relay, the push service and Botwarren's website cannot read it, and the website is not in the path. Tapping it opens the page on that request (`#/r/<id>`), or says truthfully that it was already answered. One alert per waiting episode with a 15 second settle time, coalesced, at most one a minute and 12 an hour, quiet after an answer, held back by pause and by quiet hours (`botwarren-companion alerts quiet 22:00-07:00`); `botwarren-companion alerts` shows and sets the computer-side switches. On iPhone and iPad the page explains that alerts need the Home Screen. The relay needs its own VAPID key pair (`RELAY_VAPID_PUBLIC_KEY`, `RELAY_VAPID_PRIVATE_KEY`); without it alerts are not offered. Design, the rejected alternative (reusing the website's push) and what each party can see: [docs/ALERTS.md](docs/ALERTS.md).
- **One service worker (`sw.js`)**, only for alerts: handlers for `push` and `notificationclick` and none for network requests; its SHA-256 is listed in the signed client manifest and the page refuses to register a copy that differs.
- **A replace key in the signed message header** (`r`, optional, opaque): the relay keeps only the newest queued frame per sender and key. The computer marks every `state` frame, so a phone that was away finds one queued state (the latest of every session, with the request that is pending now) instead of a pile; when a queue is full the oldest frame without a key goes first. Counters `queue_replaced`, `push_*`; `POST /admin/push` switches alerts off at once.
- `botwarren-companion claude register-channel [--yes]` now registers the channel (`claude mcp add`), and replaces a registration made by 0.1.1.
- Windows, macOS and Linux: command lines written into Claude Code's settings use forward slashes on Windows and quote spaces (macOS "Application Support").

### Fixed

- **The computer sent a frame for every hook event.** Every `PostToolUse` of every session produced a state message, which overflowed the relay's queue while the phone was away (46 queued and 51 dropped in the first test). A state that is unchanged since the device last got one is not sent again, non-urgent changes are sent at most every 2 seconds (a request appearing or going is still immediate), and a device that asks to sync always gets the state.
- **"Connection refused" on the daemon socket after `enroll`.** When a service restarted the daemon, the stopping daemon deleted the new daemon's socket (the runtime removes the path a server was bound to when it closes). Now the stopping daemon leaves a replacement alone, a daemon checks every 5 seconds (and on SIGHUP) that its socket file is still the one it created and binds again if it was removed or replaced by a dead file, and a daemon refuses to start on a socket another live daemon answers on. `enroll` at a terminal waits until the service has started the daemon again and says so; when a command cannot reach the daemon it says whether the socket is stale or the daemon is not running, and names the service's restart command (`systemctl --user restart botwarren-companion`, `launchctl kickstart -k ...`) when a service unit exists.
- **Claude Code settings broke on every update.** `claude install-hooks` and the channel registration wrote `.../versions/0.1.1/companion.mjs`. They now name a stable launcher (`launch.mjs`) in the companion's own folder, which runs whatever version the daemon last started as (`entry.json`, rewritten at every daemon start). `install-hooks` finds hooks with a per-version path, says so, rewrites them (with a backup, keeping the user's own hooks), and `claude doctor` flags them. An installer update moves a background service from an earlier install to the new version and restarts it.
- **`install-hooks` without a terminal silently did nothing.** Commands that ask a question (`install-hooks`, `register-channel`, `uninstall --purge`) print "Re-run with --yes to apply it" when no terminal is attached, instead of waiting for an answer that cannot come; input on a pipe is never taken as consent.

### Changed

- `botwarren-companion status` shows the alert setting; `claude doctor` checks the launcher, hooks and channel registration.
- Docs: [ALERTS.md](docs/ALERTS.md) (new), PROTOCOL (replace key, `push`/`pushack`, relay push, threat rows T10 and T11), RELAY (VAPID configuration), CLIENT_SECURITY (the worker).

### Known limits

- Alerts need a relay with VAPID keys and a browser with Web Push; on iPhone only from the Home Screen (the Home Screen app is a separate pairing). The relay and the push service can see *when* an agent started waiting.
- The text of what a worker shows when no page is visible is tested against the real file with a stand-in scope; headless Chrome has no notification centre to read back.
- The Windows and macOS paths (`.cmd`, launchd, the Startup folder) have unit tests and CI but little manual testing.

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

# Botwarren Companion

[![CI](https://github.com/turbokast/botwarren-companion/actions/workflows/ci.yml/badge.svg)](https://github.com/turbokast/botwarren-companion/actions/workflows/ci.yml)
[![CodeQL](https://github.com/turbokast/botwarren-companion/actions/workflows/codeql.yml/badge.svg)](https://github.com/turbokast/botwarren-companion/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/turbokast/botwarren-companion/badge)](https://scorecard.dev/viewer/?uri=github.com/turbokast/botwarren-companion)
[![Release](https://img.shields.io/github/v/release/turbokast/botwarren-companion?include_prereleases&sort=semver)](https://github.com/turbokast/botwarren-companion/releases)
[![Licence: Apache-2.0](https://img.shields.io/badge/licence-Apache--2.0-blue.svg)](LICENSE)

Opt-in, end-to-end encrypted **remote approvals and control** for your coding agents. From your own paired phone or browser you can see when an agent is waiting for you, read its pending question or permission request, follow a live tail of what it is doing, and answer with **approve, deny or a preset reply**.

**New in 0.3.0: remote control.** If you turn it on at your computer, and only for a device you grant it to, that device can also send the agent a **free-text prompt**, **stop** it (a soft stop, see below), answer its questions and, where the tool supports it, **start a session** in a project you listed. Free text and starting are guarded by a fingerprint, face or screen-lock check on the device (WebAuthn, verified by your computer, not by us). Control is **off after an install or upgrade** until you run `botwarren-companion control on`. It is for the owner only: nothing a visitor to the Botwarren website does can cause any of it. Tool output is not in the live tail unless you switch it on for a session, there is no file transfer, and a session that runs without approval prompts is observe-only. Details, per tool, are in [Remote control](#remote-control-030) below.

This repository is the whole thing: the program that runs on your computer (the **companion**), the **relay** that carries encrypted messages between your computer and your devices, and the **web client** you answer from. The [Botwarren](https://botwarren.com) website and hosted service are separate and are not part of it.

It is a **separate program** from the metadata-only [Botwarren ship agent](https://github.com/turbokast/botwarren-ship). The ship agent's promise (it never reads your prompts, code or output) stays literally true. This program does read your agent's own words on your computer, which is exactly why it is separate, off by default, and open source.

> Status: pre-release (0.3.x). Offered only to accounts that were explicitly enabled and have agreed. **No independent security review has been done yet.** That is an accepted risk, and it is why you should read the next section before turning it on.

## How it works

```mermaid
flowchart LR
  subgraph computer["Your computer"]
    C["Claude Code"] -->|"hooks / channel (local)"| D["Companion daemon<br/>keys stay here"]
  end
  D <-->|"sealed frames (ciphertext only)"| R["Relay<br/>cannot read or forge them"]
  R <-->|"sealed frames"| W["Signed web client<br/>keys stay in your browser"]
  S["botwarren.com"] -.->|"says which accounts may use it; signs enrolment tickets<br/>never sees keys or content"| R
```

1. The companion on your computer holds a signing key and an encryption key. Your phone or browser holds its own keys, created when you pair it, kept as non-extractable browser keys.
2. Every message between them is encrypted to the receiving device's key (HPKE, RFC 9180) and signed by the sender (Ed25519). The relay forwards opaque, size-padded frames and keeps nothing durable (a short in-memory queue, 15 minutes at most).
3. Pairing uses a one-time code shown **on your computer** (text and QR). You confirm on the computer that the six-digit check matches the one on the phone. Nothing is paired from the website.
4. When Claude Code asks you something, the companion tells your devices. When you answer, the companion checks the answer against the request that is pending *right now*, and only then delivers it.
5. With remote control on (0.3.0), your device can also send a command (a prompt, a stop, a free-text answer, a start). Each command is signed by the device, expires after 60 seconds, carries a fingerprint of what the device was looking at (a prompt for a session that has since moved on is refused as stale), and is checked by **your computer** against the device's scope, the limits and the tool's own capabilities before anything is delivered. The text the agent receives is marked as coming from your paired device.

## The security model, in plain words

* **The relay and the Botwarren website cannot read your messages and cannot forge one.** They carry ciphertext. They never hold a device key.
* **The server cannot read it unless we serve you malicious code.** The web page you answer from is served by Botwarren (from the relay's own cookie-less origin). It is built reproducibly from this repository, signed with the Botwarren component signing key (a non-exportable Google Cloud KMS key, separate from the key that signs the ship agent's updates, that only this repository's release workflow can use) and checked by a small loader before it runs. If our servers were taken over, they could serve you different code that reads what you see and approves requests. Signing lets a reviewer detect that; it does not stop it for you in the moment. A native app or a browser extension would remove this caveat, and is on the path ([docs/CLIENT_SECURITY.md](docs/CLIENT_SECURITY.md)).
* **What a bad client can do is limited by your computer, not by the client.** Out of the box (and for every device until you say otherwise) the companion accepts only approve, deny and a preset reply from a list on your computer, for a request that is pending now and that matches what the device displayed (a hash of the request is echoed back); the words delivered are then never the client's. Free text, start and the live tail exist only when you turned remote control on at your computer **and** gave that device the `control` scope; a device cannot raise its own scope. Every command is also subject to a rate limit (by default 10 prompts and 5 starts an hour), a pause switch, a per-device revoke, a kill switch (`control off`) and optional "confirm on this computer" for every command.
* **Free text is remote command execution, so it has extra gates.** A prompt or a free-text answer needs a recent step-up on the device: a fingerprint, face or screen-lock check (WebAuthn, user verification required) that your computer verifies itself against the key registered when you added it. A step-up opens a **15-minute window** for prompts; **starting a session always needs a fresh one**. A device without a registered credential cannot be stepped up, so you confirm each such command at the computer instead. A prompt is at most 4,000 characters, plain text, and one that begins with `!` or `/` is refused on any route that would type it into a terminal. **Honest limit:** a step-up does not show the device what it signs, so it protects against a stolen unlocked page, injected script or a stolen cookie, but **not against a malicious web client that we ourselves serve** that shows you one text and sends another. Only "confirm every command on this computer" (`botwarren-companion devices confirm <name> on`), where your computer shows you the real text, closes that gap; it is a per-device option.
* **What the companion reads:** the agent's pending question or permission request (already masked by Claude Code), and the last three assistant messages (up to 24,000 characters each, 600 for a phone page from before 0.1.3) from the session transcript, masked for token-shaped strings before encryption. Text that does not fit is cut at the end and the phone says how much; a request that was cut cannot be approved from the phone. With remote control on, a device that may watch a session also gets a **live tail**: the assistant's text, your own prompts and one-line summaries of the tool calls (the command or file name), masked and cut the same way, kept only in the computer's memory (300 lines at most) and lost on restart. **Tool output is off by default**; you can switch it on for one session at a time at the computer (`botwarren-companion tools <session> on`), and then it is masked too. Never the terminal screen (except the labelled, off-by-default Herdr preview), and never a file.
* **No external security review yet.** The cryptography is standard primitives from WebCrypto, checked against the RFC test vectors, and the code is small. But nobody independent has reviewed the design or the code, and this README will not pretend otherwise. We will say so here until it has happened.
* **Metadata is visible to the relay operator:** connection times and addresses (transient), key-derived ids, a pseudonymous account tag, the device labels you chose, message counts and size buckets. The full table is in [docs/PROTOCOL.md](docs/PROTOCOL.md) section 9.

The protocol, the threat model (T1 to T12) and the accepted risks are in [docs/PROTOCOL.md](docs/PROTOCOL.md). Report a weakness privately: [SECURITY.md](SECURITY.md).

## Install and pair

The Companion is not installed by default. There are two ways to get it onto a computer, and both install **only** a bundle that passed the same checks: the Ed25519 signature of the component manifest (checked first) against the Botwarren component signing key, then the bundle's size and SHA-256, then its contents, and only then a self-test. The component key is a separate key from the one that signs the ship agent's own updates; it is pinned separately, and neither key is ever accepted for the other's job. If any check fails, nothing is installed and nothing from the download runs. Every release here publishes the signed bundle (`companion-<version>.zip`), the signed manifest, the installers and their hashes.

* **With the Botwarren ship agent** (0.7.1 or later for the commands below): the agent installs it when **your account has been offered it and you agreed** on your account page at botwarren.com (`botwarren companion status | remove | block`). The agent adds a `botwarren-companion` command next to `botwarren`, and every command below also works as `botwarren companion <command>`.
* **Without a ship agent** (see below): run the installer yourself.

### Install without a ship agent

For a computer that does not run the ship agent (for example a development machine that runs from source, or one where you prefer not to run an agent). It needs Node.js 22.13 or newer, no administrator rights, and an account that an admin enabled for remote approvals and that agreed on the account page (without that the website will not enrol the computer, so an install on its own does nothing).

```
# Linux and macOS (add `-s -- --service` to also run it in the background):
curl -fsSL https://downloads.botwarren.com/companion/install.sh | sh
# Windows PowerShell: download, read, run
Invoke-WebRequest https://downloads.botwarren.com/companion/install.ps1 -OutFile install.ps1
.\install.ps1 --service
```

The script is [`apps/companion/install/install.sh`](apps/companion/install/install.sh) (and `install.ps1`), generated from one reviewed program ([`installer.mjs`](apps/companion/install/installer.mjs)) and attached, with a build attestation, to every GitHub release; read it before you run it if you like (`sh install.sh --help`, `--dry-run` verifies everything and writes nothing). The key it trusts is written inside it; it downloads only `manifest.json`, `manifest.json.sig` and the zip from `downloads.botwarren.com/companion/` (https only), refuses a manifest that is expired, older than one it accepted before, for another component or blocked, extracts exactly four named files into `~/.local/share/botwarren-companion` (Windows: `%LOCALAPPDATA%\Botwarren\companion`), and adds the `botwarren-companion` command to `~/.local/bin` (Windows: `%LOCALAPPDATA%\Botwarren\bin`, added to your user PATH). Re-run it to update; `--uninstall` revokes your devices, removes the hooks, deletes this computer's keys and removes everything it installed.

Then, once:

```
botwarren-companion enroll      # prints this computer's PUBLIC key; paste it on botwarren.com/account ("Remote approvals" > "Enrol a computer"), paste the enrolment text back here
botwarren-companion daemon      # leave it running (or install with --service so a service manager does)
```

1. Agree on your account page (an admin must have offered it to the account first).
2. On your computer, run the companion's `pair` command (below). A code and a QR appear **there**, never on the website.
3. Open the link or type the code on your phone, compare the six digits, and answer `y` on the computer.

```
botwarren-companion pair                      # a code and QR appear HERE; open the page, type the code, compare the six digits, answer y
botwarren-companion claude register-channel   # registers the Claude Code channel (research preview) with `claude mcp add`; --yes to run it without asking
botwarren-companion claude install-hooks      # shows a diff, asks (or needs --yes without a terminal), backs up, adds fail-open hooks; also rewrites old per-version paths
botwarren-companion alerts [on|off]           # phone alerts: status and switches (idle turns, quiet hours); each phone also has its own switch
botwarren-companion status | devices | pause | resume | log
botwarren-companion devices revoke <name>
botwarren-companion control on|readonly|off|status   # remote control (0.3.0): off until you turn it on; see below
botwarren-companion uninstall --purge         # revokes devices, stops the daemon, removes hooks, deletes keys
```

`botwarren-companion` is the command the installer (or the ship agent) puts next to your other commands; it stands for `node companion.mjs` from the installed bundle (the same file the zip contains), or `pnpm --filter @botwarren/companion cli` in a checkout. With the ship agent, `botwarren companion pair` (and `devices`, `status`, `pause`, `resume`, `confirm`, `log`, `claude ...`) is the same thing; remove an agent-installed companion with `botwarren companion remove`, not `uninstall`.

### Alerts on your phone

Turn **Alerts** on in the phone page (gear icon). When an agent starts waiting for you, the phone shows **"An agent is waiting for you"** and nothing else (no tool, command, project or session text); tapping it opens the request. The computer seals each alert for your phone's own keys, so the relay and the push service cannot read it, and Botwarren's website is not involved. On iPhone and iPad alerts need the page on the Home Screen (pair again from there). Design, controls and what each party can see: [docs/ALERTS.md](docs/ALERTS.md).

### Remote control (0.3.0)

Off after an install or upgrade. At your computer:

```
botwarren-companion control on|readonly|off|status   # off: no tail, no prompt, no start (stop and approve/deny still work); readonly: tail and stop only
botwarren-companion devices grant <name> observe|answer|control   # per device; a new device is `answer` (approve, deny, preset reply, stop)
botwarren-companion devices confirm <name> on|off    # confirm EVERY command of this device at the computer (shows the real text)
botwarren-companion tools <session> on|off           # tool output in the live tail of one session (default off)
```

* **Owner-only.** The control screens live on the relay's own origin (the signed client), not on botwarren.com; the website only links to them, for the signed-in owner of the ship. A cookie, a GitHub login or an enrolment ticket cannot command anything: only a device you paired at your computer can, and only with the `control` scope that you granted at your computer.
* **Stop is soft.** A stop is delivered as the tool allows: for Claude Code at the **next tool call** (the tool call does not run and the turn ends); text the model is already generating and a tool that is already running are **not** cut. For OpenCode the server's own interrupt is used. The phone says "stops at the next tool call" and reports `sent` until the tool shows that it stopped.
* **Sessions that run without approval prompts are observe-only** (`--dangerously-skip-permissions`, Ninox workers, an approval policy of never): no prompt or start, unless you set `allowBypass` in `config.json` yourself. Stop always works.
* **Starting a session** needs an entry in the launch table you wrote in `config.json` (`control.launch`: a label, the tool and an absolute folder, which is never sent to a device) and a fresh step-up; the device picks an entry and a mode (never "bypass"), never a path or a command. Today only OpenCode can be started this way.
* **Allow-lists and limits at your computer:** per tool and per project folder (`control.harnesses`, `control.projects`), prompts 6 a minute and 10 an hour, starts 3 a minute and 5 an hour (configurable), a command for an offline computer fails visibly instead of running hours later.
* **Audit.** One local line per command (device, kind, outcome, length and a short hash of the text; never the text). A local-only full log with the text is a switch you turn on yourself (mode 0600, 30 days).

| Tool | Prompt | Stop | Questions | Start | What it needs |
|---|---|---|---|---|---|
| **Claude Code** | yes, through Channels (queued; delivered at the next tool boundary or next turn) | soft, at the next tool call | one single-select `AskUserQuestion`, free text for a `control` device (held up to 45 s) | no | A **claude.ai login**, Claude Code 2.1.234 or later, the session started with the channel flag, and on Team or Enterprise plans the organisation's `channelsEnabled`; for stop and questions the opt-in hook `botwarren-companion claude install-hooks --control` (a `PreToolUse` hook that does nothing unless control is on) |
| **OpenCode** (2.0.x, `opencode serve`) | yes | yes | forms with a single free-text field | yes | `adapters enable opencode`; a background service (a standalone TUI server is not reachable) |
| Codex, Muse | no | no | no | no | approve/deny as in 0.2.0 |
| Herdr, agy, Ninox, others | no | no | no | no | read only |

A prompt for a Claude Code session without a connected channel is refused as unsupported; one whose channel Claude Code did not load (for example without a claude.ai login) is reported `sent`, never `applied`. Nothing here makes a prompt or a stop more certain than the tool allows. Full wire detail: [docs/PROTOCOL3.md](docs/PROTOCOL3.md).

### More agents than Claude Code (0.2.0)

Codex, Muse, OpenCode, Herdr, Antigravity (agy) and Ninox are supported through **adapters**. What each reads, what can be answered from the phone and how safe each route is: [docs/ADAPTERS.md](docs/ADAPTERS.md). In short: Codex and Muse need a hook that **you** install with a command that shows the change first (`botwarren-companion codex install-hooks`, `muse install-hooks`) and that the tool makes you trust; answering them from the phone happens only while you said you are away, for at most 45 seconds, and Muse answering is off until you verified your version. OpenCode answers a request by its exact id with "once" or "reject" only (and, with remote control on, takes prompts, stops and starts, above). Herdr, agy and Ninox are read only ("Answer on your computer"); remote control does not type into any terminal pane. Anything that reads a screen or a local service (Herdr, OpenCode, agy, Ninox) is off until `botwarren-companion adapters enable <id>`. Nothing is ever approved by waiting, and no adapter can send "always allow".

### Claude Code requirements

* **Answering and prompting from your phone use Claude Code Channels**, which is a Claude Code **research preview** and may change. They need Claude Code 2.1.234 or later, a **claude.ai login** (Channels are unavailable with an API key or a redirected base URL: the session then looks promptable but nothing is shown to the agent, which is why a prompt is reported `sent` and never `applied`), and on Team or Enterprise plans an organisation owner must enable channels. Sessions are started with the channel flag that `claude register-channel` prints (an unlisted channel is loaded with the development flag until it is on the vendor's allow-list). With a channel, the terminal dialog stays open and whichever of the terminal and your phone answers first wins.
* **Without Channels** the companion still tells you that an agent is waiting (hooks: `PermissionRequest`, `Notification`, `Stop`), but it does not hold the terminal: `holdSeconds` is 0 by default. Whether a held hook leaves the terminal dialog usable is not documented; `botwarren-companion claude doctor` runs the live checks.
* **Stop and questions need one extra, opt-in hook.** `botwarren-companion claude install-hooks --control` adds a `PreToolUse` hook (every tool call passes through it, at the cost of one local round trip) that can end a turn at the next tool call after a stop, and hold one single-select `AskUserQuestion` for your phone. It states this before it asks, and does nothing unless `control` is on. `--no-control` removes only that hook.
* The companion never edits Claude Code settings silently: `install-hooks` shows the diff, backs the file up and marks exactly what it added so `uninstall-hooks` removes only that.

Defaults: `deny` and stop always work remotely; `approve` and preset replies work remotely for an enrolled user, each switchable to "always confirm on this computer" in `config.json`; free text, start and the tail are off until `control on`.

## Layout

| Path | What |
|---|---|
| `apps/companion/src/protocol/` | the shared protocol library (browser, relay, daemon): crypto, envelope, pairing, certificates, message schemas |
| `apps/companion/src/` | the daemon core (`host.ts`, `sessions.ts`, `policy.ts`, `mask.ts`), the relay connection (`link/`), the Claude Code bridge (`claude/`: hooks and the MCP channel server), the local socket, the `botwarren-companion` CLI |
| `apps/companion/client/` | the web client: verifying loader, app, build and signing scripts |
| `apps/companion/scripts/` | release tooling: build the component, finalise and verify manifests, package the relay image inputs, verify a release |
| `apps/companion/vendor/agent/` | verbatim copies of the few ship agent files the release tooling shares (the pinned public keys, manifest schema and verifier, archive writer, KMS client, component signer) |
| `apps/relay/` | the relay: WebSocket frame forwarding, pairing rendezvous, rate limits, kill switches, static hosting of the signed client |
| `deploy/Dockerfile.relay` | the relay image, built from a release's relay image inputs ([docs/RELAY.md](docs/RELAY.md)) |
| `docs/` | [PROTOCOL.md](docs/PROTOCOL.md), [PROTOCOL3.md](docs/PROTOCOL3.md) (remote control), [ALERTS.md](docs/ALERTS.md), [CLIENT_SECURITY.md](docs/CLIENT_SECURITY.md), [RELAY.md](docs/RELAY.md), [RELEASING.md](docs/RELEASING.md), [REPO_SETTINGS.md](docs/REPO_SETTINGS.md) |

## Develop

Node.js 22.18 or newer (the sources run directly with type stripping; `.nvmrc` says 24, which CI and releases use) and pnpm 11 (`corepack enable`).

```
pnpm install
pnpm typecheck
pnpm test        # protocol vectors (RFC 9180, 8032, 5869), tamper and replay, the relay, an end-to-end run with a simulated phone, release tooling
pnpm test:e2e    # the signed web client in a real browser (needs: pnpm --filter @botwarren/companion exec playwright install chromium)
```

On a busy machine run one test file at a time (`pnpm --filter @botwarren/companion exec vitest run test/e2e.test.ts`); the integration tests open loopback sockets and use real timers.

## Verify a release

Releases are built by [a public workflow](.github/workflows/release.yml) from a `v*` tag on `main`, built twice independently (the hashes must match), signed in a protected GitHub environment with the Botwarren component signing key through GitHub OIDC (no stored credential), and attested with GitHub build provenance. To check one you downloaded:

```
gh attestation verify relay-context-<version>.tar.gz --repo turbokast/botwarren-companion
node apps/companion/scripts/verify-release.mjs <directory with the release files>
```

The second command trusts only the public component key pinned in this repository (`kms-comp-2026a`): it checks `SHA256SUMS`, the client signature and every client file, the component signature and the bundle it describes, and that the relay image inputs hold exactly the signed client. More in [docs/RELEASING.md](docs/RELEASING.md).

## Contributing, support, governance

[CONTRIBUTING.md](CONTRIBUTING.md) (sign off your commits: DCO), [SUPPORT.md](SUPPORT.md), [GOVERNANCE.md](GOVERNANCE.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), [MAINTAINERS.md](MAINTAINERS.md). Security reports: [SECURITY.md](SECURITY.md).

## Licence

[Apache-2.0](LICENSE). Copyright 2026 TurboKast Ltd. "Botwarren" and "TurboKast" are names of TurboKast Ltd; the licence does not grant use of the names beyond describing where the software comes from ([NOTICE](NOTICE)).

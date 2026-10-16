# Security policy

The Botwarren Companion runs on your computer next to your source code and credentials, reads what your coding agent says, and lets your own devices answer it. Its security properties matter more than its features.

**Read this first:** no independent security review of the design or the code has been done yet. That is an accepted and published risk, and the reason why reports are especially welcome.

## Reporting a vulnerability

Email **support@turbokast.com** with the subject `SECURITY: botwarren-companion`. Please include what you found, how to reproduce it, the Companion version (`botwarren-companion version`) and your operating system. Do not open a public issue or pull request for a vulnerability, and do not include real secrets, pairing codes or messages from your agents in your report.

You may also use GitHub's **private vulnerability reporting** on this repository ("Security" tab, "Report a vulnerability"): it is enabled, only the maintainer sees the report, and a fix can be prepared in a private fork before disclosure.

## Coordinated disclosure

* We acknowledge a report within **3 working days** and give an initial assessment within **7 days**.
* We work with you on a fix and keep you informed. Critical and high severity issues aim for a fixed release within **30 days** of the report, others within **90 days**.
* We ask that you keep the details private until a fixed release is available, or until **90 days** after your report, whichever comes first. If we need longer for a complex fix we will say so and agree a date with you; if you believe users are being actively harmed you may shorten the period, but please tell us first.
* We publish a security advisory with the fix, crediting you if you wish. We are not able to offer a bounty at this time.
* Good-faith research is welcome: test against your own installation and your own relay, do not access other people's data, do not degrade the hosted relay, and stop and tell us if you reach someone else's data. We will not pursue action against researchers who follow this policy.

## What counts

Especially welcome (high impact):

* anything that lets the relay, the Botwarren website or a network observer **read** a message, or **forge or replay** one (the envelope, HPKE use, signatures, counters, expiry, key rotation, pairing: [docs/PROTOCOL.md](docs/PROTOCOL.md))
* a way for a remote device, or a malicious web client, to do **more than its scope allows**: free text, a start or a tail reaching or leaving an agent when remote control is off or the device lacks the `control` scope; skipping the WebAuthn step-up or the local confirmation; a command accepted after it expired, twice (`cid`), or for a session other than the one displayed (the `bind` check); a prompt into a session that runs without approval prompts; tool output in the live tail while it is off; exceeding the rate limits; anything that lets a command name a path, a command line or a flag
* a pairing weakness: a code that can be guessed, a pairing that completes without the local confirmation, a relay that can read or tamper with the exchange
* a bypass of the web client's verification chain: the loader running code that is not in the signed manifest, an unsigned or wrongly signed client being accepted, a relay or origin issue that lets other script run on the client origin (CSP, cookies, headers)
* a way for a web page, another local user or a local process to reach the companion's local socket or the hook endpoint, or to read its keys (they must not leave the local user's own files)
* anything in the release chain: publishing or signing something that was not built from a reviewed tag, a signature that verifies for the wrong purpose (domain separation between the client, the component and the agent's updates), a component bundle that installs files other than the four allowed
* content (messages, paths, keys) reaching a log line, an audit entry, the relay's logs or the signed kill list

Out of scope: vulnerabilities in the tools the Companion observes (report those upstream), attacks that need an already compromised user account on the same machine (the companion's socket is 0600 in a 0700 directory, and the same user can already do everything), a stolen and unlocked phone with the client open, and denial of service by a local user against their own companion.

## Known limits (not vulnerabilities, but you should know)

* **The web client is served by Botwarren.** It is signed and checked by a loader before it runs, but a compromised Botwarren origin or deploy pipeline could serve a client that reads what you are shown (with remote control on, also the live tail) and approves pending requests or, with remote control on and a stepped-up device, sends prompts. A step-up (WebAuthn) does not protect against that, because an authenticator does not show what it signs; only "confirm every command on this computer" for that device does. The companion limits what any client can do ([docs/CLIENT_SECURITY.md](docs/CLIENT_SECURITY.md) explains the choice and the path to stronger clients).
* **Forward secrecy** is per key rotation (every 7 days when all devices are online), not per message.
* **Claude Code's Channels feature is a research preview** and may change.
* **No external review yet.**
* The relay is a single machine today (availability, not confidentiality).

## Supported versions

Only the latest release is supported.

## Release integrity

Every release is built by the release workflow in this repository from a `v*` tag, twice independently (the hashes must be identical), signed in a protected GitHub environment that needs an approval, and carries a GitHub build attestation. The web client and the component are signed with a non-exportable Google Cloud KMS Ed25519 key, `component-signing`, that is **separate from the key that signs the ship agent's updates** (a different key, a different service account, a different pinned key set in the agent, which rejects each key's signatures when they are presented for the other's job); its public half is compiled into this repository and the ship agent, and the key can be used only by this repository's release workflow (through GitHub OIDC workload identity federation, with no stored credential). How to verify a release is in the [README](README.md#verify-a-release); the process is in [docs/RELEASING.md](docs/RELEASING.md). Approval of a release is currently by a single maintainer (a deliberate pause, not two-person control).

## How this repository is kept safe

* **Automated checks on every change:** CodeQL code scanning (JavaScript, TypeScript and the GitHub Actions workflows), a dependency review on pull requests (known vulnerabilities and a licence allow-list), strict TypeScript and tests on Linux, macOS and Windows, the web client in a real browser, a reproducible-build check, `zizmor` and `actionlint` for the workflows, and the OpenSSF Scorecard.
* **Secret scanning with push protection** is on; Dependabot security updates and version updates are on.
* **Workflows** use only actions pinned to a full commit SHA, the narrowest permissions per job, and give pull requests from forks no secret.
* **`main` is protected** by a ruleset (pull requests, required checks, no force pushes, linear history), and `v*` tags cannot be moved or deleted. See [docs/REPO_SETTINGS.md](docs/REPO_SETTINGS.md) for the exact settings and their honest limits (the sole maintainer can bypass the ruleset).
* **Vulnerability disclosure** is described above. Fixed vulnerabilities are published as GitHub security advisories.

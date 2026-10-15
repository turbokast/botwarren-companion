# Companion client security: which client, and how Claude Code can be answered safely

Status: research and decision for version 1. Protocol: [PROTOCOL.md](PROTOCOL.md). Licence of this document: Apache-2.0.

Evidence labels: **doc** = read in the vendor's own documentation on 2026-10-15 (the Claude Code documentation, RFC 9180 text); **secondary** = search summary, not re-read at source; **memory** = general knowledge, not re-verified; **design** = our own reasoning. Confidence is stated per point.

---

## Part 1. Which client is the safest we can actually ship?

### 1.1 The problem, stated exactly

The relay and botwarren.com only ever carry ciphertext, and they cannot forge a message because they do not hold any device key. The hole is the client: whoever serves the code that holds the device keys and shows the plaintext can read and act on everything. For a web client that "whoever" is Botwarren (and Cloudflare in front of it, and anyone who compromises our deploy). So "the server cannot read your agents" is only true as: *unless it also serves you malicious client code* (threat T3 in [PROTOCOL.md](PROTOCOL.md)). The choice of client decides how strong that sentence can be made, at what cost.

What a malicious or compromised client could do in this product, given the v1 limits (design, high confidence):

* read the pending question and the last few messages of every paired agent (confidentiality loss; the main harm);
* approve or deny a *pending* request without the user (integrity harm) and trigger one of the preset replies;
* it can NOT send free text, run a command, or read terminal output, because the companion on the user's machine only accepts four action kinds, maps quick replies from a host-side preset list, and checks every action against a request that is currently pending. The client's reach is therefore bounded by the companion, not by the client.

### 1.2 Options compared

| | (a) Web client, signed bundle, verified by a pinned loader / extension / service-worker scheme | (b) Native mobile apps (iOS + Android) | (c) PWA with SRI and a verified bootstrap | (d) Other: companion pins the client; hardware key per send; text-only fallback |
|---|---|---|---|---|
| Who controls the code the user runs | We, but a pinned verifier outside our server can detect tampering | App store review plus our signing key; user updates are explicit | We, via our server; verification only as strong as where the first loader came from | n/a |
| Defeats "our server serves malicious JS" | Only if the verifier is NOT served by us: an extension or a native wrapper. A service worker is served by us and can be replaced on the next update check, so on its own it is not a defence (doc-level fact of the SW lifecycle: the browser re-fetches the SW script, bypassing HTTP cache for at most 24 h; **memory**, high confidence) | Yes, apart from a forced store update, which leaves a public trace | Partly: stops tampering below the origin server (object store, CDN cache, partial or poisoned deploy), not the origin itself | Does not address it |
| Cost for a solo maintainer | Extension: three store reviews (Chrome, Firefox, Safari) for desktop only; no mobile (iOS Safari extensions exist but are heavy; Chrome on Android has no extensions) | Two codebases or a shell (Capacitor/React Native), Apple Developer programme (paid), Google Play, review cycles, push certificates, crash handling, long-term upkeep | Cheap: static files, one build | Small |
| Store review / policy | Required for extensions | Required; remote-control apps that execute agent actions draw attention; background push needs APNs | None | none |
| iOS limits | Extensions: only Safari, only in an app bundle. Web Push needs Home Screen install (**secondary**, consistent); storage is evictable after 7 days of non-use in Safari tabs (**secondary**, mixed evidence for installed apps), so a device key can disappear and must be re-paired | Best: Secure Enclave keys (P-256 only; Ed25519 is not hardware-backed on iOS, **memory**), reliable push | Home Screen install needed for push; no Secure Enclave from WebCrypto; WebAuthn passkeys available | n/a |
| Key storage | WebCrypto non-extractable keys in IndexedDB (usable by page code, not exportable) | Keychain / Keystore, hardware-backed where possible | Same as web | n/a |
| Reproducibility / auditability | Good if built reproducibly from the public repo and signed | Good, but stores re-package | Good | |
| Time to a safe v1 | Weeks | Months | Days to a couple of weeks | |

Browser primitives (doc, medium-high confidence): Ed25519 and X25519 are in WebCrypto in Firefox 129/130 and later, Safari 17+/Safari 18+ and Chrome 137+ (Chrome shipped Ed25519 in May 2025 per an IPFS post; X25519 timing is less clear, **secondary**). AES-GCM, HKDF and SHA-256 are universal. ChaCha20-Poly1305 is not in WebCrypto, which is why the protocol uses AES-256-GCM (design). The client refuses to start (with a plain message) if the browser lacks Ed25519/X25519.

### 1.3 Reasoning

1. **A native app is the strongest answer to "server serves malicious JS" and the wrong first answer for a solo maintainer.** It costs two store pipelines, an Apple programme, and a standing review burden, for a feature enabled for one account. It is the right later step if the feature is offered to many people (see 1.5).
2. **A browser extension fixes the web caveat but not on the device where it matters (a phone).** Chrome for Android has no extension support; iOS Safari extensions require a wrapper app. Desktop-only is a poor fit: the whole point is answering from a phone.
3. **A service-worker integrity scheme does not stop our own server**, because the browser takes the next service worker from our server too. It is still useful for the weaker, realistic adversaries: a poisoned CDN/object-store object, a partial deploy, a stale cache. It also makes silent change visible if we publish hashes. The scheme must never be described as protection against Botwarren.
4. **The companion bounds what a bad client can do** (1.1). That, not the client, is the main control in v1. So the client can be a signed web client now, with a documented upgrade path to a pinned native or extension wrapper without changing the protocol.
5. **A cookie-less, isolated origin removes the largest accidental exposure.** XSS or CSRF elsewhere on `*.botwarren.com` (ship subdomains, the account pages, analytics) can never ride into the companion client because it lives on its own origin (the relay's), carries no analytics, no third-party script and no cookies, and authenticates only with device-key signatures.

### 1.4 Decision for v1

**Choice: (c) strengthened towards (a) and bounded by (d): a PWA-style web client on the relay's own cookie-less origin, delivered as a build signed with our KMS component signing key and started by a small verified bootstrap loader.** Concretely:

* the client is a static bundle built reproducibly from the open-source repository (`apps/companion/client`); its `manifest.json` lists the SHA-256 of every file; the manifest is signed with an Ed25519 component signing key (a Cloud KMS key that is not the ship agent's update-signing key) and the signature domain-separated (`botwarren-client-v1\0`), with pinned keys and a trust-epoch model like the ship agent's updater ([RELEASING.md](RELEASING.md));
* `index.html` contains no inline script, loads only the loader with an SRI hash, and a strict CSP (`default-src 'none'; script-src 'self' blob:; connect-src 'self' wss:`; no third-party origins at all);
* the loader (about 150 lines, containing the pinned public keys) fetches the manifest and signature, verifies the signature with WebCrypto, fetches each file, checks its hash, and only then starts the app. It refuses to run on any failure and shows the failure;
* no service worker in v1 (it adds a second place for update trust to go wrong, and a push worker can be added later without protocol change);
* the build id (first 12 hex of the manifest hash) is shown in the client and printed by `botwarren-companion status`, and the signed manifest for each released build is published (the downloads host plus the release assets), so a user or a reviewer can compare;
* device keys are non-extractable WebCrypto keys in IndexedDB;
* optional later: passkey (WebAuthn) as a second factor to unlock a send window.

**The honest public sentence** (to be used word for word on the trust page): *"Botwarren's servers carry only encrypted messages and cannot read or forge them. The web page you use to answer your agents is served by Botwarren, signed with our release key and checked by a small loader before it runs. If our servers were taken over they could serve you different code; signing lets a reviewer detect that, and the companion on your machine limits what any client can do to approving, denying and sending preset replies."*

Accepted residual risk (recorded): a compromised Botwarren origin or deploy pipeline can serve a client that reads plaintext shown to the user and approves pending requests. Mitigated by: a limited rollout; companion-side limits; signed and published builds; per-request binding and local confirmation options ([PROTOCOL.md](PROTOCOL.md) section 6); an external review is planned before the feature is widened.

### 1.5 Path to stronger, in order

1. Publish a transparency list of signed client manifests (append-only, hash-chained, same pattern as the admin audit log) and have the companion fetch it and warn if the served build id is not on it.
2. A signed native wrapper (Capacitor or a Tauri/Android shell) embedding the same bundle and the pinned keys, installable from a store or sideload, so the verifier is no longer served by us. Same protocol, same code.
3. Passkey-gated key use (WebAuthn PRF to wrap the device key, user verification per send window).
4. A desktop extension (Chrome and Firefox) for people who answer from a laptop.

---

## Part 2. How the companion reads a pending question and answers it, locally and safely (Claude Code)

All of this is the **doc** column from the Claude Code documentation read on 2026-10-15 unless marked otherwise. Claude Code changes quickly; every point has a confidence and a live check.

### 2.1 Integration points

| # | Mechanism | What it gives | What it cannot do | Confidence |
|---|---|---|---|---|
| 1 | **Channels** (`claude/channel` MCP capability, research preview). A local MCP server declares `experimental['claude/channel']` and `experimental['claude/channel/permission']`; Claude Code sends `notifications/claude/channel/permission_request` (`request_id` of five letters a-z without `l`, `tool_name`, `description`, `input_preview`, all sanitised and credential-masked by Claude Code) and the server answers with `notifications/claude/channel/permission` (`request_id`, `behavior: allow|deny`). The local terminal dialog stays open **in parallel; whichever answers first wins and the other closes** (doc). The server can also push `notifications/claude/channel` events that arrive as `<channel source="...">` text, which is the supported way to deliver a message to a running session. | Approve/deny with the local dialog still live, an official sender-trust model (our companion is the sole sender; only host-side presets can become text), provenance tag in the session | Needs `--channels` (or `--dangerously-load-development-channels server:<name>` for an unlisted channel) at session start; research preview; on Team/Enterprise an Owner must enable channels (`channelsEnabled`); claude.ai login required (**doc**); Claude Code 2.1.234+ sends permission requests only to servers registered as channels (doc). Project trust and MCP consent dialogs do not relay | doc, high. Live behaviour on a real setup: unverified |
| 2 | **`PermissionRequest` hook** (command). Input: `session_id`, `transcript_path`, `cwd`, `permission_mode`, `tool_name`, `tool_input`, `permission_suggestions`. Output `hookSpecificOutput.decision.behavior = allow|deny` (+ `message` for deny, `interrupt`). Exit 2 or no decision leaves the normal flow. A hook `allow` does not override deny/ask rules. For SDK `canUseTool` and `--permission-prompt-tool`, hooks run alongside and whichever decides first wins (doc). Default hook timeout 600 s (doc) | Works in any interactive session with no startup flag, no org enablement; fires the moment the prompt is raised | Whether the interactive terminal dialog stays usable *while* the hook is still running is **not documented**; the doc only says "alongside" for the SDK path. If the dialog waits for the hook, holding the hook would delay local answering. | doc for the schema, high; concurrency in the TUI **unverified**, medium-low |
| 3 | **`Notification` hook**, matchers `permission_prompt`, `idle_prompt`, `elicitation_dialog`. Input: `message`, `title`, `notification_type`. Fires only when the user appears away: `permission_prompt` after about 6 s without typing, `idle_prompt` about 60 s after Claude finished. No decision control | A free "waiting for input" signal with no startup flag | Cannot answer; delayed by design | doc, high |
| 4 | **`Stop` hook**. Fires when a turn finishes; `{"decision":"block","reason":"..."}` makes Claude continue with `reason` as its next instruction; `stop_hook_active` guards re-entry | The "turn finished, waiting for you" moment; a hook can inject a continuation | Holding it open would stall the terminal; injecting via `reason` is a hack that is not meant for chat | doc, high; the Stop input does not document a `last_assistant_message` field, so use the transcript |
| 5 | **`PreToolUse` on `AskUserQuestion`** with `updatedInput.answers` | Answer an agent's multiple-choice question without prompting (doc example) | Needs the hook to hold or know the answer at call time | doc, medium (example in docs; behaviour not run) |
| 6 | **Transcript** JSONL at `transcript_path` | Last assistant text blocks for "last few messages" | Content, so only the companion (never the ship agent) may read it; format is not a public contract | doc for the path, memory for the format, medium |
| 7 | Terminal injection (tmux/Herdr/pty) | Works anywhere | Keystroke injection; no provenance; explicitly rejected for v1 | n/a |

### 2.2 Decision

* **Primary route for answering: Channels (1).** It is the only documented mechanism where the terminal dialog and the phone are live at once, with provenance, and with the vendor's own sender-allowlist model; it is also how a quick reply reaches an *idle* session. The companion ships a stdio MCP channel server (`botwarren-companion channel`) that the user registers once (`botwarren-companion claude register-channel` prints and, with consent, runs `claude mcp add`; session launch uses `--dangerously-load-development-channels server:botwarren-companion` until the channel is allowlisted).
* **Fallback and read-only signal: hooks (3, 2).** `botwarren-companion claude install-hooks` adds `PermissionRequest`, `Notification` and `Stop` hooks that talk to the companion over its local socket. By default the hooks **do not hold** (they report and return immediately, so local use is never delayed); they only hold when the user has set `holdSeconds` after confirming, with `botwarren-companion doctor --claude-live`, that the terminal dialog stays usable while a hook waits. They always fail open (daemon down means no decision means normal Claude behaviour).
* The companion never edits Claude Code settings silently. `install-hooks` shows the diff, backs the file up, writes a marker so `uninstall-hooks` removes exactly what it added. Tests use a temporary HOME; nothing in this work touches the real `~/.claude`.
* Quick replies reach Claude **only** as a channel event whose text comes from the host-side preset list (the phone sends a preset id, never text). The preset list is short, editable only locally, and each reply is delivered with a provenance tag naming the device.
* For "what is pending": from the channel permission request (tool, description, input preview, already masked by Claude Code), from Notification/Stop hooks (type, message), and from the last assistant text blocks of the transcript, masked locally for token shapes before encryption. Tool output is never read.

### 2.3 Live checks you can run (the development tests never touch a real Claude Code installation)

1. `botwarren-companion doctor --claude-live`: guided check that (a) a channel-started session shows both the local dialog and the relayed request, (b) a held `PermissionRequest` hook does not block the terminal dialog. Outcome decides `holdSeconds` (0 if the TUI waits).
2. Confirm `channelsEnabled` for your Anthropic organisation and the Claude Code version (2.1.234 or later for permission relay to registered channels).
3. Confirm the unlisted-channel flag name against the installed Claude Code (`claude --help`), since it is research preview.

### 2.4 Codex and Ninox

* **Codex**: no documented inbound surface was found in the earlier research; v1 reports "waiting" only if a hook-like signal exists, and answers nothing. Not built; the agent-adapter interface in the companion (`AgentBridge`) is where it would plug in. Confidence low.
* **Ninox workers**: designed for, not built. They run with permission prompts bypassed and expose an unauthenticated loopback API, so a Ninox bridge must read only its status and send only through Ninox's own session API behind the same host-side action whitelist; per-session explicit acknowledgement; disabled by default.

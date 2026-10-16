# Botwarren Companion protocol 3 (remote control)

Status: companion 0.3.0 (first release with remote control). Control is OFF after an upgrade until the owner turns it on at the computer.
Code: message schemas and shared helpers in `src/protocol/control.ts` (import from `src/protocol/index.ts`); the host side in `src/control.ts`, `src/tail.ts`, `src/stepup.ts`; the client helper in `client/src/stepup.ts`.
Baseline: `docs/PROTOCOL.md` (envelope, pairing, relay). Protocol 3 only ADDS inner message kinds and optional state fields. The envelope, the relay and the pairing flow are unchanged.

## 1. What changes for whom

* A device says `proto: 3` in its `sync` (`PROTO_VERSION` is now 3). The host remembers it per device.
* A device that said 1 or 2 (or nothing) is never sent a protocol 3 kind, and never sees a protocol 3 field in `state`: the host builds its state exactly as before. A protocol 3 kind arriving from such a device is dropped and audited (`control_rejected` with `why=proto`), no answer is sent (an old page cannot parse one).
* Content stays end to end: every new kind is sealed device to host like `action`. The relay sees sizes (padding buckets), timing and the replace key only. No relay change is needed.
* Existing `action` (approve, deny, preset or option reply) is unchanged and still needs scope `answer` or higher.

## 2. Scopes (per paired device, enforced by the host)

| scope | allowed |
|---|---|
| `observe` | read `state`, `watch`, `history` |
| `answer` (default for every device, including ones paired before 0.3.0) | observe, plus `action` (approve, deny, preset reply, option reply) and `interrupt` |
| `control` | answer, plus `prompt`, free-text `answer`, `start` |

The owner sets it on the computer: `botwarren-companion devices grant <name> <observe|answer|control>`. The device cannot raise its own scope. Other owner commands: `control on|readonly|off|status`, `devices confirm <name> on|off`, `tools <session> on|off`.

Global switch on the computer: `botwarren-companion control off|readonly|on` (default **off** after an upgrade). `off`: no tail, no history, no prompt, start or free-text answer (interrupt and the old approve/deny keep working). `readonly`: tail and history, interrupt, but no prompt, start or free-text answer. `on`: everything the device's scope and the other gates allow. Optional narrowing in `config.json` `control`: `harnesses` (empty = all), `projects` (absolute folders, empty = all), `allowBypass` (default false).

## 3. Commands (device to host)

All commands carry `cid` (random, 16 to 32 characters of `[A-Za-z0-9_-]`) and `x` (expiry, ms since the epoch). Seal them with a TTL of 60 s (`COMMAND_TTL_MS`) so the relay never holds one longer; the host refuses a command whose `x` is past, or more than 90 s ahead.

| kind | data (strict) | scope | notes |
|---|---|---|---|
| `prompt` | `{cid, sid, bind, text, x}` | control | `bind` is `state.sessions[].ctl.bind` as shown. Text at most 4,000 characters, plain. Step-up required. |
| `interrupt` | `{cid, sid, bind, x}` | answer | Always allowed (even control `off`/`readonly`, bypass sessions, no step-up). Only `paused` and the rate bucket stop it. A stale `bind` does not refuse it. |
| `start` | `{cid, launchId, mode, text?, x}` | control | `launchId` is an `id` from `state.host.ctl.launch`; `mode` one of `default`, `acceptEdits`, `plan` (never bypass). Always needs a FRESH step-up. |
| `answer` | `{cid, sid, rid, bind, text, x}` | control | free-text answer to the pending `question` shown; `rid` and `bind` are the pending request's. Option answers stay `action`/`reply`. Step-up required. |
| `watch` | `{sid, on}` | observe | subscribe (lease 5 min, renew by sending again) or unsubscribe. At most 3 sessions per device (the oldest is dropped). |
| `history` | `{sid, q, before?, limit?}` | observe | pull older lines; `q` is the caller's token, echoed. `limit` at most 50. |

Replace keys for the device's own frames: `watch` uses `watchReplaceKey(sid)` (`w` + first 8 characters of the sid) so a reconnecting device leaves one heartbeat per session. Commands carry no replace key.

### Host-side checks, in this order (the first that fails answers; nothing after it runs)

1. protocol: the device must have said `proto >= 3` (else drop, no answer).
2. schema (strict). If a `cid` can still be read, `cresult{refused, why:"schema"}`.
3. duplicate `cid` from this device within 24 h: the stored `cresult` again with `dup:true`; nothing is done twice. Refusals that ask for a retry (`needs_stepup`, `refused`) are not stored, so the device may fix the cause and resend the SAME `cid`.
4. `paused` (local `botwarren-companion pause`): `paused`.
5. control mode (see section 2): `control_off`.
6. scope: `scope`.
7. expiry `x`: `expired`.
8. rate buckets, checked without spending: `rate`. Defaults: 6 actions a minute overall (shared with `action`; `maxActionsPerMinute`), prompts and free-text answers 6 a minute and 10 an hour, starts 3 a minute and 5 an hour (`promptsPerMinute`, `promptsPerHour`, `startsPerMinute`, `startsPerHour` in `config.json` `control`); `interrupt` has its own bucket (20 a minute, 300 an hour); `watch` and `history` 30 a minute each; step-up 20 begins a minute and 6 registrations an hour per device. A refused or failed check spends nothing; the buckets are spent together just before delivery.
9. target: `unknown_session`, `ended`, `harness` (not in the allowlist), `project` (cwd outside the allowlist), `unsupported` (the adapter does not declare that capability, see section 7), `bypass` (session `mode` is `bypass`, unless `allowBypass`; not for interrupt), `launch_unknown`, `mode_not_allowed`, `no_question`.
10. `stale`: `bind` differs from the host's current bind for the session (prompt, answer). The bind covers session id, session epoch, turn counter, status and the pending request id, so it changes when the agent starts a turn, stops, or asks for something.
11. content: `empty` (nothing left after cleaning), `size` (more than 4,000 characters), `keystroke_prefix` (the route is `keys` and any line starts, after leading white space, with `!` or `/`). The text is cleaned first (`cleanText`: terminal escapes, control and bidi characters removed); the cleaned text is what is delivered. The step-up digest is over the text exactly as the device sent it (before cleaning), because that is what the device knows.
12. step-up (section 4): `needs_stepup` (do it and resend the same `cid`) or `stepup_invalid` (a grant exists but is for a different text or target). A device with no registered credential, or with `confirm` on, goes to item 13 instead of 12.
13. local confirmation at the computer (`confirmer`, 60 s): `needs_local` is sent first; no or timeout is `local_declined`.
14. the bind is checked again (`stale`), then the rate buckets are spent, the step-up grant is consumed and the adapter delivers. Result: `sent` (delivered), upgraded to `applied` if the tool's own follow-up is seen within 10 s; `failed` if delivery failed; `busy` if the adapter says the agent cannot take it now.

### Result (host to device): `cresult`

`{cid, kind, outcome, why?, note?, sid?, dup?}`. `outcome` is `applied | sent | refused | needs_stepup | needs_local | failed`; `why` is one of `REFUSALS` for `refused`; `sid` is the new session for a `start` when the tool already reported it. TTL 5 min, no replace key.

## 4. Step-up (WebAuthn), verified by the host

The relay and the website are never trusted for it. The host stores the device's public key and verifies every assertion itself: `rpIdHash`, origin, challenge, type, user presence, **user verification**, signature, `signCount`.

* rpId is the host name of the relay the companion is enrolled with; the allowed origin is that relay's origin (the signed client page is served from it). The host sends both in each challenge.
* Algorithms: ES256 (-7), EdDSA (-8), RS256 (-257, 2048 bits or more). Attestation is requested as `none` and not verified (the owner confirms the registration at the computer instead).

### Registration (once per device, in band)

1. device `su_regbegin {}`.
2. The computer asks its owner at the keyboard ("add a fingerprint or face lock to device X?", local confirmation). No or 60 s: `su_regresult{ok:false, why:"declined"}`.
3. host `su_regchallenge {ch, exp, rp, origin, user, algs}`. The device calls `navigator.credentials.create` with `challenge = ch`, `rp.id = rp`, `user.id = user`, `authenticatorSelection {authenticatorAttachment:"platform", userVerification:"required", residentKey:"preferred"}`, `attestation:"none"`.
4. device `su_reg {ch, id, ao, cd}` (credential id, attestationObject, clientDataJSON, base64url).
5. host verifies (type `webauthn.create`, challenge, origin, rpIdHash, UP and UV flags, attested credential data present, id equal, algorithm and key valid) and stores `{id, alg, key, signCount}`; `su_regresult{ok}`.

### Assertion: unlock window and per-command

1. device `su_begin {for:"unlock"}` (opens a window, 15 min by default, for `prompt` and free-text `answer`) or `{for:"cmd", cid, kind, digest}` where `digest = commandDigest(kind, target, text)` (target is the `sid`, or `launchId + ":" + mode` for `start`).
2. host `su_challenge {ch, for, cid?, exp, rp, origin, cred}`; `ch` is `SHA-256("botwarren-stepup-v1\0" + purpose + "\0" + nonce + "\0" + digest)` (`stepupChallenge`), valid 60 s, single use, one outstanding per device.
3. device `navigator.credentials.get({publicKey:{challenge: ch, rpId: rp, allowCredentials:[{id: cred, type:"public-key"}], userVerification:"required"}})`, then `su_assert {ch, id, ad, cd, sig}`.
4. host verifies and answers `su_result {for, cid?, ok, why?, until?}`. `ok` for `unlock` opens the window (`until` = end, ms); for `cmd` it records a one-use grant bound to `(device, cid, digest)`, good for 2 min.
5. The command is then sent with the same `cid`. `start` ignores the window and always needs a grant. A grant is consumed when used, is only for that device, and does not match if the text, target or kind differ (`stepup_invalid`).
6. Failure codes (`su_result.why`): `scope`, `no_credential`, `no_challenge`, `expired`, `challenge` (tampered or wrong challenge), `origin`, `type`, `rp` (wrong rpId), `user_presence`, `user_verification` (UV flag missing), `signature`, `sign_count` (rollback: a counter that did not increase when either value is non-zero), `credential` (not this device's credential), `rate` (20 begins a minute), `malformed`, `control_off`. A failed attempt consumes the challenge.

Fallback: a device with no registered credential is never told `needs_stepup`; instead every `prompt`, free-text `answer` and `start` is confirmed by the owner at the computer (item 13). The owner can also require that for a device that has a credential (`devices confirm <name> on`), which is the only defence against a malicious served client that shows one text and sends another.

Honest limit (unchanged from the design): an authenticator does not show what it signs. Step-up defeats a stolen unlocked session, injected script and a stolen cookie, not a malicious served client.

## 5. Live tail and history

* `watch{sid,on:true}` starts a subscription. The host answers with the current window at once and then pushes `tail` frames at most once a second per session (`TAIL_MIN_GAP_MS`) while there is something new, until the 5-minute lease ends (the device renews by sending `watch` again). The relay lets one connection send 2 frames a second, shared with `state` and results, so tail frames also share a host-wide budget of one a second on average (burst 3) across every watching device and session; the watcher that has waited longest goes first and the frame is always the newest window, so waiting loses nothing.
* `tail` (host to device): `{sid, first, last, total, entries[], tools}`. A WINDOW of the newest lines that fits the frame budget (a newer frame replaces an older one at the relay: replace key `watchReplaceKey(sid)`, TTL 60 s). `first` greater than the device's last seen `seq + 1` means a gap: fetch it with `history`. `tools` says whether tool output is included.
* `history{sid,q,before?,limit?}` returns `hist {sid, q, entries[], more, tools}`: up to `limit` (50) lines with `seq < before` (newest if `before` is absent), oldest first; `more` says there are older ones. The host keeps at most 300 lines (256 KB) per session in memory only; history is bounded by that and is lost on restart.
* `TailEntry {seq, ts, k, text, cut?}`: `k` is `assistant`, `user`, `tool` (one-line summary of a tool call: command or file), `tool_out` or `note`. `text` is at most 4,000 characters; a longer line is cut at the end and `cut` says how many characters went.
* **Tool output is off by default.** `tool_out` lines are dropped when they arrive unless the owner turned them on for that session at the computer (`botwarren-companion tools <session> on`); turning it off removes those already held.
* The text is **plain text**: terminal escapes, control and bidi characters are removed; secret shapes and the home folder are masked (`mask.ts`, `~`); no line is interpreted. A client MUST render it with `textContent`, never as markup or links, and must never act on its content. The fixtures in `test/support/hostile-fixtures.ts` (prompt-injection text, ANSI, huge lines, fake UI markup) are for the client's own tests.
* Only sessions `ctl.can.tail` is true for may be watched.

## 6. State additions (protocol 3 devices only)

* `state.host.ctl`: `{mode, scope, stepup:"webauthn"|"local", confirm, unlockMinutes, launch[]}`. `launch` is `[{id, label, harness, modes}]` (never a path), present (possibly empty) for every proto 3 device but filled only for scope `control`.
* `state.host.devices[].scope`.
* `state.sessions[].ctl`: `{bind, route, can:{prompt, interrupt, tail, text}, why?, tools}`. `route` is how a prompt reaches the tool: `api`, `channel`, `hook`, `keys` (typed into a terminal: show a warning) or `none`. `why` explains `can.prompt:false`: `control_off`, `scope`, `bypass`, `unsupported`, `harness`, `project`, `ended`, `paused`. `can.text` says a pending question takes a free-text answer.

## 7. Adapter side (for adapter authors)

An adapter declares `manifest.control` (`prompt`, `interrupt`, `answer`, `start`, `tail`, `route`, `softInterrupt`) and, if any is true, implements `ControlAdapter` (`src/adapters/types.ts`): `sendPrompt`, `interrupt`, `answerText`, `startSession`. It never sees a device, a scope or a limit: the host decides and hands over text that was cleaned and carries provenance ("sent from paired device 'X' via Botwarren Companion"). Tail lines come in through `ctx.report.tail(key, items)` and the tool's own proof that a command took effect through `ctx.report.followup(key, 'prompt' | 'interrupt' | 'answer')`. Today only the OpenCode adapter declares control (route `api`: prompt, interrupt, one-line answer, start, tail); every other adapter declares none. `test/conformance/control.conformance.ts` is the suite every control adapter must pass; `test/support/fake-harness/` is the scripted fake. An adapter may also implement `sessionCaps(key)` to NARROW what one session can take right now (the host never widens: the manifest is the ceiling). Claude Code also declares control (route `channel`, section 9).

## 8. Audit

One line per command in `audit.log`: `{kind:"control", device (8 characters), c (command kind), outcome, why, len, sha256 (first 16 hex of the SHA-256 of the cleaned text)}`; never content. The owner can turn on a local-only full log (`config.json` `control.fullLog`, file `control-full.log`, mode 0600, kept 30 days) that includes the text.

## 9. Claude Code 

Code: `src/claude/bridge.ts` (the adapter), `src/claude/transcript.ts` (tail), `src/claude/channel.ts` (the MCP channel server), `src/claude/settings.ts` (hook installer). Manifest: `route: channel`, `prompt`, `interrupt` with `softInterrupt`, `answer`, `tail` true; `start` false. Verified against a real Claude Code 2.1.300 in an isolated test environment.

* **Prompt** (route `channel`). The host's framed text ("[Botwarren Companion: message from the owner's paired device "X"]" first, then the cleaned text) is pushed to the session as `notifications/claude/channel` with `meta {via: botwarren_companion, device, kind: prompt, msg: <nonce>}`; Claude Code shows it to the agent as `<channel source="botwarren-companion" via=... kind="prompt" msg=...>` and queues it (a busy session takes it on its next turn; an idle one starts a turn). Any `<channel` in the text is defanged so a prompt cannot close or forge a tag. Needs the session started with the channel (`claude --dangerously-load-development-channels server:botwarren-companion`, Claude Code 2.1.234+, claude.ai login, org `channelsEnabled`); a session without a connected channel is `unsupported` (per session, via `sessionCaps`). `sent` becomes `applied` when the nonce is seen in the `UserPromptSubmit` hook input or the transcript.
* **Interrupt is SOFT.** It arms a pending-stop flag. The companion's `PreToolUse` hook (opt-in: `botwarren-companion claude install-hooks --control`) consumes it on the session's next tool call and answers `{"continue":false,"stopReason":"Stopped from paired device ... at the next tool call ...","hookSpecificOutput":{"permissionDecision":"deny"}}`; the tool call does not run and Claude Code ends the turn. Later tool calls of the same turn are refused too (20 s). A text-only generation or a tool already running is NOT cut. Offered only once a `PreToolUse` call has been seen for the session (otherwise `unsupported`: a flag nobody consumes would be a lie), refused `busy` when the session is idle, expires after 5 minutes, cleared by the next prompt. The tail shows "stop requested ..." then "stopped at the next tool call (X was not run)"; the result is `sent`/`applied` (applied only if the stop happened within the follow-up wait).
* **AskUserQuestion.** Claude Code does not relay it through channels. With the control hook installed, a hold time set (`--hold`, at most 45 s) and a paired device online, ONE single-select question is held in the `PreToolUse` hook and shown on the phone as a question card (option buttons, plus free text for scope `control`); the answer returns as `permissionDecision: allow` with `updatedInput.answers {question: answer}` (hooks reference). Several questions, multi-select, no options, no hold or no device: not held, the terminal asks. Not answered in time: the hook returns nothing and the terminal's own question appears.
* **Tail.** Read from the session transcript (`transcript_path`, only under Claude Code's projects folder; the format is not a public contract): assistant text, one-line tool calls (`Bash: command`), the owner's prompts (channel messages shown as `[via botwarren-companion] ...`); thinking blocks, side chains and meta messages are skipped; tool results only when the owner turned tool output on for the session. Everything is masked and cleaned by the host.
* **Installer.** `claude install-hooks` is unchanged by default (no PreToolUse). `--control` adds the PreToolUse hook (matcher `*`, not async, timeout hold+10 s), `--no-control` removes only ours, neither keeps what is installed. The CLI states what the hook does before asking. The hook does nothing unless `control on`.

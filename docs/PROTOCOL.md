# Botwarren Companion protocol (v1) and threat model

Status: the specification of protocol version 1, as implemented in `apps/companion/src/protocol` and `apps/relay`. Licence of this document and the code it describes: Apache-2.0. Which client is used and how Claude Code is answered: [CLIENT_SECURITY.md](CLIENT_SECURITY.md). Reporting a weakness: [SECURITY.md](../SECURITY.md).

Goal in one line: from the user's own paired devices, see which agent is waiting, see its pending question or permission request and its last few messages, and answer with approve, deny or a preset quick reply, with the relay and botwarren.com seeing only ciphertext and unable to forge anything.

## 1. Roles

| Role | What it is | Holds |
|---|---|---|
| **Host** | The companion daemon on the user's machine | Host signing key (Ed25519), host encryption key (X25519, rotating), the paired-device list, a local audit log |
| **Device** | A paired phone or browser running the signed web client | Device signing key (Ed25519, non-extractable), device encryption key (X25519, non-extractable, rotating), the host's public keys |
| **Relay** | `botwarren-relay` (WebSocket) | Nothing durable about content. Verifies who may connect; forwards opaque frames; short in-memory queue |
| **Server** | botwarren.com | Decides which accounts may use the companion; signs host enrolment certificates (tickets) and the kill list. Never sees keys or content |

Out of scope for v1: free text, terminal output, tool output, file transfer, device-to-device messages, group/shared sessions.

## 2. Primitives (all standard; no homemade constructions)

| Use | Primitive | Where |
|---|---|---|
| Signatures | Ed25519 (RFC 8032) | WebCrypto in browsers and Node |
| Key agreement and message encryption | **HPKE base mode, RFC 9180**: DHKEM(X25519, HKDF-SHA256) kem 0x0020, HKDF-SHA256 kdf 0x0001, AES-256-GCM aead 0x0002 | implemented in about 100 lines over WebCrypto (X25519 `deriveBits`, HMAC for HKDF, AES-GCM). Checked against the RFC 9180 appendix A.1.1 test vector (AES-128-GCM variant of the same code path) |
| Pairing AEAD | AES-256-GCM, key from HKDF-SHA256 of the pairing secret | WebCrypto |
| Hash / ids | SHA-256 | WebCrypto |

Why HPKE and not a bespoke handshake: HPKE is a published, reviewed composition with official test vectors, available as "seal one message to a static public key". Why AES-GCM and not ChaCha20-Poly1305: ChaCha is not in WebCrypto, and the same code must run in the browser and Node.

**ID.** `id = base64url(SHA-256(raw Ed25519 public key))` (43 chars). Hosts and devices are named only by id on the wire.

**Encoding.** JSON, UTF-8. Binary fields are unpadded base64url. Signatures cover exact bytes (never re-serialised JSON): the signed header is carried as a base64url string, so there is no canonicalisation step to get wrong.

**Domain separation.** Every signature input starts with an ASCII domain string ending in NUL: `botwarren-link-v1/msg\0`, `.../cert\0`, `.../ticket\0`, `.../auth\0`, `.../revoke\0`, `.../killlist\0`, `.../keyupdate\0`. A signature made for one purpose never validates for another. The ship-agent release manifest uses a different prefix (`botwarren-manifest-v1\0`) and the companion component manifest another (`botwarren-component-v1\0`), so no cross-use is possible.

## 3. Keys and certificates

* **Host enrolment ticket (server-signed).** Issued by botwarren.com only for an account the admin has enabled and that has consented. `ticket = { v:1, acct, host: <hostId>, hostSig: <host Ed25519 public key>, iat, exp }`, signed with the server's ticket key `botwarren-link-v1/ticket\0 || ticketJSON`. `acct` is a pseudonymous tag, `base64url(HMAC-SHA256(serverSecret, "relay-acct" || accountId))[0:22]`, so the relay never learns the GitHub/GitLab identity. Lifetime 365 days. The relay verifies it with pinned server ticket public keys (env `RELAY_TICKET_KEYS`), statelessly. The ticket reaches the host in one of two ways: the ship agent asks the website for it with the ship secret (`POST /internal/companion/ticket`), or, for a computer without a ship agent, the person pastes the host's PUBLIC key into the account page (a signed-in session with a recent sign-in, rate limited, `POST /api/account/companion/ticket`) and pastes the same signed enrolment back into `botwarren-companion enroll`. Either way the website sees only the public key, and the ticket is bound to it.
* **Device certificate (host-signed).** `cert = { v:1, acct, host, dev: <devId>, sig: <dev Ed25519 pub>, kem: <dev X25519 pub>, name, iat, ctr }`, signed by the host key. `name` is chosen by the user and is visible only inside the pairing transcript and the cert the device presents to the relay (the relay sees it; it is a label such as "Alex's phone", never an account name; the UI says so). `ctr` is a per-host counter for cert generations.
* **Chain at the relay.** A device proves: server ticket (host key bound to account) then host-signed device certificate, then possession of the device key. The relay holds no registry of keys; it re-verifies the chain on every connect. A relay restart loses only the in-memory offline queue.
* **Encryption keys rotate.** Each principal has a current X25519 encryption key with an `epoch` number. Rotation announces the new public key in a `keyupdate` message (an ordinary encrypted message to each peer, signed by the envelope). Old private keys are kept 48 hours then deleted, which limits what a later key theft can decrypt. The host rotates every 7 days and only if every paired device was seen in the last 24 hours (otherwise it defers, so an offline phone cannot be locked out); a device rotates when asked or after 7 days.

## 4. Pairing (QR or short code, shown locally)

The user runs `botwarren-companion pair` on their machine (or clicks nothing on the website: the website is not involved). The host prints:

* a QR code and a clickable link `https://<relay-host>/#/pair/<CODE>`, and
* the same code as text: `CODE = Crockford base32 of 10 random bytes (80 bits), grouped XXXX-XXXX-XXXX-XXXX`, valid 10 minutes, single use.

The `#fragment` is never sent to any server. A user without a camera types the code into the client page.

Both sides derive, with HKDF-SHA256, salt `botwarren-link-v1/pair`: `rid = HKDF(secret, info="rid", 16 bytes)` (the rendezvous id the relay stores by), `K = HKDF(secret, info="key", 32 bytes)` (AES-256-GCM key). The relay sees only `rid` and AES-GCM ciphertext; with 80 random bits it cannot find the secret, so it can neither read nor tamper with the exchange.

1. **Offer.** The host (connected and authenticated to the relay) posts `offer = AEAD_K({hostSig, hostKem, hostEpoch, hostName, ticket}, aad="offer|"+rid)` for `rid`. The relay keeps it in memory for 10 minutes, one per host at a time.
2. **Request.** The device (unauthenticated HTTP to the relay, rate limited by IP) fetches the offer, decrypts it (proving it knows the code), generates its keys, and posts `req = AEAD_K({devSig, devKem, devName}, aad="req|"+rid)`.
3. **Short authentication string.** Both sides compute `SAS = decimal(first 20 bits of HKDF(hostSig‖hostKem‖devSig‖devKem, info="sas")) mod 10^6`, shown as `482 913`. The host terminal shows: device name, SAS, "does the phone show the same number?" and waits for local confirmation (`y`). The device shows the same SAS. This catches a shoulder-surfed code used by someone else (their device name and SAS will not be the user's).
4. **Result.** On local `y`, the host signs the device certificate and replies `res = AEAD_K({cert, certSig}, aad="res|"+rid)`; the offer is consumed. On `n` or timeout, nothing is issued and the rid is deleted.
5. The device stores the cert and the host's public keys. The host stores the device in its paired list (`devices.json`, 0600) and writes an audit line.

Every pairing attempt (offer made, request seen, accepted, rejected, expired) is written to the local audit log.

## 5. Envelope (what the relay carries)

```
frame  = { "t":"msg", "h": b64u(header), "c": b64u(ciphertext), "s": b64u(signature) }
header = { "v":1, "f":<from id>, "t":<to id>, "n":<seq>, "ts":<ms>, "x":<expiry ms>, "ep":<recipient key epoch>, "m":<msg id, 12 random bytes b64u> }
c      = enc(32 bytes, HPKE encapsulated key) || AES-256-GCM ciphertext
s      = Ed25519_sender( "botwarren-link-v1/msg\0" || header bytes || c )
```

* HPKE call: `SealBase(pkR = recipient's X25519 key for epoch ep, info = "botwarren-link/v1/msg", aad = header bytes, pt = padded inner message)`.
* **Padding.** Inner plaintext = `u16 length || JSON || zero fill` rounded up to 256, 512, 1024, 2048, 4096 or 8192 bytes, so the relay learns only a size bucket. A message that does not fit 8192 bytes is not sent.
* **Inner message** `{ "k": kind, "f": <from id>, "t": <to id>, "d": {...} }`. The receiver rejects the message unless inner `f`/`t` equal the header's (prevents re-wrapping someone else's plaintext under a different sender: "surreptitious forwarding").
* **Order of checks at the receiver:** header parse, `t` is me, `f` is a known and not revoked peer, signature valid, `x` not past and `ts` not in the future (skew allowance 120 s), `n` strictly greater than the highest accepted from that sender, then HPKE open (epoch key available), then inner checks. Only after all of that is the highest-seen counter advanced and the message acted on.
* **Replay protection.** `n` is a per-direction counter, persisted. The host persists it in blocks of 100 so a crash cannot reuse numbers. A device that loses its storage (browser eviction) is a new device and must re-pair. Duplicate or lower `n`: dropped silently and counted. Relay delivery is at-least-once, so duplicates are expected and harmless.
* **No reflection.** The `t` field is bound in the AAD and signature, so a message to the host cannot be replayed to a device.

### Inner message kinds (v1)

Host to device: `state` (full snapshot, small), `result` (outcome of an action), `keyupdate`, `revoked`.
Device to host: `action`, `sync` (please send `state`), `keyupdate`.

`state.d`:
```
{ rev, host:{name, away, paused, confirm:{approve,reply}}, presets:[{id,label}],
  sessions:[{ sid, agent:"claude-code", label, status:"working"|"waiting"|"idle"|"ended", since,
              pending?:{ rid, kind:"permission"|"question"|"idle", tool?, summary, preview, options?:[{id,label}], expires, bind },
              recent:[{ role:"assistant"|"user", text, ts }] }] }
```
`sid` is a random id local to the host (never the Claude session id or a path). `label` is the project folder name, chosen by the user's own host for the user's own devices (it never reaches the relay in the clear). `recent` holds at most 3 messages of at most 600 characters, masked for token shapes before encryption. No tool output. `bind = SHA-256(rid ‖ kind ‖ tool ‖ summary ‖ preview ‖ options)` (hex).

`action.d`:
```
{ rid, sid, a:"approve"|"deny"|"reply", opt?:<presetId or optionId>, bind, nonce }
```
The device echoes `bind` of what it displayed. The host refuses (`stale`) if the pending request no longer matches, so the user can never approve something other than what they saw.

## 6. Host-side checks for an action (the companion decides, not the client)

1. Envelope and device checks above (device paired, not revoked, counter fresh, not expired).
2. `sid`/`rid` identify the *currently* pending request of that session, and `bind` matches.
3. Action is one of `approve`, `deny`, `reply` with `opt` an id from the host's own preset list or from the agent's own offered options. The text delivered to the agent is the host's text, never the client's.
4. Rate limit: at most 6 actions a minute and 60 an hour in total.
5. Policy: remote answering must not be `paused` (local `botwarren-companion pause`), the account must not be killed (the host also stops on `revoked`).
6. **Local confirmation.** Decision recorded here: `deny` is always allowed remotely. `approve` and quick replies are allowed remotely by default for an enrolled user, but each can be set to require local confirmation (`confirm.approve`, `confirm.reply` = `off` | `always` | `risky`, `risky` meaning the tool name matches the user's `requireLocalTools` list or the preset is flagged `affirm`). Any future action type beyond these four defaults to `always`. A local confirmation is a terminal or desktop prompt on the machine (`botwarren-companion confirm` or the daemon's attached terminal); timeout 60 s means `deny`.
7. Deliver (hook response or channel notification), then write an audit line (kind, outcome, device id, time, request hash: never content) and send `result`.

## 7. Relay protocol

WebSocket at `/v1/ws`. Max frame 16 KiB.

1. `← {"t":"hello","v":1,"nonce":"<32 bytes b64u>","aud":"<relay origin>"}`
2. `→ {"t":"auth","role":"host"|"device","ticket":{j,s},"cert":{j,s}?,"id":<id>,"sig":<Ed25519 over "botwarren-link-v1/auth\0"||nonce||aud||id>}`. A device sends ticket and cert; a host sends the ticket only.
3. Relay verifies: ticket signature with a pinned server key and not expired; for a device the cert is signed by the ticket's host key and matches `acct`/`host`; the auth signature proves the key; account, host and device are not on the kill list; global kill switch off. Else `{"t":"error","code":...}` and close.
4. `← {"t":"ready","peerOnline":bool,"queued":n}`.
5. `→ {"t":"msg", h,c,s}`: the relay checks `f == authed id`, size, expiry, and that the Ed25519 signature verifies under the sender's key (so a connection cannot inject frames as someone else). A device may only address its own host (`t == cert.host`). A host may address any id (the relay cannot yet know its devices), but each host has a queue quota. The relay does not and cannot decrypt.
6. Delivery: to the connected recipient immediately, otherwise queued in memory with a TTL (default 15 minutes, max 100 frames and 512 KiB per recipient, shorter `x` wins). Recipient sends `{"t":"ack","m":<msg id>}`; unacked frames are redelivered on reconnect until the TTL.
7. `{"t":"presence","host":bool}` to devices when the host connects or disconnects (the only relay-originated information).
8. Pairing rendezvous: `POST /v1/pair/offer` (host, authenticated by the same chain in headers), `GET /v1/pair/<rid>`, `POST /v1/pair/<rid>/request`, `GET /v1/pair/<rid>/result` (long poll). Unknown, expired or consumed rids all return the same 404.
9. Operations: `GET /healthz` (no state), `POST /admin/kill` and `/admin/unkill` with a bearer token from the environment: `{scope:"global"|"account"|"host"|"device", id}`; a signed kill list fetched from botwarren.com every 30 s (`RELAY_KILLLIST_URL`, verified with the ticket keys) as the durable source; kill closes live sockets at once.
10. Limits: per connection 20 frames a second burst, 120 a minute; per account 600 frames a minute and 3 hosts and 8 devices connected; per IP 10 pairing requests a minute; global connection cap. `Retry` information is returned in `error` frames.

**What the relay logs:** event counters, error codes, connection counts. Never a frame body, a header field, an id, a name, an IP address beyond the transient rate-limit key in memory, or a ticket. A test plants canaries in every field and fails if one reaches logs or storage.

## 8. Revocation, multi-device, recovery

* **Revoke a device:** `botwarren-companion devices revoke <name>` (local, authoritative), or from the device itself (self-revoke), or `revoke all` from the website (which kills the account at the relay and tells the ship agent to remove the companion). The host deletes the device, rejects its frames from then on, and posts a signed `revocation = { dev, iat }` (signed by the host, domain `.../revoke\0`) to the relay, which adds it to its kill list for the cert lifetime and closes the socket. The server cannot revoke one specific device (it cannot see them); it can kill the whole account.
* **Multi-device:** the host fans out one HPKE message per device (so each device has its own epoch key and counters). Up to 8 devices.
* **Lost phone:** revoke it at the host; the keys never left the phone, so there is nothing to recover. **Lost host or all devices:** re-pair from the machine. This is by design (no key escrow).
* **Key rotation:** section 3.

## 9. Metadata minimisation: what each party can see

| Party | Sees | Cannot see |
|---|---|---|
| Relay operator (and its hosting provider, and Cloudflare) | Connection times and IPs (transient), key-derived ids, pseudonymous account tag, device labels in certs, message counts, size buckets, who is online | Content of any message; the plaintext label of a project; the GitHub/GitLab identity (only a keyed pseudonym) |
| botwarren.com | That an account is enabled and consented; ticket issuance events; admin audit | Keys, devices, messages, anything about agents beyond what the metadata-only ship agent already reports |
| Cloudflare edge | TLS-terminated traffic of the relay hostname: ciphertext and the same metadata | Content |
| A network observer | Endpoint, timing, sizes | Content, ids |
| The user's agent vendor | Unchanged (they already see the session) | n/a |

## 10. Threat model

| ID | Threat | Control in this design | Residual |
|---|---|---|---|
| T1 | Steering through a stolen cookie or hijacked GitHub login | A send needs a device key; no cookie reaches the relay; relay accepts no cookies; the website cannot send | Phone malware, or a stolen unlocked phone while the page is open (use passkeys later) |
| T2 | Operator, Fly or Cloudflare reads content | HPKE per message; relay sees ciphertext | Metadata |
| T3 | Malicious client code served by us | Signed bundle plus verifying loader plus own origin; companion limits actions to approve/deny/preset; `bind` check; local confirmation options | A compromised origin can read what the user sees and approve pending requests. Accepted risk, see 11 |
| T4 | Secrets or customer data in the shown messages | Tier T1 only (the agent's own words), 3 messages, 600 chars, local masking of token shapes, no tool output, retention zero on the relay beyond 15 min | Assistant text can still quote secrets; limited rollout and per-session pause |
| T5 | Prompt injection via the control channel | Preset-only replies; host-defined text; provenance tag on channel events; sender is one authenticated device | An injected agent can lie in its own question text (the user is shown what the agent says) |
| T6 | Pairing hijack (QR shoulder-surf, code phishing) | 80-bit single-use code, 10 min, local confirmation with device name and SAS, local audit line, relay cannot read the exchange | User approves a pairing they did not initiate: the prompt says "you started this pairing at HH:MM" |
| T7 | Content reaching public projections, logs, backups | A program separate from the metadata-only ship agent, relay stores nothing durable, canary tests on the relay | Operator mistakes; backups exclude relay volume |
| T8 | Copy drift | Wording updates in README, trust page and privacy page in the same change; ship agent unchanged and tested | Future edits |
| T9 | Ship agent turned into an installer for arbitrary code | The agent installs only a component named `companion` from a manifest signed by a pinned component key (a separate key set from the agent's update keys, which the component verifier refuses) with its own domain, hash-checked before extraction, with recorded consent, a local log line and a notice; the cloud's only instruction is a fixed enum | Compromise of the component signing key (it can sign a component, not an agent update: the agent-update verifier rejects it; mitigated by KMS, a gated workflow, recovery-key revocation, epochs) |
| T10 | Relay abuse and DoS | Rate limits, quotas, kill switches | Availability only |
| T11 | Replay, reflection, re-wrapping | Counters, expiry, `t` in AAD and signature, inner id equality, one-time `rid` | Counter loss on a device re-pairs it |
| T12 | Local attacker on the dev machine | The companion socket is 0600 in a 0700 directory; hook calls need the per-install secret; no network listener; same OS user can already do everything, out of scope | Same-user malware |

## 11. Accepted risks (recorded)

1. **No external security review yet.** This is an accepted risk, stated plainly in the README. Mitigation: the feature is limited to accounts that were explicitly enabled and have consented, and the code is open source so that anyone can review it; a wider rollout waits for an independent review.
2. A malicious or compromised Botwarren origin could serve a client that reads shown content and approves pending requests (T3). The companion bounds the damage; stronger clients are on the path in [CLIENT_SECURITY.md](CLIENT_SECURITY.md) section 1.5.
3. Forward secrecy is limited to key-rotation granularity (7 days when all devices are online), not per message.
4. Claude Code's Channels feature is a research preview and may change; the hook route is the fallback.

## 12. Test vectors

`apps/companion/test/vectors.test.ts` contains: RFC 9180 A.1.1 (kem shared secret, key schedule, key, base nonce, ciphertext, via the AES-128-GCM variant of the same implementation), an Ed25519 signature vector from RFC 8032 section 7.1 (test 1), an RFC 5869 HKDF-SHA256 vector, and fixed-seed known-answer tests for our own message framing (envelope, pairing SAS and rid derivation) so a regression in canonical bytes is caught.

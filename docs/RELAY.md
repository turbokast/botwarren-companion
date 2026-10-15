# Running the relay

The relay carries sealed frames between a user's computer and their paired devices and serves the signed web client from its own cookie-less origin. It holds no keys and no content and stores nothing durable (an in-memory queue of at most 15 minutes). Anyone can run one; the hosted one is `https://relay.botwarren.com`, operated by TurboKast Ltd. What the relay can and cannot see: [PROTOCOL.md](PROTOCOL.md) section 9.

## Build the image from a release

Every release attaches **the relay image inputs**: `relay-context-X.Y.Z.tar.gz`. It is a build context, not a checkout: it holds `Dockerfile.relay`, the relay and protocol sources, the lockfile and `client/`, the web client **signed with the component signing key**. Building from it means the image serves exactly the client that was signed and attested, not a client you built yourself.

```sh
# 1. fetch the release files (the GitHub Release assets, or https://downloads.botwarren.com/companion/X.Y.Z/)
# 2. verify them
sha256sum --check SHA256SUMS
gh attestation verify relay-context-X.Y.Z.tar.gz --repo turbokast/botwarren-companion
node apps/companion/scripts/verify-release.mjs <directory with the release files>     # in a checkout of this repository, or of the private repository that vendors it
# 3. build
mkdir ctx && tar -xzf relay-context-X.Y.Z.tar.gz -C ctx
docker build -f ctx/Dockerfile.relay -t botwarren-relay:X.Y.Z ctx
```

`verify-release.mjs` checks, among other things, that `client/` inside the archive is byte-identical to the signed client and that every file of the archive matches `CONTEXT.json`. The image installs the locked production dependencies (`--frozen-lockfile --ignore-scripts`) and nothing else from the network.

## Configuration (environment only)

| Variable | Required | Meaning |
|---|---|---|
| `RELAY_ORIGIN` | yes | The public origin, scheme and host only (for example `https://relay.example.org`). Clients sign it into their login proof, so it must equal the address people use |
| `RELAY_TICKET_KEYS` | yes | Comma-separated base64url raw Ed25519 public keys of the enrolment ticket signers. The relay accepts only hosts holding a ticket signed by one of them |
| `PORT` | no | Listen port, default 8080 |
| `RELAY_ADMIN_TOKEN` | no | Bearer token for `/admin/*` (kill switches and counters only). Without it the admin endpoints answer 404 |
| `RELAY_KILLLIST_URL` | no | A signed kill list to poll every 30 s (verified with the ticket keys) |
| `RELAY_GLOBAL_KILL` | no | `1` starts with the global kill switch on |
| `RELAY_TRUST_FLY_PROXY` | no | `1` reads the client address from the `Fly-Client-IP` header (only behind that proxy; leave it off otherwise, or anyone could spoof their address) |
| `RELAY_CLIENT_DIR` | no | Directory of the signed client, default `/srv/client` in the image |

Secrets (`RELAY_TICKET_KEYS` is public key material, `RELAY_ADMIN_TOKEN` is a secret) are passed as environment variables by the platform's secret store, never baked into the image. Put the relay behind TLS (the clients connect with `wss://`) and give it no volume.

## Checks after a deploy

* `GET /healthz` answers `{"ok":true}`.
* `GET /manifest.json` and `GET /manifest.json.sig` are byte-identical to the release's `client-manifest.json` and `client-manifest.json.sig` (the release workflow's `relay-image` job checks this for the image; check it again against the live origin).
* The response headers of `/` carry the strict content security policy (`default-src 'none'; script-src 'self' blob:; ...`), and no cookie is ever set.
* `GET /admin/stats` with the admin token shows counters only.

## Kill switches

Global (`RELAY_GLOBAL_KILL=1` at boot, or a kill list entry), per account, host or device (`POST /admin/kill` with the admin token: `{"scope":"global"|"account"|"host"|"device","id":"..."}`), and the signed kill list. A kill closes live sockets at once.

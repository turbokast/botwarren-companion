/**
 * Entry point for the relay container. All configuration is from the environment; secrets are never logged.
 *
 *   PORT                      listen port (default 8080)
 *   RELAY_ORIGIN              public origin, e.g. https://relay.botwarren.com (required: clients sign it into their auth proof)
 *   RELAY_TICKET_KEYS         comma-separated base64url raw Ed25519 public keys of the botwarren.com ticket signers (required)
 *   RELAY_ADMIN_TOKEN         bearer token for /admin/* (optional; without it the admin endpoints answer 404)
 *   RELAY_KILLLIST_URL        signed kill list endpoint on botwarren.com (optional)
 *   RELAY_CLIENT_DIR          directory of the signed web client (default ./client)
 *   RELAY_GLOBAL_KILL=1       start with the global kill switch on
 *   RELAY_TRUST_FLY_PROXY=1   read the client address from Fly-Client-IP
 *   RELAY_VAPID_PUBLIC_KEY / RELAY_VAPID_PRIVATE_KEY   phone alerts (optional): the relay's own Web Push application server key pair
 *                             (`node scripts/relay-vapid-keygen.mjs`; generate ONCE: a new key invalidates every phone's alert subscription).
 *                             Without both, alerts are off and the page does not offer them.
 *   RELAY_VAPID_SUBJECT       RFC 8292 contact, a mailto: or https: URI (default mailto:support@turbokast.com)
 * Licence: Apache-2.0.
 */
import { unb64u } from '@botwarren/companion/protocol';
import { Relay } from './relay.ts';
import { vapidFromEnv } from './webpush.ts';

const env = process.env;
const origin = env.RELAY_ORIGIN;
const keys = (env.RELAY_TICKET_KEYS ?? '').split(',').map((s) => s.trim()).filter(Boolean).map(unb64u);
if (!origin || !/^https?:\/\/[^/]+$/.test(origin)) { console.error('relay: RELAY_ORIGIN is required (scheme and host only)'); process.exit(2); }
if (keys.length === 0 || keys.some((k) => k.length !== 32)) { console.error('relay: RELAY_TICKET_KEYS must hold at least one 32-byte Ed25519 public key'); process.exit(2); }

const vapid = vapidFromEnv(env);
if ((env.RELAY_VAPID_PUBLIC_KEY || env.RELAY_VAPID_PRIVATE_KEY) && !vapid) console.error('relay: RELAY_VAPID_PUBLIC_KEY and RELAY_VAPID_PRIVATE_KEY are not a matching pair: phone alerts stay off');
const subject = env.RELAY_VAPID_SUBJECT ?? 'mailto:support@turbokast.com';
if (!/^(mailto:[^\s@]+@[^\s@]+|https:\/\/[^\s]+)$/.test(subject)) { console.error('relay: RELAY_VAPID_SUBJECT must be a mailto: or https: URI'); process.exit(2); }

const relay = new Relay({
  port: Number(env.PORT ?? 8080), origin, ticketKeys: keys,
  ...(env.RELAY_ADMIN_TOKEN ? { adminToken: env.RELAY_ADMIN_TOKEN } : {}),
  ...(env.RELAY_KILLLIST_URL ? { killListUrl: env.RELAY_KILLLIST_URL } : {}),
  clientDir: env.RELAY_CLIENT_DIR ?? './client',
  trustFlyProxy: env.RELAY_TRUST_FLY_PROXY === '1',
  globalKill: env.RELAY_GLOBAL_KILL === '1',
  ...(vapid ? { push: { vapid, subject } } : {}),
  logSink: (l) => { console.log(l); },
});
const port = await relay.listen();
console.log(JSON.stringify({ t: Math.floor(Date.now() / 1000), c: 'listening', port }));
const stop = (): void => { void relay.close().then(() => process.exit(0)); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

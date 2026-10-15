/**
 * The relay's side of phone alerts. It is a courier and nothing more: the companion on the user's computer seals the alert for the phone's own
 * Web Push subscription (RFC 8291, with keys the relay never sees) and the relay only POSTs that ciphertext to the phone's push service, signing the
 * request as the application server (VAPID, RFC 8292). It cannot read an alert, cannot write one the phone would accept, and keeps nothing.
 *
 *   - the endpoint must be https on a real browser push service (no request into any other network; redirects are never followed);
 *   - the body is capped at 600 bytes (an alert is about 170): there is no room for content even if a companion tried;
 *   - nothing here is logged: the caller counts outcomes under fixed codes.
 * Node only (node:crypto). Licence: Apache-2.0.
 */
import { createECDH, createPrivateKey, sign, type KeyObject } from 'node:crypto';

export const MAX_ALERT_BYTES = 600;
export interface VapidKeys { publicKey: string; privateKey: string }

const b64u = (b: Uint8Array): string => Buffer.from(b).toString('base64url');
const fromB64u = (s: string): Buffer => Buffer.from(s, 'base64url');

/** VAPID keys from RELAY_VAPID_PUBLIC_KEY / RELAY_VAPID_PRIVATE_KEY; null unless both are present and form a pair (a bad pair would sign tokens every push service rejects) */
export function vapidFromEnv(env: Record<string, string | undefined> = process.env): VapidKeys | null {
  const publicKey = env.RELAY_VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.RELAY_VAPID_PRIVATE_KEY?.trim();
  if (!publicKey || !privateKey) return null;
  try {
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(fromB64u(privateKey));
    return b64u(ecdh.getPublicKey()) === publicKey ? { publicKey, privateKey } : null;
  } catch { return null; }
}

/** a new key pair, for `scripts/relay-vapid-keygen.mjs` and tests */
export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
}

function privateKeyObject(v: VapidKeys): KeyObject {
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(fromB64u(v.privateKey));
  const pub = ecdh.getPublicKey();
  return createPrivateKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)), d: v.privateKey }, format: 'jwk' });
}

/** the VAPID JWT: ES256, `aud` = the push service origin, `exp` under 24 h */
export function vapidJwt(v: VapidKeys, audience: string, subject: string, nowMs: number, ttlS = 12 * 3600): string {
  const head = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64u(Buffer.from(JSON.stringify({ aud: audience, exp: Math.floor(nowMs / 1000) + Math.min(ttlS, 24 * 3600 - 60), sub: subject })));
  const sig = sign('sha256', Buffer.from(`${head}.${body}`), { key: privateKeyObject(v), dsaEncoding: 'ieee-p1363' });
  return `${head}.${body}.${b64u(sig)}`;
}

/** the real browser push services; nothing else is ever called */
const PUSH_HOSTS: RegExp[] = [
  /^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/,
  /(^|\.)push\.services\.mozilla\.com$/,
  /(^|\.)push\.apple\.com$/,
  /(^|\.)notify\.windows\.com$/,
];

/** the endpoint's origin if it is a valid https URL of a known push service (default port, no credentials, no fragment), else null */
export function pushOrigin(endpoint: string, extraHosts: RegExp[] = []): string | null {
  if (endpoint.length > 1024) return null;
  let u: URL;
  try { u = new URL(endpoint); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443') || u.hash) return null;
  return [...PUSH_HOSTS, ...extraHosts].some((r) => r.test(u.hostname)) ? u.origin : null;
}

export interface DeliverOptions {
  vapid: VapidKeys;
  /** contact for the push service operator (RFC 8292 `sub`): a mailto: or https: URI */
  subject: string;
  ttl: number;
  urgency: 'very-low' | 'low' | 'normal' | 'high';
  /** at most 32 base64url characters: a newer message with the same topic replaces one still queued at the push service */
  topic?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** tests only: extra allowed push hosts (a local mock push service) */
  extraHosts?: RegExp[];
  timeoutMs?: number;
}

export type DeliverResult =
  | { ok: true }
  /** the subscription is gone (404/410): the companion forgets it */
  | { ok: false; gone: true }
  | { ok: false; gone: false; why: 'bad_endpoint' | 'rate_limited' | 'rejected' | 'server_error' | 'network' };

/** one POST of an already sealed body. Never throws. */
export async function deliver(endpoint: string, body: Uint8Array, o: DeliverOptions): Promise<DeliverResult> {
  const origin = pushOrigin(endpoint, o.extraHosts);
  if (!origin || body.length === 0 || body.length > MAX_ALERT_BYTES) return { ok: false, gone: false, why: 'bad_endpoint' };
  const jwt = vapidJwt(o.vapid, origin, o.subject, (o.now ?? Date.now)());
  const headers: Record<string, string> = {
    authorization: `vapid t=${jwt}, k=${o.vapid.publicKey}`,
    'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', ttl: String(o.ttl), urgency: o.urgency,
  };
  if (o.topic && /^[A-Za-z0-9_-]{1,32}$/.test(o.topic)) headers.topic = o.topic;
  try {
    const res = await (o.fetchImpl ?? fetch)(endpoint, { method: 'POST', headers, body: new Uint8Array(body), redirect: 'manual', signal: AbortSignal.timeout(o.timeoutMs ?? 10_000) });
    await res.body?.cancel().catch(() => undefined);
    if (res.status >= 200 && res.status < 300) return { ok: true };
    if (res.status === 404 || res.status === 410) return { ok: false, gone: true };
    if (res.status === 429) return { ok: false, gone: false, why: 'rate_limited' };
    return { ok: false, gone: false, why: res.status >= 500 ? 'server_error' : 'rejected' };
  } catch { return { ok: false, gone: false, why: 'network' }; }
}

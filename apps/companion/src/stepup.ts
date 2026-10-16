/**
 * Step-up for remote control (protocol 3, WP2): the host's own WebAuthn verifier. The relay and the website are never trusted for it: the computer stores
 * the device's public key from registration and checks every assertion itself (type, challenge, origin, rpIdHash, user presence AND user verification,
 * signature, signCount). Node only (node:crypto); NOT exported from index.ts, so the browser bundle and the relay never carry it.
 *
 * Algorithms: ES256 (-7), EdDSA (-8, Ed25519), RS256 (-257, 2048 bits or more). Attestation is requested as `none` and its statement is not verified (there is
 * no vendor trust to establish: the owner confirms the registration at the computer). WebAuthn Level 2, sections 7.1 (registration) and 7.2 (assertion).
 * Licence: Apache-2.0.
 */
import { createHash, createPublicKey, timingSafeEqual, verify as cryptoVerify, type JsonWebKey, type KeyObject } from 'node:crypto';
import { b64u, unb64u } from './protocol/bytes.ts';

export const COSE_ALGS = [-7, -8, -257] as const;
export type CoseAlg = (typeof COSE_ALGS)[number];

export interface StoredCredential { id: string; alg: CoseAlg; key: Record<string, string>; signCount: number }

export type RegFail = 'no_challenge' | 'challenge' | 'origin' | 'type' | 'rp' | 'user_presence' | 'user_verification' | 'attestation' | 'algorithm' | 'key' | 'credential' | 'malformed';
export type AssertFail = 'challenge' | 'origin' | 'type' | 'rp' | 'user_presence' | 'user_verification' | 'signature' | 'sign_count' | 'credential' | 'malformed';

const sha256 = (b: Uint8Array): Buffer => createHash('sha256').update(b).digest();
const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && timingSafeEqual(a, b);

// ---------------------------------------------------------------- CBOR (the small subset WebAuthn uses)
export type Cbor = number | string | boolean | null | undefined | Uint8Array | Cbor[] | Map<number | string, Cbor>;

/** Decodes one CBOR item at `offset`. Definite lengths only, no tags, no floats, small: anything else throws. Returns the value and where it ended. */
export function decodeCbor(buf: Uint8Array, offset = 0, depth = 0): { value: Cbor; end: number } {
  if (depth > 6) throw new Error('cbor too deep');
  if (offset >= buf.length) throw new Error('cbor truncated');
  const ib = buf[offset]!;
  const major = ib >> 5; const info = ib & 31;
  let pos = offset + 1;
  let arg: number;
  if (major === 7) {
    if (info === 20) return { value: false, end: pos };
    if (info === 21) return { value: true, end: pos };
    if (info === 22) return { value: null, end: pos };
    if (info === 23) return { value: undefined, end: pos };
    throw new Error('cbor simple value not supported');
  }
  if (info < 24) arg = info;
  else if (info === 24) { if (pos + 1 > buf.length) throw new Error('cbor truncated'); arg = buf[pos]!; pos += 1; }
  else if (info === 25) { if (pos + 2 > buf.length) throw new Error('cbor truncated'); arg = (buf[pos]! << 8) | buf[pos + 1]!; pos += 2; }
  else if (info === 26) { if (pos + 4 > buf.length) throw new Error('cbor truncated'); arg = ((buf[pos]! << 24) >>> 0) + (buf[pos + 1]! << 16) + (buf[pos + 2]! << 8) + buf[pos + 3]!; pos += 4; }
  else throw new Error('cbor length not supported');
  switch (major) {
    case 0: return { value: arg, end: pos };
    case 1: return { value: -1 - arg, end: pos };
    case 2: case 3: {
      if (pos + arg > buf.length) throw new Error('cbor truncated');
      const bytes = buf.subarray(pos, pos + arg);
      return { value: major === 2 ? bytes : new TextDecoder('utf-8', { fatal: true }).decode(bytes), end: pos + arg };
    }
    case 4: {
      if (arg > 64) throw new Error('cbor array too long');
      const out: Cbor[] = [];
      for (let i = 0; i < arg; i++) { const r = decodeCbor(buf, pos, depth + 1); out.push(r.value); pos = r.end; }
      return { value: out, end: pos };
    }
    case 5: {
      if (arg > 32) throw new Error('cbor map too long');
      const out = new Map<number | string, Cbor>();
      for (let i = 0; i < arg; i++) {
        const k = decodeCbor(buf, pos, depth + 1); pos = k.end;
        if (typeof k.value !== 'number' && typeof k.value !== 'string') throw new Error('cbor map key');
        const v = decodeCbor(buf, pos, depth + 1); pos = v.end;
        out.set(k.value, v.value);
      }
      return { value: out, end: pos };
    }
    default: throw new Error('cbor tag not supported');
  }
}

// ---------------------------------------------------------------- authenticator data
export interface AuthData { rpIdHash: Uint8Array; flags: number; signCount: number; up: boolean; uv: boolean; at: boolean; cred?: { id: Uint8Array; cose: Cbor } }

export function parseAuthData(b: Uint8Array): AuthData {
  if (b.length < 37) throw new Error('authData too short');
  const flags = b[32]!;
  const out: AuthData = { rpIdHash: b.subarray(0, 32), flags, signCount: ((b[33]! << 24) >>> 0) + (b[34]! << 16) + (b[35]! << 8) + b[36]!, up: (flags & 0x01) !== 0, uv: (flags & 0x04) !== 0, at: (flags & 0x40) !== 0 };
  if (out.at) {
    if (b.length < 55) throw new Error('attested data too short');
    const len = (b[53]! << 8) | b[54]!;
    if (len < 1 || len > 1023 || 55 + len > b.length) throw new Error('bad credential id length');
    out.cred = { id: b.subarray(55, 55 + len), cose: decodeCbor(b, 55 + len).value };
  }
  return out;
}

// ---------------------------------------------------------------- COSE keys
const bytesOf = (v: Cbor | undefined): Uint8Array | null => (v instanceof Uint8Array ? v : null);

/** a COSE public key to a JWK and its algorithm; null when it is not one of the three we accept or is malformed */
export function coseToJwk(cose: Cbor): { alg: CoseAlg; jwk: Record<string, string> } | null {
  if (!(cose instanceof Map)) return null;
  const kty = cose.get(1); const alg = cose.get(3);
  if (kty === 2 && alg === -7) {
    const x = bytesOf(cose.get(-2)); const y = bytesOf(cose.get(-3));
    if (cose.get(-1) !== 1 || !x || !y || x.length !== 32 || y.length !== 32) return null;
    return { alg: -7, jwk: { kty: 'EC', crv: 'P-256', x: b64u(x), y: b64u(y) } };
  }
  if (kty === 1 && alg === -8) {
    const x = bytesOf(cose.get(-2));
    if (cose.get(-1) !== 6 || !x || x.length !== 32) return null;
    return { alg: -8, jwk: { kty: 'OKP', crv: 'Ed25519', x: b64u(x) } };
  }
  if (kty === 3 && alg === -257) {
    const n = bytesOf(cose.get(-1)); const e = bytesOf(cose.get(-2));
    if (!n || !e || n.length < 256 || n.length > 1024 || e.length < 1 || e.length > 8) return null;
    return { alg: -257, jwk: { kty: 'RSA', n: b64u(n), e: b64u(e) } };
  }
  return null;
}

const keyOf = (jwk: Record<string, string>): KeyObject | null => { try { return createPublicKey({ key: jwk as unknown as JsonWebKey, format: 'jwk' }); } catch { return null; } };

// ---------------------------------------------------------------- client data
interface ClientData { type: string; challenge: string; origin: string; crossOrigin?: boolean }
function parseClientData(cd: Uint8Array): ClientData | null {
  try {
    const o = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(cd)) as Record<string, unknown>;
    if (!o || typeof o !== 'object' || typeof o.type !== 'string' || typeof o.challenge !== 'string' || typeof o.origin !== 'string') return null;
    return { type: o.type, challenge: o.challenge, origin: o.origin, ...(typeof o.crossOrigin === 'boolean' ? { crossOrigin: o.crossOrigin } : {}) };
  } catch { return null; }
}

export interface Relying { rpId: string; origins: readonly string[] }

function checkCommon(cd: ClientData, type: string, expectedChallenge: string, rp: Relying, ad: AuthData): 'type' | 'challenge' | 'origin' | 'rp' | 'user_presence' | 'user_verification' | null {
  if (cd.type !== type) return 'type';
  if (!same(Buffer.from(cd.challenge), Buffer.from(expectedChallenge))) return 'challenge';
  if (!rp.origins.includes(cd.origin) || cd.crossOrigin === true) return 'origin';
  if (!same(ad.rpIdHash, sha256(Buffer.from(rp.rpId)))) return 'rp';
  if (!ad.up) return 'user_presence';
  if (!ad.uv) return 'user_verification';
  return null;
}

// ---------------------------------------------------------------- registration
/**
 * `expectedChallenge`: the base64url challenge the host issued for this registration. `id`, `ao` (attestationObject) and `cd` (clientDataJSON) are the
 * base64url fields the device sent. Returns the credential to store, or why it was refused.
 */
export function verifyRegistration(i: { expectedChallenge: string; rp: Relying; id: string; ao: string; cd: string }): { ok: true; cred: StoredCredential } | { ok: false; why: RegFail } {
  let cdBytes: Uint8Array; let aoBytes: Uint8Array; let idBytes: Uint8Array;
  try { cdBytes = unb64u(i.cd); aoBytes = unb64u(i.ao); idBytes = unb64u(i.id); } catch { return { ok: false, why: 'malformed' }; }
  const cd = parseClientData(cdBytes);
  if (!cd) return { ok: false, why: 'malformed' };
  let ad: AuthData;
  try {
    const att = decodeCbor(aoBytes).value;
    if (!(att instanceof Map)) return { ok: false, why: 'attestation' };
    const authData = bytesOf(att.get('authData'));
    if (!authData || typeof att.get('fmt') !== 'string') return { ok: false, why: 'attestation' };
    ad = parseAuthData(authData);
  } catch { return { ok: false, why: 'attestation' }; }
  const bad = checkCommon(cd, 'webauthn.create', i.expectedChallenge, i.rp, ad);
  if (bad) return { ok: false, why: bad };
  if (!ad.at || !ad.cred) return { ok: false, why: 'attestation' };
  if (idBytes.length < 8 || !same(ad.cred.id, idBytes)) return { ok: false, why: 'credential' };
  const k = coseToJwk(ad.cred.cose);
  if (!k) return { ok: false, why: ad.cred.cose instanceof Map && !COSE_ALGS.includes(ad.cred.cose.get(3) as CoseAlg) ? 'algorithm' : 'key' };
  if (!keyOf(k.jwk)) return { ok: false, why: 'key' };
  return { ok: true, cred: { id: b64u(idBytes), alg: k.alg, key: k.jwk, signCount: ad.signCount } };
}

// ---------------------------------------------------------------- assertion
/**
 * `expectedChallenge`: what the host issued for this step-up (base64url). `response` is what the device sent. A counter that does not go up is refused when
 * either value is not zero (authenticators that never count, such as some platform passkeys, send 0 every time and are accepted). The caller stores the
 * returned `signCount` only after this returns ok.
 */
export function verifyAssertion(i: { expectedChallenge: string; rp: Relying; cred: StoredCredential; response: { id: string; ad: string; cd: string; sig: string } }): { ok: true; signCount: number } | { ok: false; why: AssertFail } {
  let adBytes: Uint8Array; let cdBytes: Uint8Array; let sig: Uint8Array;
  try { adBytes = unb64u(i.response.ad); cdBytes = unb64u(i.response.cd); sig = unb64u(i.response.sig); } catch { return { ok: false, why: 'malformed' }; }
  if (i.response.id !== i.cred.id) return { ok: false, why: 'credential' };
  const cd = parseClientData(cdBytes);
  if (!cd) return { ok: false, why: 'malformed' };
  let ad: AuthData;
  try { ad = parseAuthData(adBytes); } catch { return { ok: false, why: 'malformed' }; }
  const bad = checkCommon(cd, 'webauthn.get', i.expectedChallenge, i.rp, ad);
  if (bad) return { ok: false, why: bad };
  const key = keyOf(i.cred.key);
  if (!key) return { ok: false, why: 'signature' };
  const signed = Buffer.concat([adBytes, sha256(cdBytes)]);
  let ok = false;
  try {
    ok = i.cred.alg === -8 ? cryptoVerify(null, signed, key, sig)
      : i.cred.alg === -7 ? cryptoVerify('sha256', signed, { key, dsaEncoding: 'der' }, sig)
        : cryptoVerify('sha256', signed, key, sig);
  } catch { ok = false; }
  if (!ok) return { ok: false, why: 'signature' };
  if ((i.cred.signCount !== 0 || ad.signCount !== 0) && ad.signCount <= i.cred.signCount) return { ok: false, why: 'sign_count' };
  return { ok: true, signCount: ad.signCount };
}

/** the relying party for a relay URL: the relay's host name as rpId, its origin as the only allowed origin */
export function relyingPartyOf(relayUrl: string): Relying | null {
  try {
    const u = new URL(relayUrl.replace(/^ws/, 'http'));
    return { rpId: u.hostname, origins: [u.origin] };
  } catch { return null; }
}

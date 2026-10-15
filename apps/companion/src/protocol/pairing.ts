/**
 * Pairing (QR or short code, shown locally on the host). See docs/PROTOCOL.md section 4.
 *
 * The secret is 80 random bits (a 16-character Crockford code). Both sides derive with HKDF-SHA256:
 *   rid = HKDF(secret, info "rid", 16 bytes)   what the relay stores the exchange under
 *   K   = HKDF(secret, info "key", 32 bytes)   AES-256-GCM key for the offer, the request and the result
 * The relay never learns the secret, so it can neither read nor change the exchange. The short authentication string (SAS) binds both
 * parties' public keys; the host user compares it on both screens before the host signs a certificate.
 * Licence: Apache-2.0.
 */
import { z } from 'zod';
import { b64u, bs, concat, crockford, fromUtf8, randomBytes, uncrockford, unb64u, utf8, type Bytes } from './bytes.ts';
import { hkdf } from './hpke.ts';
import { SignedSchema } from './certs.ts';

const subtle = (): SubtleCrypto => globalThis.crypto.subtle;
const SALT = utf8('botwarren-link-v1/pair');
export const CODE_BYTES = 10;
export const PAIR_TTL_MS = 10 * 60_000;

export const newPairingSecret = (): Bytes => randomBytes(CODE_BYTES);

/** XXXX-XXXX-XXXX-XXXX */
export function formatCode(secret: Bytes): string { return crockford(secret).match(/.{1,4}/g)!.join('-'); }
/** forgiving parse: case, dashes, spaces, O/0 and I/L/1 confusions; returns null if it is not 80 bits */
export function parseCode(code: string): Bytes | null {
  try { const b = uncrockford(code); return b.length === CODE_BYTES ? b : null; } catch { return null; }
}

export interface PairKeys { rid: string; key: Bytes }
export async function derivePairKeys(secret: Bytes): Promise<PairKeys> {
  return { rid: b64u(await hkdf(secret, SALT, utf8('rid'), 16)), key: await hkdf(secret, SALT, utf8('key'), 32) };
}

async function aeadSeal(key: Bytes, label: string, rid: string, obj: unknown): Promise<string> {
  const nonce = randomBytes(12);
  const k = await subtle().importKey('raw', bs(key), 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: bs(nonce), additionalData: bs(utf8(`${label}|${rid}`)), tagLength: 128 }, k, bs(utf8(JSON.stringify(obj)))));
  return b64u(concat(nonce, ct));
}

async function aeadOpen(key: Bytes, label: string, rid: string, blob: string): Promise<unknown | null> {
  try {
    const raw = unb64u(blob);
    if (raw.length < 13 + 16) return null;
    const k = await subtle().importKey('raw', bs(key), 'AES-GCM', false, ['decrypt']);
    const pt = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: bs(raw.subarray(0, 12)), additionalData: bs(utf8(`${label}|${rid}`)), tagLength: 128 }, k, bs(raw.subarray(12))));
    return JSON.parse(fromUtf8(pt));
  } catch { return null; }
}

const K32 = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const OfferBody = z.object({ v: z.literal(1), hostSig: K32, hostKem: K32, hostEp: z.number().int().min(0), hostName: z.string().max(40), ticket: SignedSchema, t: z.number().int() }).strict();
export const RequestBody = z.object({ v: z.literal(1), devSig: K32, devKem: K32, devName: z.string().min(1).max(40) }).strict();
export const ResultBody = z.object({ v: z.literal(1), cert: SignedSchema, hostEp: z.number().int().min(0) }).strict();
export type OfferBody = z.infer<typeof OfferBody>;
export type RequestBody = z.infer<typeof RequestBody>;
export type ResultBody = z.infer<typeof ResultBody>;

export const sealOffer = (k: PairKeys, o: OfferBody): Promise<string> => aeadSeal(k.key, 'offer', k.rid, o);
export const sealRequest = (k: PairKeys, r: RequestBody): Promise<string> => aeadSeal(k.key, 'req', k.rid, r);
export const sealResult = (k: PairKeys, r: ResultBody): Promise<string> => aeadSeal(k.key, 'res', k.rid, r);

export async function openOffer(k: PairKeys, blob: string): Promise<OfferBody | null> { const r = OfferBody.safeParse(await aeadOpen(k.key, 'offer', k.rid, blob)); return r.success ? r.data : null; }
export async function openRequest(k: PairKeys, blob: string): Promise<RequestBody | null> { const r = RequestBody.safeParse(await aeadOpen(k.key, 'req', k.rid, blob)); return r.success ? r.data : null; }
export async function openResult(k: PairKeys, blob: string): Promise<ResultBody | null> { const r = ResultBody.safeParse(await aeadOpen(k.key, 'res', k.rid, blob)); return r.success ? r.data : null; }

/** "482 913": 6 digits derived from all four public keys */
export async function shortAuthString(hostSig: Bytes, hostKem: Bytes, devSig: Bytes, devKem: Bytes): Promise<string> {
  const b = await hkdf(concat(hostSig, hostKem, devSig, devKem), SALT, utf8('sas'), 4);
  const n = ((b[0]! * 2 ** 24) + (b[1]! << 16) + (b[2]! << 8) + b[3]!) % 1_000_000;
  const s = String(n).padStart(6, '0');
  return `${s.slice(0, 3)} ${s.slice(3)}`;
}

/**
 * HPKE (RFC 9180), base mode, single-shot seal/open, over WebCrypto.
 *
 *   KEM  DHKEM(X25519, HKDF-SHA256)  0x0020
 *   KDF  HKDF-SHA256                 0x0001
 *   AEAD AES-256-GCM 0x0002 (production) or AES-128-GCM 0x0001 (only so the RFC 9180 appendix A.1.1 vector can be checked on the
 *        same code path)
 *
 * No construction of our own: this is the published HPKE key schedule with `sequence number 0` (one message per encapsulation).
 * Licence: Apache-2.0.
 */
import { bs, concat, equal, i2osp, utf8, type Bytes } from './bytes.ts';

const subtle = (): SubtleCrypto => globalThis.crypto.subtle;

export type AeadId = 0x0001 | 0x0002;
export const KEM_ID = 0x0020;
export const KDF_ID = 0x0001;
export const AEAD_AES256 = 0x0002 as const;
export const AEAD_AES128 = 0x0001 as const;
const NSECRET = 32;
const NN = 12;

const nk = (a: AeadId): number => (a === AEAD_AES128 ? 16 : 32);

// ---------------------------------------------------------------- HKDF-SHA256 (RFC 5869) over HMAC
async function hmac(key: Bytes, data: Bytes): Promise<Bytes> {
  const k = await subtle().importKey('raw', bs(key.length ? key : new Uint8Array(32)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle().sign('HMAC', k, bs(data)));
}

export async function hkdfExtract(salt: Bytes, ikm: Bytes): Promise<Bytes> {
  return hmac(salt.length ? salt : new Uint8Array(32), ikm); // an empty salt is HashLen zero bytes (RFC 5869 2.2)
}

export async function hkdfExpand(prk: Bytes, info: Bytes, length: number): Promise<Bytes> {
  if (length > 255 * 32) throw new Error('hkdf length');
  const out: Bytes[] = [];
  let t: Bytes = new Uint8Array(0);
  for (let i = 1; out.length * 32 < length; i++) {
    t = await hmac(prk, concat(t, info, Uint8Array.of(i)));
    out.push(t);
  }
  return concat(...out).subarray(0, length);
}

export async function hkdf(ikm: Bytes, salt: Bytes, info: Bytes, length: number): Promise<Bytes> {
  return hkdfExpand(await hkdfExtract(salt, ikm), info, length);
}

// ---------------------------------------------------------------- HPKE labelled functions
const V1 = utf8('HPKE-v1');
const kemSuite = concat(utf8('KEM'), i2osp(KEM_ID, 2));
const hpkeSuite = (aead: AeadId): Bytes => concat(utf8('HPKE'), i2osp(KEM_ID, 2), i2osp(KDF_ID, 2), i2osp(aead, 2));

const labeledExtract = (suite: Bytes, salt: Bytes, label: string, ikm: Bytes): Promise<Bytes> => hkdfExtract(salt, concat(V1, suite, utf8(label), ikm));
const labeledExpand = (suite: Bytes, prk: Bytes, label: string, info: Bytes, len: number): Promise<Bytes> =>
  hkdfExpand(prk, concat(i2osp(len, 2), V1, suite, utf8(label), info), len);

// ---------------------------------------------------------------- X25519 plumbing
const PKCS8_X25519 = Uint8Array.of(0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20);

export interface KemKeyPair { pub: Bytes; priv: CryptoKey }

/** a fresh X25519 pair; `extractable` only for the host (keys on disk), never for browser devices */
export async function generateKemKeyPair(extractable = false): Promise<KemKeyPair> {
  const kp = (await subtle().generateKey('X25519', extractable, ['deriveBits'])) as CryptoKeyPair;
  return { pub: new Uint8Array(await subtle().exportKey('raw', kp.publicKey)), priv: kp.privateKey };
}

export async function importKemPublic(raw: Bytes): Promise<CryptoKey> {
  if (raw.length !== 32) throw new Error('bad X25519 public key');
  return subtle().importKey('raw', bs(raw), 'X25519', true, []);
}

/** import a raw 32-byte X25519 private key (PKCS#8 wrapped); used by tests and by loading the host key file */
export async function importKemPrivateRaw(raw: Bytes, extractable = false): Promise<CryptoKey> {
  return subtle().importKey('pkcs8', bs(concat(PKCS8_X25519, raw)), 'X25519', extractable, ['deriveBits']);
}

export async function exportKemPrivatePkcs8(k: CryptoKey): Promise<Bytes> {
  return new Uint8Array(await subtle().exportKey('pkcs8', k));
}
export async function importKemPrivatePkcs8(b: Bytes, extractable = false): Promise<CryptoKey> {
  return subtle().importKey('pkcs8', bs(b), 'X25519', extractable, ['deriveBits']);
}

async function dh(priv: CryptoKey, pubRaw: Bytes): Promise<Bytes> {
  const pub = await importKemPublic(pubRaw);
  const out = new Uint8Array(await subtle().deriveBits({ name: 'X25519', public: pub }, priv, 256));
  if (out.every((x) => x === 0)) throw new Error('low-order point'); // RFC 7748 / RFC 9180 7.1.4
  return out;
}

async function extractAndExpand(dhOut: Bytes, kemContext: Bytes): Promise<Bytes> {
  const prk = await labeledExtract(kemSuite, new Uint8Array(0), 'eae_prk', dhOut);
  return labeledExpand(kemSuite, prk, 'shared_secret', kemContext, NSECRET);
}

async function keySchedule(aead: AeadId, shared: Bytes, info: Bytes): Promise<{ key: Bytes; baseNonce: Bytes }> {
  const suite = hpkeSuite(aead);
  const empty = new Uint8Array(0);
  const pskIdHash = await labeledExtract(suite, empty, 'psk_id_hash', empty);
  const infoHash = await labeledExtract(suite, empty, 'info_hash', info);
  const ctx = concat(Uint8Array.of(0x00), pskIdHash, infoHash); // mode_base = 0
  const secret = await labeledExtract(suite, shared, 'secret', empty);
  return { key: await labeledExpand(suite, secret, 'key', ctx, nk(aead)), baseNonce: await labeledExpand(suite, secret, 'base_nonce', ctx, NN) };
}

async function aesGcm(mode: 'encrypt' | 'decrypt', key: Bytes, nonce: Bytes, aad: Bytes, data: Bytes): Promise<Bytes> {
  const k = await subtle().importKey('raw', bs(key), 'AES-GCM', false, [mode]);
  const params = { name: 'AES-GCM', iv: bs(nonce), additionalData: bs(aad), tagLength: 128 };
  return new Uint8Array(mode === 'encrypt' ? await subtle().encrypt(params, k, bs(data)) : await subtle().decrypt(params, k, bs(data)));
}

export interface SealOptions {
  aead?: AeadId;
  /** TEST ONLY: use this ephemeral key pair instead of a fresh one (RFC 9180 vectors) */
  ephemeral?: KemKeyPair;
}
export interface SealResult { enc: Bytes; ct: Bytes; shared: Bytes; key: Bytes; baseNonce: Bytes }

/** SealBase(pkR, info, aad, pt): returns the encapsulated key and the ciphertext (with GCM tag) */
export async function sealBase(pkR: Bytes, info: Bytes, aad: Bytes, pt: Bytes, o: SealOptions = {}): Promise<SealResult> {
  const aead = o.aead ?? AEAD_AES256;
  const e = o.ephemeral ?? (await generateKemKeyPair(false));
  const shared = await extractAndExpand(await dh(e.priv, pkR), concat(e.pub, pkR));
  const { key, baseNonce } = await keySchedule(aead, shared, info);
  const ct = await aesGcm('encrypt', key, baseNonce, aad, pt); // sequence number 0: nonce = base_nonce
  return { enc: e.pub, ct, shared, key, baseNonce };
}

/** OpenBase(enc, skR, info, aad, ct); throws on any failure */
export async function openBase(enc: Bytes, skR: CryptoKey, pkR: Bytes, info: Bytes, aad: Bytes, ct: Bytes, o: { aead?: AeadId } = {}): Promise<Bytes> {
  const aead = o.aead ?? AEAD_AES256;
  if (enc.length !== 32) throw new Error('bad enc');
  const shared = await extractAndExpand(await dh(skR, enc), concat(enc, pkR));
  const { key, baseNonce } = await keySchedule(aead, shared, info);
  return aesGcm('decrypt', key, baseNonce, aad, ct);
}

export { equal as bytesEqual };

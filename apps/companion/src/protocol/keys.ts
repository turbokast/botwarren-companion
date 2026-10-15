/**
 * Identities (Ed25519 signing key), ids, and the rotating encryption-key ring. Licence: Apache-2.0.
 */
import { b64u, bs, concat, unb64u, utf8, type Bytes } from './bytes.ts';
import { generateKemKeyPair, type KemKeyPair } from './hpke.ts';

const subtle = (): SubtleCrypto => globalThis.crypto.subtle;
const PKCS8_ED25519 = Uint8Array.of(0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20);

export interface Identity {
  /** raw 32-byte Ed25519 public key */
  pub: Bytes;
  priv: CryptoKey;
  /** base64url(SHA-256(pub)) */
  id: string;
}

export async function idOf(sigPub: Bytes): Promise<string> {
  return b64u(new Uint8Array(await subtle().digest('SHA-256', bs(sigPub))));
}

/** `extractable` = true only for the host (key file on disk). Browser devices must pass false. */
export async function generateIdentity(extractable = false): Promise<Identity> {
  const kp = (await subtle().generateKey('Ed25519', extractable, ['sign', 'verify'])) as CryptoKeyPair;
  const pub = new Uint8Array(await subtle().exportKey('raw', kp.publicKey));
  return { pub, priv: kp.privateKey, id: await idOf(pub) };
}

export async function identityFromSeed(seed: Bytes, extractable = false): Promise<Identity> {
  if (seed.length !== 32) throw new Error('seed must be 32 bytes');
  const pkcs8 = bs(concat(PKCS8_ED25519, seed));
  const priv = await subtle().importKey('pkcs8', pkcs8, 'Ed25519', extractable, ['sign']);
  // the public key is the "x" member of the JWK of an extractable import of the same seed
  const probe = extractable ? priv : await subtle().importKey('pkcs8', pkcs8, 'Ed25519', true, ['sign']);
  const pub = unb64u(String((await subtle().exportKey('jwk', probe)).x));
  return { pub, priv, id: await idOf(pub) };
}

export async function exportIdentityPkcs8(i: Identity): Promise<Bytes> {
  return new Uint8Array(await subtle().exportKey('pkcs8', i.priv));
}

export async function importIdentityPkcs8(pkcs8: Bytes, pub: Bytes, extractable = false): Promise<Identity> {
  const priv = await subtle().importKey('pkcs8', bs(pkcs8), 'Ed25519', extractable, ['sign']);
  return { pub, priv, id: await idOf(pub) };
}

export async function sign(i: Identity, domain: string, ...parts: Bytes[]): Promise<Bytes> {
  return new Uint8Array(await subtle().sign('Ed25519', i.priv, bs(concat(utf8(domain), ...parts))));
}

export async function verify(pub: Bytes, sig: Bytes, domain: string, ...parts: Bytes[]): Promise<boolean> {
  try {
    if (pub.length !== 32 || sig.length !== 64) return false;
    const k = await subtle().importKey('raw', bs(pub), 'Ed25519', false, ['verify']);
    return await subtle().verify('Ed25519', k, bs(sig), bs(concat(utf8(domain), ...parts)));
  } catch { return false; }
}

// ---------------------------------------------------------------- encryption-key ring with rotation

/** old private keys stay usable this long after they stop being the current key, then are deleted */
export const KEY_GRACE_MS = 48 * 3_600_000;
export const HOST_ROTATE_MS = 7 * 86_400_000;

export interface KemEntry { epoch: number; pair: KemKeyPair; createdAt: number; retiredAt: number | null }

export class KemKeyring {
  private entries: KemEntry[] = [];
  private readonly extractable: boolean;
  /** `extractable`: the host persists its ring; browsers keep non-extractable keys */
  constructor(extractable = false) { this.extractable = extractable; }

  static fromEntries(entries: KemEntry[], extractable = false): KemKeyring {
    const r = new KemKeyring(extractable);
    r.entries = [...entries].sort((a, b) => a.epoch - b.epoch);
    return r;
  }

  get all(): readonly KemEntry[] { return this.entries; }
  get current(): KemEntry {
    const c = this.entries.filter((e) => e.retiredAt === null).at(-1);
    if (!c) throw new Error('keyring is empty');
    return c;
  }
  get empty(): boolean { return this.entries.length === 0; }
  lookup(epoch: number): KemEntry | undefined { return this.entries.find((e) => e.epoch === epoch); }

  async init(now: number): Promise<KemEntry> {
    const e: KemEntry = { epoch: 0, pair: await generateKemKeyPair(this.extractable), createdAt: now, retiredAt: null };
    this.entries.push(e);
    return e;
  }

  /** new current key; the previous one is retired and deleted after the grace period */
  async rotate(now: number): Promise<KemEntry> {
    const cur = this.current;
    cur.retiredAt = now;
    const e: KemEntry = { epoch: cur.epoch + 1, pair: await generateKemKeyPair(this.extractable), createdAt: now, retiredAt: null };
    this.entries.push(e);
    return e;
  }

  /** drop keys retired longer than the grace period ago (forward secrecy) */
  prune(now: number): number {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.retiredAt === null || now - e.retiredAt < KEY_GRACE_MS);
    return before - this.entries.length;
  }

  rotationDue(now: number, every = HOST_ROTATE_MS): boolean { return now - this.current.createdAt >= every; }
}

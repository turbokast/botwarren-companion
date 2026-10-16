/**
 * A software WebAuthn authenticator for tests: produces the same bytes a browser hands back from `navigator.credentials.create` and `.get`
 * (attestationObject with fmt "none", authenticatorData, clientDataJSON, signature), with switches to produce every kind of bad answer the host must refuse.
 */
import { createHash, generateKeyPairSync, randomBytes, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { b64u } from '../../src/protocol/bytes.ts';

// ---- CBOR encoder (just enough for a COSE key and an attestation object)
type Enc = number | string | Uint8Array | Enc[] | Map<number | string, Enc>;
function head(major: number, n: number): number[] {
  if (n < 24) return [(major << 5) | n];
  if (n < 256) return [(major << 5) | 24, n];
  if (n < 65536) return [(major << 5) | 25, n >> 8, n & 255];
  return [(major << 5) | 26, (n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}
export function encodeCbor(v: Enc): Uint8Array {
  if (typeof v === 'number') return Uint8Array.from(v >= 0 ? head(0, v) : head(1, -1 - v));
  if (typeof v === 'string') { const b = Buffer.from(v, 'utf8'); return Uint8Array.from([...head(3, b.length), ...b]); }
  if (v instanceof Uint8Array) return Uint8Array.from([...head(2, v.length), ...v]);
  if (Array.isArray(v)) return Uint8Array.from([...head(4, v.length), ...v.flatMap((x) => [...encodeCbor(x)])]);
  return Uint8Array.from([...head(5, v.size), ...[...v.entries()].flatMap(([k, x]) => [...encodeCbor(k), ...encodeCbor(x)])]);
}

export type Alg = -7 | -8 | -257;
export interface AuthOptions {
  rpId?: string; origin?: string; uv?: boolean; up?: boolean; type?: string;
  /** the counter this answer carries (default: the authenticator's own, incremented) */
  signCount?: number;
  /** sign with another key (a different authenticator) */
  wrongKey?: boolean;
  /** put this challenge in clientDataJSON instead of the one given */
  challenge?: string;
  /** corrupt the signature */
  badSignature?: boolean;
  crossOrigin?: boolean;
}

export class VirtualAuthenticator {
  readonly alg: Alg;
  readonly credId = randomBytes(32);
  signCount = 0;
  /** an authenticator that never counts (some platform passkeys send 0 always) */
  neverCounts = false;
  readonly rpId: string;
  readonly origin: string;
  private priv: KeyObject;
  private pub: KeyObject;
  private other: KeyObject;

  constructor(o: { alg?: Alg; rpId: string; origin: string; rsaBits?: number }) {
    this.alg = o.alg ?? -7; this.rpId = o.rpId; this.origin = o.origin;
    const gen = (): { privateKey: KeyObject; publicKey: KeyObject } => (this.alg === -7 ? generateKeyPairSync('ec', { namedCurve: 'P-256' }) : this.alg === -8 ? generateKeyPairSync('ed25519') : generateKeyPairSync('rsa', { modulusLength: o.rsaBits ?? 2048 }));
    const k = gen(); this.priv = k.privateKey; this.pub = k.publicKey;
    this.other = gen().privateKey;
  }

  get id(): string { return b64u(this.credId); }

  private cose(): Uint8Array {
    const jwk = this.pub.export({ format: 'jwk' }) as Record<string, string>;
    const d = (s: string): Uint8Array => Buffer.from(s, 'base64url');
    if (this.alg === -7) return encodeCbor(new Map<number | string, Enc>([[1, 2], [3, -7], [-1, 1], [-2, d(jwk.x!)], [-3, d(jwk.y!)]]));
    if (this.alg === -8) return encodeCbor(new Map<number | string, Enc>([[1, 1], [3, -8], [-1, 6], [-2, d(jwk.x!)]]));
    return encodeCbor(new Map<number | string, Enc>([[1, 3], [3, -257], [-1, d(jwk.n!)], [-2, d(jwk.e!)]]));
  }

  private clientData(type: string, challenge: string, origin: string, crossOrigin: boolean): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin }), 'utf8');
  }

  private flags(o: AuthOptions, at: boolean): number { return (o.up === false ? 0 : 0x01) | (o.uv === false ? 0 : 0x04) | (at ? 0x40 : 0); }

  /** what `navigator.credentials.create` returns, as the `su_reg` fields */
  create(challenge: string, o: AuthOptions = {}): { id: string; ao: string; cd: string } {
    const rpHash = createHash('sha256').update(o.rpId ?? this.rpId).digest();
    const counter = Buffer.alloc(4); counter.writeUInt32BE(this.signCount);
    const len = Buffer.alloc(2); len.writeUInt16BE(this.credId.length);
    const authData = Buffer.concat([rpHash, Buffer.from([this.flags(o, true)]), counter, Buffer.alloc(16), len, this.credId, this.cose()]);
    const ao = encodeCbor(new Map<number | string, Enc>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
    const cd = this.clientData(o.type ?? 'webauthn.create', o.challenge ?? challenge, o.origin ?? this.origin, o.crossOrigin ?? false);
    return { id: this.id, ao: b64u(ao), cd: b64u(cd) };
  }

  /** what `navigator.credentials.get` returns, as the `su_assert` fields (minus `ch`) */
  get(challenge: string, o: AuthOptions = {}): { id: string; ad: string; cd: string; sig: string } {
    const rpHash = createHash('sha256').update(o.rpId ?? this.rpId).digest();
    if (o.signCount === undefined && !this.neverCounts) this.signCount += 1;
    const count = o.signCount ?? (this.neverCounts ? 0 : this.signCount);
    const counter = Buffer.alloc(4); counter.writeUInt32BE(count);
    const authData = Buffer.concat([rpHash, Buffer.from([this.flags(o, false)]), counter]);
    const cd = this.clientData(o.type ?? 'webauthn.get', o.challenge ?? challenge, o.origin ?? this.origin, o.crossOrigin ?? false);
    const signed = Buffer.concat([authData, createHash('sha256').update(cd).digest()]);
    const key = o.wrongKey ? this.other : this.priv;
    let sig = this.alg === -8 ? cryptoSign(null, signed, key) : cryptoSign('sha256', signed, key);
    if (o.badSignature) { sig = Buffer.from(sig); sig[sig.length - 1] = sig[sig.length - 1]! ^ 0xff; }
    return { id: this.id, ad: b64u(authData), cd: b64u(cd), sig: b64u(sig) };
  }
}

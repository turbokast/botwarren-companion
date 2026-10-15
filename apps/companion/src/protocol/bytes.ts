/**
 * Byte helpers with no Node-only APIs, so the same code runs in the browser client, the relay and the companion.
 * Licence: Apache-2.0.
 */

export type Bytes = Uint8Array;

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });

export const utf8 = (s: string): Bytes => enc.encode(s);
export const fromUtf8 = (b: Bytes): string => dec.decode(b);

/** unpadded base64url */
export function b64u(b: Bytes): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64u(s: string): Bytes {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('bad base64url');
  const p = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(p);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function hex(b: Bytes): string {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

export function unhex(s: string): Bytes {
  if (s.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(s)) throw new Error('bad hex');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function concat(...parts: Bytes[]): Bytes {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** length-independent-time comparison for equal-length inputs; false for different lengths */
export function equal(a: Bytes, b: Bytes): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

export function randomBytes(n: number): Bytes {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

export const i2osp = (n: number, len: number): Bytes => {
  const out = new Uint8Array(len);
  let v = n;
  for (let i = len - 1; i >= 0; i--) { out[i] = v & 0xff; v = Math.floor(v / 256); }
  return out;
};

/** TypeScript 5.9 types Uint8Array<ArrayBufferLike>; WebCrypto wants a BufferSource: copy into a plain ArrayBuffer view. */
export const bs = (b: Bytes): Uint8Array<ArrayBuffer> => {
  const c = new Uint8Array(new ArrayBuffer(b.length));
  c.set(b);
  return c;
};

/** Crockford base32 (no I, L, O, U), used for the short pairing code */
const CROCK = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function crockford(b: Bytes): string {
  let bits = 0; let acc = 0; let out = '';
  for (const x of b) {
    acc = (acc << 8) | x; bits += 8;
    while (bits >= 5) { out += CROCK[(acc >>> (bits - 5)) & 31]; bits -= 5; }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += CROCK[(acc << (5 - bits)) & 31];
  return out;
}

export function uncrockford(s: string): Bytes {
  const clean = s.toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  const out: number[] = [];
  let bits = 0; let acc = 0;
  for (const ch of clean) {
    const v = CROCK.indexOf(ch);
    if (v < 0) throw new Error('bad code character');
    acc = (acc << 5) | v; bits += 5;
    if (bits >= 8) { out.push((acc >>> (bits - 8)) & 0xff); bits -= 8; }
    acc &= (1 << bits) - 1;
  }
  return Uint8Array.from(out);
}

/**
 * The message envelope: what the relay carries, and how a receiver checks it. See docs/PROTOCOL.md section 5.
 *
 *   frame  = { t:"msg", h: b64u(header JSON), c: b64u(enc || ciphertext), s: b64u(signature) }
 *   s      = Ed25519_sender( "botwarren-link-v1/msg\0" || header bytes || c )
 *   c      = HPKE SealBase(recipient epoch key, info "botwarren-link/v1/msg", aad = header bytes, padded inner message)
 *
 * Licence: Apache-2.0.
 */
import { b64u, concat, fromUtf8, unb64u, utf8, randomBytes, type Bytes } from './bytes.ts';
import { openBase, sealBase } from './hpke.ts';
import { sign, verify, type Identity, type KemKeyring } from './keys.ts';

export const DOMAIN = {
  msg: 'botwarren-link-v1/msg\0',
  cert: 'botwarren-link-v1/cert\0',
  ticket: 'botwarren-link-v1/ticket\0',
  auth: 'botwarren-link-v1/auth\0',
  revoke: 'botwarren-link-v1/revoke\0',
  killlist: 'botwarren-link-v1/killlist\0',
} as const;

export const HPKE_INFO = utf8('botwarren-link/v1/msg');
/** the biggest frame (the whole websocket text) a relay of this version accepts; a 0.1.2 relay accepts 16 KB: see `maxInnerFor` and the relay's `ready.maxFrame` */
export const MAX_FRAME_BYTES = 96 * 1024;
export const LEGACY_FRAME_BYTES = 16 * 1024;
export const MAX_INNER_BYTES = 65_536 - 2;
export const CLOCK_SKEW_MS = 120_000;
/** padded sizes of the inner message. Up to 8192 is what every version understands; the three larger ones carry long messages (0.1.3) and are used only for a device that said it can read them */
export const BUCKETS = [256, 512, 1024, 2048, 4096, 8192, 16_384, 32_768, 65_536] as const;
export const LEGACY_INNER_BYTES = 8192 - 2;

/** bytes of a websocket frame carrying a padded inner message of `bucket` bytes (HPKE enc 32 + tag 16, base64url, header 600 max, signature 86, JSON keys) */
export const frameBytesFor = (bucket: number): number => Math.ceil(((bucket + 48) * 4) / 3) + 800;

/** the largest inner message (JSON bytes) that still fits a relay whose frame limit is `maxFrame` (16 KB for a relay that does not say) */
export function maxInnerFor(maxFrame: number): number {
  let best = 0;
  for (const b of BUCKETS) if (frameBytesFor(b) <= maxFrame) best = b - 2;
  return Math.max(best, 0);
}

/**
 * `r` is the optional REPLACE KEY: an opaque, sender-chosen label (1 to 16 characters). The relay may drop an older queued frame of the same
 * sender and recipient that carries the same key, so a device that was away gets the newest state instead of a pile of old ones. It is part
 * of the signed header (the relay cannot add, change or strip it unnoticed) and it says nothing about the content.
 */
export interface Header { v: 1; f: string; t: string; n: number; ts: number; x: number; ep: number; m: string; r?: string }
export interface Frame { t: 'msg'; h: string; c: string; s: string }
export interface PeerKey { id: string; kemPub: Bytes; epoch: number }

const ID = /^[A-Za-z0-9_-]{43}$/;

// ---------------------------------------------------------------- padding
export function pad(payload: Bytes): Bytes {
  if (payload.length > MAX_INNER_BYTES) throw new Error('message too large');
  const need = payload.length + 2;
  const size = BUCKETS.find((b) => b >= need) ?? 65_536;
  const out = new Uint8Array(size);
  out[0] = payload.length >>> 8; out[1] = payload.length & 0xff;
  out.set(payload, 2);
  return out;
}

export function unpad(padded: Bytes): Bytes | null {
  if (padded.length < 2 || !(BUCKETS as readonly number[]).includes(padded.length)) return null;
  const n = (padded[0]! << 8) | padded[1]!;
  if (n + 2 > padded.length) return null;
  for (let i = 2 + n; i < padded.length; i++) if (padded[i] !== 0) return null; // padding must be zeros
  return padded.subarray(2, 2 + n);
}

// ---------------------------------------------------------------- sender side
export interface SealInput {
  from: Identity;
  to: PeerKey;
  seq: number;
  now: number;
  ttlMs: number;
  kind: string;
  data: unknown;
  /** replace key (see Header.r): a newer frame with the same key supersedes an older one still queued at the relay */
  replace?: string;
}

export const REPLACE_KEY = /^[A-Za-z0-9_-]{1,16}$/;

export async function sealMessage(i: SealInput): Promise<Frame> {
  const header: Header = { v: 1, f: i.from.id, t: i.to.id, n: i.seq, ts: i.now, x: i.now + i.ttlMs, ep: i.to.epoch, m: b64u(randomBytes(12)), ...(i.replace ? { r: i.replace } : {}) };
  if (header.r !== undefined && !REPLACE_KEY.test(header.r)) throw new Error('bad replace key');
  const hBytes = utf8(JSON.stringify(header));
  const inner = utf8(JSON.stringify({ k: i.kind, f: i.from.id, t: i.to.id, d: i.data }));
  const sealed = await sealBase(i.to.kemPub, HPKE_INFO, hBytes, pad(inner));
  const c = concat(sealed.enc, sealed.ct);
  const sig = await sign(i.from, DOMAIN.msg, hBytes, c);
  return { t: 'msg', h: b64u(hBytes), c: b64u(c), s: b64u(sig) };
}

/** The 4 fields the relay may look at, verified for shape only (it cannot decrypt). */
export function peekHeader(frame: unknown): { header: Header; hBytes: Bytes; c: Bytes; sig: Bytes } | null {
  try {
    const f = frame as Partial<Frame>;
    if (!f || f.t !== 'msg' || typeof f.h !== 'string' || typeof f.c !== 'string' || typeof f.s !== 'string') return null;
    if (f.h.length > 600 || f.c.length > MAX_FRAME_BYTES * 2 || f.s.length !== 86) return null;
    const hBytes = unb64u(f.h);
    const h = JSON.parse(fromUtf8(hBytes)) as Header;
    if (h.v !== 1 || !ID.test(h.f) || !ID.test(h.t)) return null;
    if (!Number.isSafeInteger(h.n) || h.n < 0 || !Number.isSafeInteger(h.ts) || !Number.isSafeInteger(h.x) || !Number.isSafeInteger(h.ep) || h.ep < 0) return null;
    if (typeof h.m !== 'string' || !/^[A-Za-z0-9_-]{16}$/.test(h.m)) return null;
    if (h.r !== undefined && (typeof h.r !== 'string' || !REPLACE_KEY.test(h.r))) return null;
    return { header: h, hBytes, c: unb64u(f.c), sig: unb64u(f.s) };
  } catch { return null; }
}

/** signature check usable by the relay (it knows the sender's public key from the certificate chain) */
export async function verifyFrameSignature(frame: unknown, senderPub: Bytes): Promise<Header | null> {
  const p = peekHeader(frame);
  if (!p) return null;
  return (await verify(senderPub, p.sig, DOMAIN.msg, p.hBytes, p.c)) ? p.header : null;
}

// ---------------------------------------------------------------- replay guard
export class ReplayGuard {
  private readonly highest = new Map<string, number>();
  constructor(initial: Record<string, number> = {}) { for (const [k, v] of Object.entries(initial)) this.highest.set(k, v); }
  fresh(sender: string, n: number): boolean { return n > (this.highest.get(sender) ?? -1); }
  commit(sender: string, n: number): void { if (this.fresh(sender, n)) this.highest.set(sender, n); }
  snapshot(): Record<string, number> { return Object.fromEntries(this.highest); }
  forget(sender: string): void { this.highest.delete(sender); }
}

/** monotonic send counter persisted in blocks so a crash can never reuse a number */
export class SendCounter {
  private next_: number;
  private reserved: number;
  private readonly block: number;
  private readonly persist: (reservedUntil: number) => void;
  constructor(persistedReserved: number, block: number, persist: (reservedUntil: number) => void) {
    this.next_ = persistedReserved; this.reserved = persistedReserved; this.block = block; this.persist = persist;
  }
  next(): number {
    if (this.next_ >= this.reserved) { this.reserved = this.next_ + this.block; this.persist(this.reserved); }
    return this.next_++;
  }
}

// ---------------------------------------------------------------- receiver side
export type OpenCode =
  | 'malformed' | 'wrong_recipient' | 'unknown_sender' | 'revoked' | 'bad_signature' | 'expired' | 'future' | 'replay'
  | 'no_key' | 'decrypt_failed' | 'bad_padding' | 'inner_mismatch' | 'bad_inner';

export interface Opened { from: string; kind: string; data: unknown; n: number; ts: number; m: string }
export type OpenResult = { ok: true; msg: Opened } | { ok: false; code: OpenCode };

export interface OpenContext {
  me: { id: string; ring: KemKeyring };
  /** the sender's raw Ed25519 public key, or null if it is not a known peer */
  senderKey: (id: string) => Bytes | null;
  isRevoked?: (id: string) => boolean;
  guard: ReplayGuard;
  now: number;
}

export async function openMessage(frame: unknown, c: OpenContext): Promise<OpenResult> {
  const p = peekHeader(frame);
  if (!p) return { ok: false, code: 'malformed' };
  const h = p.header;
  if (h.t !== c.me.id) return { ok: false, code: 'wrong_recipient' };
  const pub = c.senderKey(h.f);
  if (!pub) return { ok: false, code: 'unknown_sender' };
  if (c.isRevoked?.(h.f)) return { ok: false, code: 'revoked' };
  if (!(await verify(pub, p.sig, DOMAIN.msg, p.hBytes, p.c))) return { ok: false, code: 'bad_signature' };
  if (c.now > h.x + CLOCK_SKEW_MS) return { ok: false, code: 'expired' };
  if (h.ts > c.now + CLOCK_SKEW_MS) return { ok: false, code: 'future' };
  if (!c.guard.fresh(h.f, h.n)) return { ok: false, code: 'replay' };
  const key = c.me.ring.lookup(h.ep);
  if (!key) return { ok: false, code: 'no_key' };
  if (p.c.length < 33) return { ok: false, code: 'malformed' };
  let padded: Bytes;
  try { padded = await openBase(p.c.subarray(0, 32), key.pair.priv, key.pair.pub, HPKE_INFO, p.hBytes, p.c.subarray(32)); } catch { return { ok: false, code: 'decrypt_failed' }; }
  const inner = unpad(padded);
  if (!inner) return { ok: false, code: 'bad_padding' };
  let obj: { k?: unknown; f?: unknown; t?: unknown; d?: unknown };
  try { obj = JSON.parse(fromUtf8(inner)) as typeof obj; } catch { return { ok: false, code: 'bad_inner' }; }
  if (typeof obj.k !== 'string' || obj.k.length > 32) return { ok: false, code: 'bad_inner' };
  if (obj.f !== h.f || obj.t !== h.t) return { ok: false, code: 'inner_mismatch' };
  c.guard.commit(h.f, h.n);
  return { ok: true, msg: { from: h.f, kind: obj.k, data: obj.d, n: h.n, ts: h.ts, m: h.m } };
}

import { describe, expect, it } from 'vitest';
import {
  LEGACY_FRAME_BYTES, frameBytesFor, maxInnerFor,
  BUCKETS, KemKeyring, KEY_GRACE_MS, MAX_FRAME_BYTES, ReplayGuard, SendCounter, b64u, concat, fromUtf8, generateIdentity, openMessage, pad, peekHeader, sealBase, sealMessage, sign,
  unb64u, unpad, utf8, verifyFrameSignature, DOMAIN, HPKE_INFO, type Frame, type Identity,
} from '../src/protocol/index.ts';

const NOW = 1_800_000_000_000;

async function pair() {
  const host = await generateIdentity(true);
  const dev = await generateIdentity(false);
  const hostRing = new KemKeyring(true); await hostRing.init(NOW);
  const devRing = new KemKeyring(false); await devRing.init(NOW);
  return {
    host, dev, hostRing, devRing,
    toDev: { id: dev.id, kemPub: devRing.current.pair.pub, epoch: 0 },
    toHost: { id: host.id, kemPub: hostRing.current.pair.pub, epoch: 0 },
  };
}

const known = (...ids: Identity[]) => (id: string) => ids.find((i) => i.id === id)?.pub ?? null;

describe('envelope: round trip and the order of checks', () => {
  it('seals on one side and opens on the other; the relay-visible header carries no content', async () => {
    const p = await pair();
    const frame = await sealMessage({ from: p.host, to: p.toDev, seq: 1, now: NOW, ttlMs: 60_000, kind: 'state', data: { hello: 'world' } });
    expect(JSON.stringify(frame)).not.toContain('world');
    expect(fromUtf8(unb64u(frame.h))).not.toContain('state'); // kind is inside the ciphertext
    const r = await openMessage(frame, { me: { id: p.dev.id, ring: p.devRing }, senderKey: known(p.host), guard: new ReplayGuard(), now: NOW + 1000 });
    expect(r).toMatchObject({ ok: true, msg: { from: p.host.id, kind: 'state', data: { hello: 'world' }, n: 1 } });
    expect(await verifyFrameSignature(frame, p.host.pub)).toMatchObject({ f: p.host.id, t: p.dev.id });
    expect(await verifyFrameSignature(frame, p.dev.pub)).toBeNull();
  });

  it('pads to size buckets so the relay learns only a bucket', async () => {
    const p = await pair();
    const sizes = new Set<number>();
    for (const n of [1, 50, 300, 900]) {
      const f = await sealMessage({ from: p.host, to: p.toDev, seq: n, now: NOW, ttlMs: 60_000, kind: 'state', data: { x: 'a'.repeat(n) } });
      sizes.add(unb64u(f.c).length - 32 - 16);
    }
    for (const s of sizes) expect(BUCKETS as readonly number[]).toContain(s);
    expect(pad(new Uint8Array(10)).length).toBe(256);
    expect(unpad(pad(utf8('hi')))).toEqual(utf8('hi'));
    expect(pad(new Uint8Array(9000)).length).toBe(16_384); // 0.1.3: long messages use the larger buckets
    expect(pad(new Uint8Array(40_000)).length).toBe(65_536);
    expect(() => pad(new Uint8Array(65_535))).toThrow();
    const bad = pad(utf8('hi')); bad[100] = 1;
    expect(unpad(bad)).toBeNull();
  });

  it('rejects a tampered ciphertext, header, signature and a different sender key', async () => {
    const p = await pair();
    const ctx = () => ({ me: { id: p.dev.id, ring: p.devRing }, senderKey: known(p.host), guard: new ReplayGuard(), now: NOW });
    const f = await sealMessage({ from: p.host, to: p.toDev, seq: 1, now: NOW, ttlMs: 60_000, kind: 'state', data: {} });
    const flip = (b64: string) => { const b = unb64u(b64); b[b.length - 1] = b[b.length - 1]! ^ 1; return b64u(b); };
    expect(await openMessage({ ...f, c: flip(f.c) }, ctx())).toEqual({ ok: false, code: 'bad_signature' });
    expect(await openMessage({ ...f, s: flip(f.s) }, ctx())).toEqual({ ok: false, code: 'bad_signature' });
    const h = JSON.parse(fromUtf8(unb64u(f.h))); h.n = 99;
    expect(await openMessage({ ...f, h: b64u(utf8(JSON.stringify(h))) }, ctx())).toEqual({ ok: false, code: 'bad_signature' });
    expect(await openMessage(f, { ...ctx(), senderKey: () => p.dev.pub })).toEqual({ ok: false, code: 'bad_signature' });
    expect(await openMessage({ t: 'msg', h: 'x' }, ctx())).toEqual({ ok: false, code: 'malformed' });
  });

  it('even a validly signed ciphertext with a swapped header fails to decrypt (header is the AAD)', async () => {
    const p = await pair();
    const f = await sealMessage({ from: p.host, to: p.toDev, seq: 5, now: NOW, ttlMs: 60_000, kind: 'state', data: {} });
    const h = JSON.parse(fromUtf8(unb64u(f.h)));
    h.m = 'AAAAAAAAAAAAAAAA';
    const hBytes = utf8(JSON.stringify(h));
    const resigned: Frame = { t: 'msg', h: b64u(hBytes), c: f.c, s: b64u(await sign(p.host, DOMAIN.msg, hBytes, unb64u(f.c))) };
    expect(await openMessage(resigned, { me: { id: p.dev.id, ring: p.devRing }, senderKey: known(p.host), guard: new ReplayGuard(), now: NOW })).toEqual({ ok: false, code: 'decrypt_failed' });
  });

  it('replay: a second delivery, a lower counter and a stale duplicate are dropped', async () => {
    const p = await pair();
    const guard = new ReplayGuard();
    const ctx = { me: { id: p.dev.id, ring: p.devRing }, senderKey: known(p.host), guard, now: NOW };
    const f1 = await sealMessage({ from: p.host, to: p.toDev, seq: 1, now: NOW, ttlMs: 60_000, kind: 'state', data: {} });
    const f2 = await sealMessage({ from: p.host, to: p.toDev, seq: 2, now: NOW, ttlMs: 60_000, kind: 'state', data: {} });
    expect((await openMessage(f2, ctx)).ok).toBe(true);
    expect(await openMessage(f2, ctx)).toEqual({ ok: false, code: 'replay' });
    expect(await openMessage(f1, ctx)).toEqual({ ok: false, code: 'replay' });
    // the guard persists across restarts
    const again = new ReplayGuard(guard.snapshot());
    expect(await openMessage(f2, { ...ctx, guard: again })).toEqual({ ok: false, code: 'replay' });
  });

  it('expiry and clock rules', async () => {
    const p = await pair();
    const base = { me: { id: p.dev.id, ring: p.devRing }, senderKey: known(p.host) };
    const f = await sealMessage({ from: p.host, to: p.toDev, seq: 1, now: NOW, ttlMs: 10_000, kind: 'state', data: {} });
    expect(await openMessage(f, { ...base, guard: new ReplayGuard(), now: NOW + 10_000 + 200_000 })).toEqual({ ok: false, code: 'expired' });
    expect(await openMessage(f, { ...base, guard: new ReplayGuard(), now: NOW - 600_000 })).toEqual({ ok: false, code: 'future' });
    expect((await openMessage(f, { ...base, guard: new ReplayGuard(), now: NOW + 30_000 })).ok).toBe(true);
  });

  it('wrong device: a message for device A cannot be opened as device B, nor accepted from an unknown or revoked sender', async () => {
    const p = await pair();
    const other = await generateIdentity(false);
    const otherRing = new KemKeyring(false); await otherRing.init(NOW);
    const f = await sealMessage({ from: p.host, to: p.toDev, seq: 1, now: NOW, ttlMs: 60_000, kind: 'state', data: {} });
    expect(await openMessage(f, { me: { id: other.id, ring: otherRing }, senderKey: known(p.host), guard: new ReplayGuard(), now: NOW })).toEqual({ ok: false, code: 'wrong_recipient' });
    expect(await openMessage(f, { me: { id: p.dev.id, ring: p.devRing }, senderKey: () => null, guard: new ReplayGuard(), now: NOW })).toEqual({ ok: false, code: 'unknown_sender' });
    expect(await openMessage(f, { me: { id: p.dev.id, ring: p.devRing }, senderKey: known(p.host), isRevoked: (id) => id === p.host.id, guard: new ReplayGuard(), now: NOW })).toEqual({ ok: false, code: 'revoked' });
    // an attacker device that is NOT paired signs a message to the host
    const evil = await generateIdentity(false);
    const fe = await sealMessage({ from: evil, to: p.toHost, seq: 1, now: NOW, ttlMs: 60_000, kind: 'action', data: {} });
    expect(await openMessage(fe, { me: { id: p.host.id, ring: p.hostRing }, senderKey: known(p.dev), guard: new ReplayGuard(), now: NOW })).toEqual({ ok: false, code: 'unknown_sender' });
  });

  it('no reflection: a message the host sent to the device cannot be replayed to the host', async () => {
    const p = await pair();
    const f = await sealMessage({ from: p.host, to: p.toDev, seq: 1, now: NOW, ttlMs: 60_000, kind: 'state', data: {} });
    expect(await openMessage(f, { me: { id: p.host.id, ring: p.hostRing }, senderKey: known(p.host, p.dev), guard: new ReplayGuard(), now: NOW })).toEqual({ ok: false, code: 'wrong_recipient' });
  });

  it('inner sender/recipient must equal the header (no re-wrapping of someone else\'s plaintext)', async () => {
    const p = await pair();
    // a paired-but-malicious device takes plaintext addressed from the host and seals it as its own message to the host
    const hdr = { v: 1, f: p.dev.id, t: p.host.id, n: 1, ts: NOW, x: NOW + 60_000, ep: 0, m: 'AAAAAAAAAAAAAAAA' };
    const hBytes = utf8(JSON.stringify(hdr));
    const inner = pad(utf8(JSON.stringify({ k: 'action', f: p.host.id, t: p.dev.id, d: {} })));
    const sealed = await sealBase(p.toHost.kemPub, HPKE_INFO, hBytes, inner);
    const c = concat(sealed.enc, sealed.ct);
    const frame: Frame = { t: 'msg', h: b64u(hBytes), c: b64u(c), s: b64u(await sign(p.dev, DOMAIN.msg, hBytes, c)) };
    expect(await openMessage(frame, { me: { id: p.host.id, ring: p.hostRing }, senderKey: known(p.dev), guard: new ReplayGuard(), now: NOW })).toEqual({ ok: false, code: 'inner_mismatch' });
  });

  it('peekHeader rejects oversize and malformed frames', () => {
    expect(peekHeader({ t: 'msg', h: 'a'.repeat(700), c: 'x', s: 'y' })).toBeNull();
    expect(peekHeader(null)).toBeNull();
    expect(MAX_FRAME_BYTES).toBe(96 * 1024);
    expect(LEGACY_FRAME_BYTES).toBe(16384); // a 0.1.2 relay
    expect(maxInnerFor(LEGACY_FRAME_BYTES)).toBe(8190); // against such a relay a frame stays in the old 8 KB bucket
    expect(maxInnerFor(MAX_FRAME_BYTES)).toBe(65_534);
    expect(frameBytesFor(65_536)).toBeLessThanOrEqual(MAX_FRAME_BYTES);
  });

  it('SendCounter never reuses a number across a crash', () => {
    let disk = 0;
    const a = new SendCounter(disk, 100, (n) => { disk = n; });
    const first = [a.next(), a.next(), a.next()];
    expect(first).toEqual([0, 1, 2]);
    const b = new SendCounter(disk, 100, (n) => { disk = n; }); // "restart": resumes after the reserved block
    expect(b.next()).toBeGreaterThan(Math.max(...first));
  });
});

describe('key rotation and forward secrecy', () => {
  it('a new epoch works, the previous one still opens during the grace period, then is deleted', async () => {
    const p = await pair();
    const oldKey = { id: p.dev.id, kemPub: p.devRing.current.pair.pub, epoch: 0 };
    const before = await sealMessage({ from: p.host, to: oldKey, seq: 1, now: NOW, ttlMs: 10 * 86_400_000, kind: 'state', data: { a: 1 } });
    await p.devRing.rotate(NOW + 1000);
    const fresh = { id: p.dev.id, kemPub: p.devRing.current.pair.pub, epoch: 1 };
    const after = await sealMessage({ from: p.host, to: fresh, seq: 2, now: NOW + 2000, ttlMs: 10 * 86_400_000, kind: 'state', data: { a: 2 } });
    const mk = (guard: ReplayGuard, now: number) => ({ me: { id: p.dev.id, ring: p.devRing }, senderKey: known(p.host), guard, now });
    expect((await openMessage(after, mk(new ReplayGuard(), NOW + 3000))).ok).toBe(true);
    expect((await openMessage(before, mk(new ReplayGuard(), NOW + 3000))).ok).toBe(true); // within grace
    expect(p.devRing.prune(NOW + 1000 + KEY_GRACE_MS + 1)).toBe(1);
    expect(await openMessage(before, mk(new ReplayGuard(), NOW + 1000 + KEY_GRACE_MS + 2))).toEqual({ ok: false, code: 'no_key' }); // forward secrecy
    expect((await openMessage(after, mk(new ReplayGuard(), NOW + 1000 + KEY_GRACE_MS + 2))).ok).toBe(true);
  });

  it('rotationDue follows the schedule', async () => {
    const r = new KemKeyring(true); await r.init(NOW);
    expect(r.rotationDue(NOW + 1000)).toBe(false);
    expect(r.rotationDue(NOW + 8 * 86_400_000)).toBe(true);
  });
});

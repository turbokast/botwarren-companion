import { afterEach, describe, expect, it } from 'vitest';
import { peekHeader, sealMessage, type Identity } from '@botwarren/companion/protocol';
import { makeWorld } from './kit.ts';

const fast = { rates: { connBurst: 1000, connPerSec: 1000, acctBurst: 1000, acctPerSec: 1000 } };
let world: Awaited<ReturnType<typeof makeWorld>> | null = null;
afterEach(async () => { await world?.close(); world = null; });

/**
 * 0.1.3: one sender cannot fill a recipient's queue, with or without replace keys. The owner's relay (0.1.2) showed 321 frames, 124 overflow drops and 19 queued
 * while the phone was away, because the computer that was RUNNING was still 0.1.1 (it was never restarted after the update) and sent a frame per event with no key.
 */
describe('relay: one sender cannot fill a queue, with or without replace keys', () => {
  const seal = (w: NonNullable<typeof world>, from: Identity, to: { id: Identity; ring: { current: { pair: { pub: Uint8Array } } } }, seq: number, kind: string, replace?: string, data: unknown = { seq }) =>
    sealMessage({ from, to: { id: to.id.id, kemPub: to.ring.current.pair.pub, epoch: 0 }, seq, now: w.now(), ttlMs: 600_000, kind, data, ...(replace ? { replace } : {}) });
  const queueOf = (w: NonNullable<typeof world>, id: string) => (w.relay as unknown as { queues: Map<string, { m: string; r?: string; f: string }[]> }).queues.get(id) ?? [];

  it('a computer from before 0.1.2 (a frame per event, no replace key) leaves at most 12 frames for an away phone, the newest, and no overflow', async () => {
    world = await makeWorld(fast);
    const w = world;
    const dev = await w.addDevice();
    const h = w.connect(w.host, 'host');
    await w.until(() => h.conn.online);
    for (let i = 1; i <= 120; i++) { h.conn.sendFrame(await seal(w, w.host.id, dev, i, 'state')); }
    await w.until(() => (w.relay.counters.get('frames') ?? 0) >= 100, 8000);
    const q = queueOf(w, dev.id.id);
    expect(q.length).toBeLessThanOrEqual(12);
    expect(w.relay.counters.get('queue_overflow') ?? 0).toBe(0);
    expect(w.relay.counters.get('queue_trimmed') ?? 0).toBeGreaterThan(0);
    const d = w.connect(dev, 'device');
    await w.until(() => d.frames.length === q.length);
    const ns = d.frames.map((f) => peekHeader(f)!.header.n);
    expect(Math.min(...ns)).toBeGreaterThan(Math.max(...ns) - 40); // the newest ones, not the oldest
  }, 30_000);

  it('a sender using a new replace key for every frame is capped at 8 keys', async () => {
    world = await makeWorld(fast);
    const w = world;
    const dev = await w.addDevice();
    const h = w.connect(w.host, 'host');
    await w.until(() => h.conn.online);
    for (let i = 1; i <= 20; i++) { h.conn.sendFrame(await seal(w, w.host.id, dev, i, 'state', `k${i}`)); await new Promise((r) => setTimeout(r, 30)); }
    await w.until(() => (w.relay.counters.get('frames') ?? 0) >= 20, 8000);
    expect(queueOf(w, dev.id.id).filter((x) => x.r)).toHaveLength(8);
    expect(w.relay.counters.get('queue_overflow') ?? 0).toBe(0);
  }, 30_000);

  it('a phone that reconnects again and again leaves ONE sync and ONE alerts registration for an absent computer (device frames carry replace keys)', async () => {
    world = await makeWorld(fast);
    const w = world;
    const dev = await w.addDevice();
    const d = w.connect(dev, 'device');
    await w.until(() => d.conn.online);
    for (let i = 1; i <= 12; i++) {
      d.conn.sendFrame(await seal(w, dev.id, w.host, i * 2 - 1, 'sync', 'y'));
      d.conn.sendFrame(await seal(w, dev.id, w.host, i * 2, 'push', 'p'));
      await new Promise((r) => setTimeout(r, 60));
    }
    await w.until(() => (w.relay.counters.get('frames') ?? 0) >= 24, 8000);
    expect(queueOf(w, w.host.id.id).map((x) => x.r).sort()).toEqual(['p', 'y']);
  }, 30_000);

  it('`ready` announces the frame limit; a 40 KB state (64 KB bucket) is carried', async () => {
    world = await makeWorld(fast);
    const w = world;
    const dev = await w.addDevice();
    let max: number | undefined;
    const h = w.connect(w.host, 'host', () => {}, { onState: (s, info) => { if (s === 'online') max = info?.maxFrame; } });
    await w.until(() => h.conn.online);
    expect(max).toBe(96 * 1024);
    const big = await seal(w, w.host.id, dev, 1, 'state', 's', { t: 'z'.repeat(40_000) });
    expect(big.c.length).toBeGreaterThan(80_000);
    h.conn.sendFrame(big);
    await w.until(() => w.relay.counters.get('frames') === 1);
    expect(queueOf(w, dev.id.id)).toHaveLength(1);
  }, 30_000);
});

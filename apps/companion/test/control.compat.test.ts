import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { controlWorld, sleep, waitFor, type ControlWorld } from './support/control-world.ts';
import { Store } from '../src/store.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { CAP_LONG, PROTO_VERSION } from '../src/protocol/index.ts';
import type { SimDevice } from './simdevice.ts';

/**
 * Backwards compatibility: a phone page from before protocol 3 must see exactly what it saw before, and the relay is unchanged (it carries the same sealed
 * frames, with the same header fields). Devices and configs written before 0.3.0 keep working with the safe defaults.
 */
describe('old clients and old files', () => {
  let cw: ControlWorld; let old2: SimDevice; let old1: SimDevice;
  beforeAll(async () => {
    cw = await controlWorld();
    old2 = await cw.w.pairDevice('Old phone 0.2', { caps: [CAP_LONG], proto: 2 });
    old1 = await cw.w.pairDevice('Older phone 0.1', { proto: 1 });
  });
  afterAll(async () => { await cw.close(); });

  const ALLOWED_OLD = new Set(['state', 'result', 'pushack', 'pushtestack', 'keyupdate', 'revoked']);

  it('says protocol 3 is current and caps what a device claims', async () => {
    expect(PROTO_VERSION).toBe(3);
    const rec = (d: SimDevice) => cw.w.daemon.host.listDevices().find((x) => x.id === d.id.id)!;
    expect(rec(cw.phone).proto).toBe(3); expect(rec(old2).proto).toBe(2); expect(rec(old1).proto ?? 1).toBe(1);
  });

  it('gives a protocol 1 or 2 device a state with none of the protocol 3 fields (its strict parser would reject them)', async () => {
    const s = await cw.session('compat-1');
    await cw.fake.askPermission('compat-1');
    await waitFor(() => cw.w.daemon.host.sessions.byKey('compat-1')?.pending);
    for (const d of [old2, old1]) {
      await d.waitFor(() => d.latest);
      if (d === old2) await d.waitFor(() => d.latest?.sessions.find((x) => x.sid === s.sid)); // a protocol 1 page does not get tools it cannot parse at all
      const json = JSON.stringify(d.latest);
      expect(json, d.name).not.toContain('"ctl"');
      expect(json, d.name).not.toContain('"scope"');
      expect(json, d.name).not.toContain('"launch"');
      expect(Object.keys(d.latest!.host).sort(), d.name).toEqual(['confirm', 'devices', 'name', 'paused'].concat(d === old2 && d.latest!.host.away ? ['away'] : []).sort());
      for (const dev of d.latest!.host.devices) expect(Object.keys(dev).sort()).toEqual(['id8', 'lastSeen', 'name']);
    }
    // while the protocol 3 device sees them
    expect(JSON.stringify(cw.phone.latest)).toContain('"ctl"');
  });

  it('sends an old device no protocol 3 kind at all, whatever happens (tail, command results, step-up)', async () => {
    const s = await cw.session('compat-2');
    await cw.phone.send('watch', { sid: s.sid, on: true });
    cw.fake.say('compat-2', 'something to tail');
    const cid = await cw.phone.cmd('prompt', { sid: s.sid, bind: await s.bind(), text: 'hello' });
    await cw.phone.result(cid);
    await cw.phone.cmd('interrupt', { sid: s.sid, bind: await s.bind() });
    await sleep(300);
    expect(cw.phone.kinds).toContain('tail'); expect(cw.phone.kinds).toContain('cresult');
    for (const d of [old2, old1]) for (const k of d.kinds) expect(ALLOWED_OLD.has(k), `${d.name} received ${k}`).toBe(true);
  });

  it('ignores protocol 3 kinds from an old device: audited, nothing delivered, no answer sent', async () => {
    const s = await cw.session('compat-3'); const n = cw.fake.received.prompts.length; const nk = old2.kinds.length;
    await old2.send('prompt', { cid: 'cid-old-0123456789abcd', sid: s.sid, bind: 'a'.repeat(64), text: 'from an old phone', x: Date.now() + 60_000 });
    await old2.send('watch', { sid: s.sid, on: true });
    await old2.send('start', { cid: 'cid-old-1123456789abcd', launchId: 'dragons', mode: 'default', x: Date.now() + 60_000 });
    await sleep(300);
    expect(cw.fake.received.prompts.length).toBe(n);
    expect(cw.fake.received.starts).toHaveLength(0);
    expect(old2.kinds.slice(nk).every((k) => ALLOWED_OLD.has(k))).toBe(true);
    expect(cw.w.daemon.store.auditTail(30).filter((l) => l.includes('control_rejected') && l.includes('"proto"')).length).toBeGreaterThanOrEqual(3);
  });

  it('still lets an old device approve and deny exactly as before (default scope answer)', async () => {
    const s = await cw.session('compat-4');
    await cw.fake.askPermission('compat-4');
    const p = await waitFor(() => cw.w.daemon.host.sessions.byKey('compat-4')?.pending?.pub);
    await old2.waitFor(() => old2.latest?.sessions.find((x) => x.pending?.rid === p.rid));
    await old2.act({ rid: p.rid, sid: s.sid, a: 'approve', bind: p.bind });
    const r = await old2.waitFor(() => old2.results.find((x) => x.rid === p.rid));
    expect(['applied', 'sent']).toContain(r.outcome);
    expect(cw.fake.received.permissions.at(-1)!.answer).toMatchObject({ t: 'permission', behavior: 'allow' });
  });

  it('treats a device record from before 0.3.0 (no scope) as scope answer, and a config with no control section as control OFF', async () => {
    const rec = cw.w.daemon.host.listDevices().find((x) => x.id === old2.id.id)!;
    expect(rec.scope).toBeUndefined();
    const dir = mkdtempSync(join(tmpdir(), 'bwc-old-'));
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ v: 1, name: 'Old laptop', relayUrl: '', allowRelayHosts: ['botwarren.com'], paused: false }));
    const c = new Store(dir).config();
    expect(c.control.mode).toBe('off'); expect(c.control.allowBypass).toBe(false); expect(c.control.launch).toEqual([]); expect(c.control.fullLog).toBe(false);
    expect(c.control.promptsPerHour).toBe(10); expect(c.control.startsPerHour).toBe(5); expect(c.control.unlockMinutes).toBe(15);
    // and a state file from before 0.3.0 loads (no cids)
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ sendReserved: {}, replay: {}, revocations: [], certCtr: 0, rev: 0, lastRotation: 0, awayUntil: 0 }));
    expect(new Store(dir).state().cids).toEqual({});
  });

  it('a device with only observe may read but not approve (the old action path honours the scope too)', async () => {
    const s = await cw.session('compat-5');
    await cw.fake.askPermission('compat-5');
    const p = await waitFor(() => cw.w.daemon.host.sessions.byKey('compat-5')?.pending?.pub);
    await cw.phone.waitFor(() => cw.phone.latest?.sessions.find((x) => x.pending?.rid === p.rid));
    cw.w.daemon.host.setDeviceScope(cw.phone.id.id, 'observe');
    try {
      const n = cw.phone.results.length;
      await cw.phone.act({ rid: p.rid, sid: s.sid, a: 'approve', bind: p.bind });
      expect(await cw.phone.waitFor(() => cw.phone.results[n])).toMatchObject({ outcome: 'rejected' });
      expect(cw.w.daemon.host.sessions.byKey('compat-5')?.pending).toBeTruthy();
    } finally { cw.w.daemon.host.setDeviceScope(cw.phone.id.id, 'control'); }
  });

  it('the relay sees only sealed frames: headers carry the same fields as before (replace keys are labels, never content)', async () => {
    for (const h of cw.phone.headers) {
      expect(Object.keys(h).every((k) => k === 'r' || k === 'n')).toBe(true);
      if (h.r) expect(h.r).toMatch(/^[A-Za-z0-9_-]{1,16}$/);
    }
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { AlertPlanner, inQuiet, parseClock, quietEndsInMs, type AlertConfig, type Episode } from '../src/alerts.ts';
import { AlertPayload, PushRegData } from '../src/protocol/index.ts';
import { encryptForSubscription, sealAlert } from '../src/webpush.ts';
import { ConfigSchema } from '../src/store.ts';
import { RFC8291, decryptPush, fakeSubscription } from './pushkit.ts';
import { startWorld, type World } from './world.ts';
import { b64u } from '../src/protocol/index.ts';

const cfg = (o: Partial<AlertConfig> = {}): AlertConfig => ({ ...ConfigSchema.parse({}).alerts, ...o });
const ep = (rid: string, kind: Episode['kind'] = 'permission'): Episode => ({ rid, kind });
/** a local time on 2026-10-15, whatever the machine's time zone */
const at = (h: number, m = 0, day = 0): number => new Date(2026, 9, 15 + day, h, m).getTime();

describe('when to alert (pure rules)', () => {
  it('waits for the request to settle, then alerts once; the same episode never alerts twice', () => {
    const p = new AlertPlanner(() => cfg({ delaySeconds: 15 }));
    const t = at(12);
    expect(p.plan([ep('aaaa-111111')], t, false)).toEqual({ fire: false, recheckMs: 15_000, why: 'settling' });
    expect(p.plan([ep('aaaa-111111')], t + 14_000, false)).toMatchObject({ fire: false, why: 'settling' });
    expect(p.plan([ep('aaaa-111111')], t + 15_000, false)).toEqual({ fire: true, rid: 'aaaa-111111', count: 1 });
    p.markSent(t + 15_000);
    expect(p.plan([ep('aaaa-111111')], t + 16_000, false)).toMatchObject({ fire: false, why: 'none' });
    expect(p.plan([ep('aaaa-111111')], t + 3_600_000, false)).toMatchObject({ fire: false, why: 'none' });
  });

  it('answered before it settles: nothing is ever sent (quiet after answer), and a held alert is not sent for a request that was answered', () => {
    const p = new AlertPlanner(() => cfg({ delaySeconds: 15 }));
    const t = at(12);
    p.plan([ep('aaaa-111111')], t, false);
    expect(p.plan([], t + 5_000, false)).toMatchObject({ fire: false, why: 'none' });
    expect(p.plan([], t + 60_000, false)).toMatchObject({ fire: false, why: 'none' });
    // held back by a gap, then answered: still nothing
    const q = new AlertPlanner(() => cfg({ delaySeconds: 0, minGapSeconds: 60 }));
    q.plan([ep('aaaa-111111')], t, false); q.markSent(t);
    expect(q.plan([ep('bbbb-222222')], t + 1000, false)).toMatchObject({ fire: false, why: 'gap' });
    expect(q.plan([], t + 30_000, false)).toMatchObject({ fire: false, why: 'none' });
    expect(q.plan([], t + 61_000, false)).toMatchObject({ fire: false, why: 'none' });
  });

  it('coalesces: one alert covers everything waiting; the tap opens the request only if exactly one is waiting', () => {
    const p = new AlertPlanner(() => cfg({ delaySeconds: 0 }));
    const t = at(12);
    expect(p.plan([ep('aaaa-111111'), ep('bbbb-222222', 'question')], t, false)).toEqual({ fire: true, rid: null, count: 2 });
    p.markSent(t);
    // a third that arrives right after is covered by the gap, then alerted on its own once the gap is over
    expect(p.plan([ep('aaaa-111111'), ep('bbbb-222222'), ep('cccc-333333')], t + 1000, false)).toMatchObject({ fire: false, why: 'gap' });
    expect(p.plan([ep('aaaa-111111'), ep('bbbb-222222'), ep('cccc-333333')], t + 61_000, false)).toEqual({ fire: true, rid: null, count: 3 });
  });

  it('keeps a gap between alerts and an hourly cap', () => {
    const p = new AlertPlanner(() => cfg({ delaySeconds: 0, minGapSeconds: 60, maxPerHour: 2 }));
    let t = at(12); const sent: number[] = [];
    for (let i = 0; i < 6; i++) {
      const d = p.plan([ep(`r${i}aa-${i}11111`)], t, false);
      if (d.fire) { p.markSent(t); sent.push(t); }
      t += 61_000;
    }
    expect(sent).toHaveLength(2); // the hourly cap
    const later = p.plan([ep('zzzz-999999')], sent[0]! + 3_600_001, false);
    expect(later).toMatchObject({ fire: true });
  });

  it('sends nothing when paused or switched off, and idle turns only when asked', () => {
    const t = at(12);
    expect(new AlertPlanner(() => cfg({ delaySeconds: 0 })).plan([ep('aaaa-111111')], t, true)).toMatchObject({ fire: false, why: 'off' });
    expect(new AlertPlanner(() => cfg({ delaySeconds: 0, enabled: false })).plan([ep('aaaa-111111')], t, false)).toMatchObject({ fire: false, why: 'off' });
    expect(new AlertPlanner(() => cfg({ delaySeconds: 0 })).plan([ep('aaaa-111111', 'idle')], t, false)).toMatchObject({ fire: false, why: 'none' });
    expect(new AlertPlanner(() => cfg({ delaySeconds: 0, idle: true })).plan([ep('aaaa-111111', 'idle')], t, false)).toMatchObject({ fire: true });
  });

  it('quiet hours hold an alert back and release it only if the request is still waiting when they end', () => {
    const quiet = { on: true, start: '22:00', end: '07:00' };
    const p = new AlertPlanner(() => cfg({ delaySeconds: 0, quiet }));
    const night = p.plan([ep('aaaa-111111')], at(23, 30), false);
    expect(night).toMatchObject({ fire: false, why: 'quiet' });
    expect(inQuiet(quiet, at(23, 30))).toBe(true);
    expect(inQuiet(quiet, at(3))).toBe(true);
    expect(inQuiet(quiet, at(7))).toBe(false);
    expect(inQuiet(quiet, at(12))).toBe(false);
    expect(inQuiet({ on: true, start: '09:00', end: '17:00' }, at(12))).toBe(true);
    expect(inQuiet({ on: true, start: '09:00', end: '09:00' }, at(9))).toBe(false); // an empty window is no window
    expect(inQuiet({ on: false, start: '22:00', end: '07:00' }, at(23))).toBe(false);
    expect(quietEndsInMs(quiet, at(6, 30))).toBeCloseTo(30 * 60_000, -4);
    // answered during the night: no digest in the morning
    expect(p.plan([], at(5, 0, 1), false)).toMatchObject({ fire: false, why: 'none' });
    expect(p.plan([], at(7, 1, 1), false)).toMatchObject({ fire: false, why: 'none' });
    // still waiting in the morning: one alert
    const q = new AlertPlanner(() => cfg({ delaySeconds: 0, quiet }));
    q.plan([ep('aaaa-111111')], at(23, 30), false);
    expect(q.plan([ep('aaaa-111111')], at(7, 1, 1), false)).toMatchObject({ fire: true });
    expect(parseClock('07:00')).toBe(420);
    expect(parseClock('7:00')).toBeNull();
    expect(parseClock('24:00')).toBeNull();
  });
});

describe('what an alert is (RFC 8291, sealed on the computer, content-free)', () => {
  it('reproduces the RFC 8291 Appendix A test vector byte for byte', () => {
    const body = encryptForSubscription({ p256dh: RFC8291.uaPublic, auth: RFC8291.auth }, Buffer.from(RFC8291.plaintext, 'base64url'), { asPrivate: Buffer.from(RFC8291.asPrivate, 'base64url'), salt: Buffer.from(RFC8291.salt, 'base64url') });
    expect(b64u(body)).toBe(RFC8291.body);
    expect(decryptPush(Buffer.from(RFC8291.body, 'base64url'), Buffer.from(RFC8291.uaPrivate, 'base64url'), Buffer.from(RFC8291.uaPublic, 'base64url'), Buffer.from(RFC8291.auth, 'base64url'))).toBe('When I grow up, I want to be a watermelon');
  });

  it('the payload is exactly {v:1,k:"waiting",r?}: nothing else can be put in it, and it is small', () => {
    const f = fakeSubscription();
    const body = sealAlert(f.sub, 'abcd-123456');
    expect(JSON.parse(f.open(body))).toEqual({ v: 1, k: 'waiting', r: 'abcd-123456' });
    expect(JSON.parse(f.open(sealAlert(f.sub)))).toEqual({ v: 1, k: 'waiting' });
    expect(body.length).toBeLessThan(300);
    expect(AlertPayload.safeParse({ v: 1, k: 'waiting', tool: 'Bash' }).success).toBe(false);
    expect(AlertPayload.safeParse({ v: 1, k: 'waiting', r: 'Publish the package' }).success).toBe(false);
    expect(() => sealAlert(f.sub, 'a command: rm -rf /')).toThrow();
    // opened only with this phone's keys
    expect(() => fakeSubscription().open(body)).toThrow();
  });

  it('the registration a phone sends is strict: an https endpoint and the two keys, and a subscription is needed to turn alerts on', () => {
    const f = fakeSubscription();
    expect(PushRegData.safeParse({ on: true, sub: f.sub }).success).toBe(true);
    expect(PushRegData.safeParse({ on: false }).success).toBe(true);
    expect(PushRegData.safeParse({ on: true }).success).toBe(false);
    expect(PushRegData.safeParse({ on: true, sub: { ...f.sub, endpoint: 'http://fcm.googleapis.com/x' } }).success).toBe(false);
    expect(PushRegData.safeParse({ on: true, sub: { ...f.sub, extra: 1 } }).success).toBe(false);
  });
});

describe('alerts through the real relay and daemon', () => {
  let world: World | null = null;
  afterEach(async () => { await world?.close(); world = null; });
  const quick = (over: Partial<AlertConfig> = {}): AlertConfig => ({ ...ConfigSchema.parse({}).alerts, delaySeconds: 0, ...over });
  const until = async (cond: () => boolean, ms = 4000): Promise<void> => { const t = Date.now(); while (!cond()) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 20)); } };
  const settle = (ms = 350): Promise<void> => new Promise((r) => setTimeout(r, ms));

  async function ready(over: Partial<AlertConfig> = {}) {
    world = await startWorld({ push: true });
    world.setConfig({ alerts: quick(over) });
    const phone = await world.pairDevice();
    const f = fakeSubscription();
    await phone.registerAlerts(f.sub);
    await phone.waitFor(() => phone.acks.at(-1)?.on === true);
    const ch = await world.channel('/work/acme-internal-billing');
    return { w: world, phone, f, ch, push: world.push! };
  }

  it('a request that is waiting sends ONE alert, sealed for the phone, with no tool, command, project or session text anywhere', async () => {
    const { phone, f, ch, push, w } = await ready();
    ch.permissionRequest('abcde', 'Bash', 'Publish the secret package acme-internal', 'npm publish --access public --token hunter2');
    await until(() => push.posts.length === 1);
    const p = push.posts[0]!;
    expect(p.url).toBe(f.sub.endpoint);
    expect(p.headers.authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
    expect(p.headers).toMatchObject({ ttl: '600', urgency: 'high', topic: 'bw-waiting', 'content-encoding': 'aes128gcm' });
    expect(p.body.length).toBeLessThan(600);
    const payload = f.open(p.body);
    const rid = (await phone.waitFor(() => phone.latest?.sessions.find((s) => s.pending)?.pending?.rid));
    expect(JSON.parse(payload)).toEqual({ v: 1, k: 'waiting', r: rid });
    // what the relay and the push service could see (the delivery and the ciphertext) holds none of the request
    const seen = JSON.stringify([p.url, p.headers]) + p.body.toString('latin1') + payload;
    for (const secret of ['npm', 'publish', 'acme', 'internal', 'billing', 'hunter2', 'Bash', 'dragon']) expect(seen.toLowerCase()).not.toContain(secret.toLowerCase());
    expect(w.relay.counters.get('push_sent')).toBe(1);
    // the relay's own counters and logs carry no endpoint or body
    expect(JSON.stringify([...w.relay.counters.keys()])).not.toContain('fcm');
  });

  it('coalesces and goes quiet after an answer: no second alert for the same request, none while the gap lasts, and none for a request answered meanwhile', async () => {
    const { phone, ch, push, w } = await ready({ minGapSeconds: 3600 });
    ch.permissionRequest('abcde', 'Bash', 'one', 'one');
    await until(() => push.posts.length === 1);
    ch.permissionRequest('fghij', 'Write', 'two', 'two');
    ch.permissionRequest('klmno', 'Write', 'three', 'three'); // a later request of the same session replaces the pending one
    await settle(500);
    expect(push.posts).toHaveLength(1);
    // the person answers from the phone; nothing further arrives for it
    const rid = (await phone.waitFor(() => phone.latest?.sessions.find((s) => s.pending)?.pending))!;
    const sid = phone.latest!.sessions.find((s) => s.pending)!.sid;
    await phone.act({ rid: rid.rid, sid, a: 'deny', bind: rid.bind });
    await phone.waitFor(() => phone.results.length > 0);
    w.daemon.host.checkAlerts();
    await settle(400);
    expect(push.posts).toHaveLength(1);
  });

  it('does not alert while paused, or with the computer\'s master switch off, and the phone is told why', async () => {
    const { phone, ch, push, w } = await ready();
    w.setConfig({ paused: true });
    ch.permissionRequest('abcde', 'Bash', 'x', 'x');
    await settle(500);
    expect(push.posts).toHaveLength(0);
    w.setConfig({ paused: false });
    w.daemon.host.checkAlerts(); // resumed while it is still waiting: now it is told
    await until(() => push.posts.length === 1);
    w.setConfig({ alerts: quick({ enabled: false }) });
    await phone.send('sync', {});
    await phone.waitFor(() => phone.acks.at(-1)?.why === 'host_off');
  });

  it('respects quiet hours of this computer\'s clock and sends afterwards only if something still waits', async () => {
    const now = new Date(); const hhmm = (d: Date): string => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const around = { on: true, start: hhmm(new Date(now.getTime() - 3_600_000)), end: hhmm(new Date(now.getTime() + 3_600_000)) };
    const { ch, push, w } = await ready({ quiet: around });
    ch.permissionRequest('abcde', 'Bash', 'x', 'x');
    await settle(500);
    expect(push.posts).toHaveLength(0);
    w.setConfig({ alerts: quick({ quiet: { on: false, start: '22:00', end: '07:00' } }) });
    w.daemon.host.checkAlerts();
    await until(() => push.posts.length === 1);
  });

  it('a finished turn alerts only when the owner asked for it', async () => {
    const { push, w } = await ready();
    await w.hook('Stop', { session_id: 's1', cwd: '/work/x', hook_event_name: 'Stop' });
    await settle(500);
    expect(push.posts).toHaveLength(0);
    w.setConfig({ alerts: quick({ idle: true }) });
    await w.hook('Stop', { session_id: 's1', cwd: '/work/x', hook_event_name: 'Stop' });
    await until(() => push.posts.length === 1);
  });

  it('a phone that turns alerts off is forgotten, and one whose subscription the push service says is gone is dropped', async () => {
    const { phone, f, ch, push, w } = await ready();
    push.status = 410;
    ch.permissionRequest('abcde', 'Bash', 'x', 'x');
    await until(() => push.posts.length === 1);
    await until(() => !w.daemon.store.devices()[0]!.push);
    expect(w.relay.counters.get('push_gone')).toBe(1);
    // off from the phone
    push.status = 201;
    let n = phone.acks.length;
    await phone.registerAlerts(f.sub);
    await phone.waitFor(() => phone.acks.length > n && phone.acks.at(-1)?.on === true);
    expect(w.daemon.store.devices()[0]!.push?.endpoint).toBe(f.sub.endpoint);
    n = phone.acks.length;
    await phone.registerAlerts(null);
    await phone.waitFor(() => phone.acks.length > n && phone.acks.at(-1)?.on === false);
    expect(w.daemon.store.devices()[0]!.push).toBeUndefined();
    const before = push.posts.length;
    ch.permissionRequest('fghij', 'Bash', 'y', 'y');
    await settle(500);
    expect(push.posts).toHaveLength(before);
  });

  it('a relay without alerts configured says so and nothing breaks', async () => {
    world = await startWorld();
    world.setConfig({ alerts: quick() });
    const phone = await world.pairDevice();
    await phone.registerAlerts(fakeSubscription().sub);
    await phone.waitFor(() => phone.acks.at(-1)?.on === true);
    const ch = await world.channel();
    ch.permissionRequest('abcde', 'Bash', 'x', 'x');
    await until(() => world!.daemon.store.auditTail(20).some((l) => l.includes('alert_not_delivered')));
    expect(world.relay.counters.get('push_off')).toBe(1);
    expect((await fetch(`${world.base}/v1/push/key`)).status).toBe(404);
  });
});

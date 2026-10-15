import { afterEach, describe, expect, it } from 'vitest';
import { startWorld, type World } from './world.ts';
import { fakeSubscription } from './pushkit.ts';
import type { SimDevice } from './simdevice.ts';

/**
 * 0.1.3: "Send a test alert". The phone asks its computer (inside the encrypted channel, kind `pushtest`); the computer seals a test alert for that phone's own
 * keys, the relay hands it to the push service, and the computer reports each leg back (`pushtestack`: received, pushed, or failed and where). The
 * last leg (the alert arriving on the phone) is the browser's and is covered in e2e/alerts.spec.ts.
 */
describe('send a test alert: phone to computer to relay to push service', () => {
  let w: World | null = null;
  afterEach(async () => { await w?.close(); w = null; });
  const stages = (d: SimDevice, n: string): string[] => d.testAcks.filter((a) => a.n === n).map((a) => (a.why ? `${a.stage}:${a.why}` : a.stage));

  async function ready(opts: { subscribe?: boolean } = {}) {
    w = await startWorld({ push: true });
    const f = fakeSubscription();
    const d = await w.pairDevice('Phone');
    if (opts.subscribe !== false) { await d.registerAlerts(f.sub); await d.waitFor(() => d.acks.at(-1)?.on); }
    return { w, d, f };
  }

  it('round trip: received, then pushed; the push service gets ONE sealed alert whose payload is the test id and nothing else', async () => {
    const { w, d, f } = await ready();
    await d.send('pushtest', { n: 'testid-0001' });
    await d.waitFor(() => stages(d, 'testid-0001').includes('pushed'));
    expect(stages(d, 'testid-0001')).toEqual(['received', 'pushed']);
    expect(w.push!.posts).toHaveLength(1);
    const post = w.push!.posts[0]!;
    expect(JSON.parse(f.open(post.body))).toEqual({ v: 1, k: 'test', n: 'testid-0001' });
    expect(post.url).toBe(f.sub.endpoint);
    expect(post.body.toString('latin1')).not.toContain('testid-0001'); // sealed: the relay and the push service see ciphertext
    expect(w.daemon.store.auditTail(50).join('\n')).toContain('alert_test_sent');
  });

  it('a phone with no alert address is told so', async () => {
    const { d } = await ready({ subscribe: false });
    await d.send('pushtest', { n: 'testid-0002' });
    await d.waitFor(() => stages(d, 'testid-0002').length === 2);
    expect(stages(d, 'testid-0002')).toEqual(['received', 'failed:no_subscription']);
  });

  it('alerts switched off on the computer: failed, alerts_off, nothing is sent', async () => {
    const { w, d } = await ready();
    w.setConfig({ alerts: { ...w.daemon.store.config().alerts, enabled: false } });
    await d.send('pushtest', { n: 'testid-0003' });
    await d.waitFor(() => stages(d, 'testid-0003').length === 2);
    expect(stages(d, 'testid-0003')).toEqual(['received', 'failed:alerts_off']);
    expect(w.push!.posts).toHaveLength(0);
  });

  it('the push service says the address is gone (410): failed, push_gone, and the computer forgets the subscription', async () => {
    const { w, d } = await ready();
    w.push!.status = 410;
    await d.send('pushtest', { n: 'testid-0004' });
    await d.waitFor(() => stages(d, 'testid-0004').includes('failed:push_gone'));
    await d.waitFor(() => w.daemon.store.devices()[0]!.push === undefined);
  });

  it('the push service refuses (500): failed, push_refused', async () => {
    const { w, d } = await ready();
    w.push!.status = 500;
    await d.send('pushtest', { n: 'testid-0005' });
    await d.waitFor(() => stages(d, 'testid-0005').some((s) => s.startsWith('failed')));
    expect(stages(d, 'testid-0005')).toEqual(['received', 'failed:push_refused']);
  });

  it('the relay has alerts switched off: failed, relay_off', async () => {
    const { w, d } = await ready();
    w.relay.pushOff = true;
    await d.send('pushtest', { n: 'testid-0006' });
    await d.waitFor(() => stages(d, 'testid-0006').some((s) => s.startsWith('failed')));
    expect(stages(d, 'testid-0006')).toEqual(['received', 'failed:relay_off']);
  });

  it('limited: one every ten seconds and ten an hour per phone; a malformed request is ignored without an answer', async () => {
    const { w, d } = await ready();
    await d.send('pushtest', { n: 'testid-0007' });
    await d.waitFor(() => stages(d, 'testid-0007').includes('pushed'));
    await d.send('pushtest', { n: 'testid-0008' });
    await d.waitFor(() => stages(d, 'testid-0008').length === 1);
    expect(stages(d, 'testid-0008')).toEqual(['failed:rate_limited']);
    await d.send('pushtest', { n: 'x' });
    await d.send('pushtest', { n: 'testid-0009', extra: 1 });
    await new Promise((r) => setTimeout(r, 300));
    expect(d.testAcks.some((a) => a.n === 'x' || a.n === 'testid-0009')).toBe(false);
    expect(w.push!.posts).toHaveLength(1);
  });

  it('a test alert does not use up the hourly allowance of real alerts', async () => {
    const { w, d } = await ready();
    w.setConfig({ alerts: { ...w.daemon.store.config().alerts, delaySeconds: 0, maxPerHour: 1 } });
    await d.send('pushtest', { n: 'testid-0010' });
    await d.waitFor(() => stages(d, 'testid-0010').includes('pushed'));
    const ch = await w.channel();
    ch.permissionRequest('abcde', 'Bash', 'x', 'x');
    await d.waitFor(() => w.push!.posts.length === 2, 5000); // the real alert was still allowed
  });
});

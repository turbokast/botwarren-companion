import { afterEach, describe, expect, it } from 'vitest';
import { startWorld, type World } from './world.ts';

/**
 * Item 2 of 0.1.2: the owner's relay showed 46 queued frames and 51 overflow drops while the phone was away, because the computer sent a frame for every
 * hook event of every session. The computer now sends only a CHANGED state, at most one non-urgent state every 2 seconds, and every state frame carries the
 * replace key so the relay keeps just the newest one for an absent phone.
 */
describe('coalescing: a phone gets the latest state, never a stream of tool calls', () => {
  let world: World | null = null;
  afterEach(async () => { await world?.close(); world = null; });
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const queued = (w: World): { r?: string }[] => [...(w.relay as unknown as { queues: Map<string, { r?: string }[]> }).queues.values()].flat();

  it('hundreds of tool-call hooks that change nothing visible send nothing after the first state', async () => {
    world = await startWorld();
    const w = world;
    const phone = await w.pairDevice();
    await phone.waitFor(() => phone.states.length >= 1);
    await sleep(300);
    const before = phone.states.length;
    for (let i = 0; i < 200; i++) await w.hook('PostToolUse', { session_id: 's1', cwd: '/work/dragon-game', hook_event_name: 'PostToolUse', tool_name: 'Read' });
    // the session appears once (a change, shown within the 2 s throttle), then 199 identical events send nothing
    await phone.waitFor(() => phone.latest?.sessions.some((s) => s.label === 'dragon-game'), 6000);
    await sleep(500);
    expect(phone.states.length - before).toBeLessThanOrEqual(1);
    expect(phone.latest?.sessions.map((s) => s.label)).toEqual(['dragon-game']);
  }, 60_000);

  it('a phone that is AWAY while the state keeps changing finds one queued state, the newest, when it comes back', async () => {
    world = await startWorld();
    const w = world;
    const phone = await w.pairDevice();
    await phone.waitFor(() => phone.states.length >= 1);
    phone.stop(); // the phone leaves
    await sleep(200);
    const sent = w.relay.counters.get('frames') ?? 0;
    const t0 = Date.now();
    // a busy afternoon: 60 round trips that each change what the phone would show
    for (let i = 0; i < 60; i++) {
      await w.hook('UserPromptSubmit', { session_id: 's1', cwd: '/work/dragon-game', hook_event_name: 'UserPromptSubmit' });
      await w.hook('Stop', { session_id: 's1', cwd: '/work/dragon-game', hook_event_name: 'Stop' });
    }
    await w.hook('UserPromptSubmit', { session_id: 's2', cwd: '/work/other-app', hook_event_name: 'UserPromptSubmit' });
    await sleep(2600); // the throttle's trailing edge
    const framesDuring = (w.relay.counters.get('frames') ?? 0) - sent;
    // at most one state every 2 seconds of the (machine-speed dependent) time the loop took, never one per event (121)
    expect(framesDuring).toBeLessThanOrEqual(Math.ceil((Date.now() - t0) / 2000) + 1);
    expect(framesDuring).toBeLessThan(40);
    expect(queued(w).filter((q) => q.r === 's')).toHaveLength(1); // the replace key: one state is queued, the newest
    expect(queued(w).length).toBeLessThanOrEqual(2); // (and at most one acknowledgement of the alerts setting)
    expect(w.relay.counters.get('queue_overflow') ?? 0).toBe(0);
    // back again: it gets the latest of every session
    phone.connect();
    await phone.waitFor(() => phone.online);
    await phone.waitFor(() => phone.latest?.sessions.some((s) => s.label === 'other-app'));
    expect(phone.latest?.sessions.map((s) => s.label).sort()).toEqual(['dragon-game', 'other-app']);
    expect(phone.latest?.sessions.find((s) => s.label === 'dragon-game')?.pending?.kind).toBe('idle'); // the current pending request is there
    expect(phone.latest?.sessions.find((s) => s.label === 'other-app')?.status).toBe('working');
  }, 60_000);

  it('a state that is identical to the one a device already has is not sent again; forcing it sends it', async () => {
    world = await startWorld();
    const w = world;
    const phone = await w.pairDevice();
    await phone.waitFor(() => phone.states.length >= 1);
    await sleep(300);
    const frames = (): number => w.relay.counters.get('frames') ?? 0;
    const f0 = frames();
    await w.daemon.host.pushState(); await w.daemon.host.pushState(); await w.daemon.host.pushState();
    await sleep(200);
    expect(frames() - f0).toBe(0);
    await w.daemon.host.pushState(undefined, true);
    await phone.waitFor(() => frames() - f0 === 1);
  }, 60_000);

  it('every state frame carries the replace key and results do not (they are answers to one request each)', async () => {
    world = await startWorld();
    const w = world;
    const phone = await w.pairDevice();
    await phone.waitFor(() => phone.states.length >= 1);
    const ch = await w.channel();
    ch.permissionRequest('abcde', 'Bash', 'x', 'x');
    const p = await phone.waitFor(() => phone.latest?.sessions.find((s) => s.pending)?.pending);
    const sid = phone.latest!.sessions.find((s) => s.pending)!.sid;
    await phone.act({ rid: p.rid, sid, a: 'approve', bind: p.bind });
    await phone.waitFor(() => phone.results.length > 0);
    const kinds = phone.kinds;
    expect(kinds.filter((k) => k === 'state').length).toBeGreaterThanOrEqual(2);
    // phone.headers is parallel to phone.kinds
    kinds.forEach((k, i) => { if (k === 'state') expect(phone.headers[i]?.r).toBe('s'); if (k === 'result') expect(phone.headers[i]?.r).toBeUndefined(); });
  }, 60_000);

  it('a pending request is sent at once, not held for the throttle, and a device asking to sync always gets the state', async () => {
    world = await startWorld();
    const w = world;
    const phone = await w.pairDevice();
    await phone.waitFor(() => phone.states.length >= 1);
    await w.hook('UserPromptSubmit', { session_id: 's1', cwd: '/work/x', hook_event_name: 'UserPromptSubmit' }); // just sent a state: the throttle is closed
    const ch = await w.channel();
    const t0 = Date.now();
    ch.permissionRequest('abcde', 'Bash', 'x', 'x');
    await phone.waitFor(() => phone.latest?.sessions.some((s) => s.pending));
    expect(Date.now() - t0).toBeLessThan(1500);
    const n = phone.states.length;
    await phone.send('sync', {}); // unchanged state, but it was asked for
    await phone.waitFor(() => phone.states.length > n);
  }, 60_000);
});

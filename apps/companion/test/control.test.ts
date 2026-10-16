import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { controlWorld, sleep, waitFor, type ControlWorld } from './support/control-world.ts';
import { FakeHarness } from './support/fake-harness/index.ts';
import { SimDevice } from './simdevice.ts';
import { CAP_LONG, type CResultData } from '../src/protocol/index.ts';

/**
 * The host's decision pipeline for protocol 3 commands (docs: docs/PROTOCOL3.md, section 3). One test per refusal path; each shows that
 * NOTHING reached the agent (the fake harness records exactly what it was handed). Without a registered credential the owner confirms every free-text
 * command at the computer (the fallback), and the world's "person" says yes unless a test says no.
 */
describe('remote control commands: refusal matrix and delivery', () => {
  let cw: ControlWorld;
  beforeAll(async () => { cw = await controlWorld(); });
  afterAll(async () => { await cw.close(); });

  const prompt = async (s: { sid: string; bind: () => Promise<string> }, text: string, extra: Record<string, unknown> = {}, o: { phone?: SimDevice; now?: number; cid?: string } = {}): Promise<CResultData> => {
    const d = o.phone ?? cw.phone;
    const cid = await d.cmd('prompt', { sid: s.sid, bind: await s.bind(), text, ...extra }, { ...(o.now ? { now: o.now } : {}), ...(o.cid ? { cid: o.cid } : {}) });
    try { return await d.result(cid); } catch (e) { throw new Error(`no result for ${cid}: cresults=${JSON.stringify(d.cresults.slice(-4))} audit=${cw.w.daemon.store.auditTail(6).join(' | ')} ${String(e)}`); }
  };
  const delivered = (): number => cw.fake.received.prompts.length;

  // ---------------------------------------------------------------- delivery
  it('delivers a prompt once, with provenance, and says applied only after the tool shows its own follow-up', async () => {
    const s = await cw.session('k-happy');
    const before = delivered(); const asked = cw.asked.length;
    const r = await prompt(s, 'Please run the unit tests.');
    expect(r).toMatchObject({ kind: 'prompt', outcome: 'applied' });
    expect(r.why).toBeUndefined();
    expect(cw.fake.received.prompts).toHaveLength(before + 1);
    const got = cw.fake.received.prompts.at(-1)!;
    expect(got.text).toBe('Please run the unit tests.');
    expect(got.framed).toContain('Botwarren Companion');
    expect(got.framed).toContain('Sim phone');
    expect(got.framed.endsWith('Please run the unit tests.')).toBe(true);
    // no credential registered: the owner was asked at the computer, and saw the real text
    expect(cw.asked.slice(asked).map((a) => [a.kind, a.preview])).toEqual([['prompt', 'Please run the unit tests.']]);
    // an interim needs_local was sent first
    expect(cw.phone.cresults.some((x) => x.cid === r.cid && x.outcome === 'needs_local')).toBe(true);
  });

  it('says sent (not applied) when the tool never shows a follow-up', async () => {
    const s = await cw.session('k-sent');
    cw.fake.followupMs = null;
    try { expect(await prompt(s, 'quiet one')).toMatchObject({ outcome: 'sent' }); } finally { cw.fake.followupMs = 10; }
  });

  it('writes an audit line per command with the length and a hash, never the text', async () => {
    const s = await cw.session('k-audit');
    const secretText = 'audit-canary-text-7d1c9e';
    await prompt(s, secretText);
    const log = readFileSync(join(cw.w.daemon.store.dir, 'audit.log'), 'utf8');
    expect(log).not.toContain(secretText);
    const line = log.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.kind === 'control' && l.c === 'prompt' && l.len === secretText.length).at(-1)!;
    expect(line).toMatchObject({ outcome: 'applied', device: cw.phone.id.id.slice(0, 8) });
    expect(String(line.sha)).toMatch(/^[0-9a-f]{16}$/);
    expect(existsSync(join(cw.w.daemon.store.dir, 'control-full.log'))).toBe(false);
  });

  it('keeps an opt-in local-only full log (mode 0600) with the text', async () => {
    const s = await cw.session('k-full');
    cw.setControl({ fullLog: true });
    try { await prompt(s, 'full-log-text-42'); } finally { cw.setControl({ fullLog: false }); }
    const p = join(cw.w.daemon.store.dir, 'control-full.log');
    expect(readFileSync(p, 'utf8')).toContain('full-log-text-42');
    if (process.platform !== 'win32') expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  it('delivers exactly 4000 characters', async () => {
    const s = await cw.session('k-4000');
    expect(await prompt(s, 'x'.repeat(4000))).toMatchObject({ outcome: 'applied' });
  });

  // ---------------------------------------------------------------- refusals
  it('refuses a prompt with a wrong bind as stale, and one the agent has moved on from', async () => {
    const s = await cw.session('k-stale'); const n = delivered();
    expect(await prompt(s, 'hello', { bind: 'f'.repeat(64) })).toMatchObject({ outcome: 'refused', why: 'stale' });
    const shown = await s.bind(); // what the person looked at
    cw.fake.work('k-stale'); // the agent moved: it is now working
    await waitFor(() => cw.w.daemon.host.sessions.byKey('k-stale')?.status === 'working');
    expect(await prompt(s, 'hello', { bind: shown })).toMatchObject({ outcome: 'refused', why: 'stale' });
    expect(delivered()).toBe(n);
  });

  it('refuses a prompt the agent became busy with a permission request for (the bind covers the pending request)', async () => {
    const s = await cw.session('k-stale-perm'); const shown = await s.bind(); const n = delivered();
    await cw.fake.askPermission('k-stale-perm');
    await waitFor(() => cw.w.daemon.host.sessions.byKey('k-stale-perm')?.pending);
    expect(await prompt(s, 'hello', { bind: shown })).toMatchObject({ outcome: 'refused', why: 'stale' });
    expect(delivered()).toBe(n);
  });

  it('refuses a device without scope control (answer, observe)', async () => {
    const s = await cw.session('k-scope'); const n = delivered();
    for (const scope of ['answer', 'observe'] as const) {
      cw.w.daemon.host.setDeviceScope(cw.phone.id.id, scope);
      expect(await prompt(s, 'hello')).toMatchObject({ outcome: 'refused', why: 'scope' });
    }
    cw.w.daemon.host.setDeviceScope(cw.phone.id.id, 'control');
    // observe cannot even stop an agent; answer can
    cw.w.daemon.host.setDeviceScope(cw.phone.id.id, 'observe');
    expect(await result(cw.phone.cmd('interrupt', { sid: s.sid, bind: await s.bind() }))).toMatchObject({ outcome: 'refused', why: 'scope' });
    cw.w.daemon.host.setDeviceScope(cw.phone.id.id, 'control');
    expect(delivered()).toBe(n);
  });
  const result = async (c: Promise<string>, d: SimDevice = cw.phone): Promise<CResultData> => d.result(await c);

  it('refuses more than 4000 characters (size), also when the schema would not carry them', async () => {
    const s = await cw.session('k-size'); const n = delivered();
    expect(await prompt(s, 'x'.repeat(4001))).toMatchObject({ outcome: 'refused', why: 'size' });
    expect(await prompt(s, 'x'.repeat(16_001))).toMatchObject({ outcome: 'refused', why: 'size' });
    // characters, not UTF-16 units: 4000 emoji are 8000 units and are allowed
    expect(await prompt(s, '\u{1F600}'.repeat(4000))).toMatchObject({ outcome: 'applied' });
    expect(delivered()).toBe(n + 1);
  });

  it('refuses text with nothing left after cleaning (empty)', async () => {
    const s = await cw.session('k-empty'); const n = delivered();
    for (const t of ['', '   \n\t ', '\u202e\u0007\u001b[31m\u001b[0m']) expect(await prompt(s, t)).toMatchObject({ outcome: 'refused', why: 'empty' });
    expect(delivered()).toBe(n);
  });

  it('cleans control, escape and bidi characters before delivery', async () => {
    const s = await cw.session('k-clean');
    await prompt(s, 'run \u001b[31mthe\u001b[0m tests\u202e now\u0007');
    expect(cw.fake.received.prompts.at(-1)!.text).toBe('run the tests now');
  });

  it('refuses a leading ! or / on a keystroke route, on any line, and allows them on an API route', async () => {
    const keys = new FakeHarness({ id: 'fake-keys', control: { route: 'keys' } });
    cw.w.daemon.host.hub.register(keys);
    const ks = await cw.session('k-keys', { harness: keys }); const api = await cw.session('k-api');
    for (const t of ['!rm -rf ~', '/clear', '  /compact', '\n!ls', 'hello\n/clear', 'first line\n   !echo hi']) {
      expect(await prompt(ks, t), JSON.stringify(t)).toMatchObject({ outcome: 'refused', why: 'keystroke_prefix' });
    }
    expect(keys.received.prompts).toHaveLength(0);
    expect(await prompt(ks, 'say hi! and also a/b is fine')).toMatchObject({ outcome: 'applied' });
    expect(keys.received.prompts).toHaveLength(1);
    // the same text on an API route is just text for the agent
    expect(await prompt(api, '/clear')).toMatchObject({ outcome: 'applied' });
    expect(await prompt(api, '!ls')).toMatchObject({ outcome: 'applied' });
  });

  it('refuses a bypass session (no approval prompts) unless the owner allows it, but still lets it be stopped', async () => {
    const s = await cw.session('k-bypass', { mode: 'bypass' }); const n = delivered();
    expect(await prompt(s, 'hello')).toMatchObject({ outcome: 'refused', why: 'bypass' });
    expect(delivered()).toBe(n);
    const st = await cw.phone.waitFor(() => cw.phone.latest?.sessions.find((x) => x.sid === s.sid)?.ctl);
    expect(st.can.prompt).toBe(false); expect(st.why).toBe('bypass'); expect(st.can.interrupt).toBe(true);
    expect(await result(cw.phone.cmd('interrupt', { sid: s.sid, bind: await s.bind() }))).toMatchObject({ outcome: expect.stringMatching(/applied|sent/) });
    cw.setControl({ allowBypass: true });
    try { expect(await prompt(s, 'hello')).toMatchObject({ outcome: 'applied' }); } finally { cw.setControl({ allowBypass: false }); }
  });

  it('refuses an expired command and one with an expiry too far ahead', async () => {
    const s = await cw.session('k-expiry'); const n = delivered();
    expect(await prompt(s, 'hello', {}, { now: Date.now() - 100_000 })).toMatchObject({ outcome: 'refused', why: 'expired' });
    expect(await prompt(s, 'hello', { x: Date.now() + 10 * 60_000 })).toMatchObject({ outcome: 'refused', why: 'schema' });
    expect(delivered()).toBe(n);
  });

  it('answers a repeated command id with the stored result and does nothing twice (replay by cid)', async () => {
    const s = await cw.session('k-cid'); const n = delivered();
    const first = await prompt(s, 'once only', {}, { cid: 'cid-replay-0123456789' });
    expect(first.outcome).toBe('applied');
    const bind = await s.bind();
    await cw.phone.cmd('prompt', { sid: s.sid, bind, text: 'once only' }, { cid: 'cid-replay-0123456789' });
    const again = await cw.phone.waitFor(() => cw.phone.cresults.find((r) => r.cid === 'cid-replay-0123456789' && r.dup));
    expect(again).toMatchObject({ outcome: 'applied', dup: true });
    expect(delivered()).toBe(n + 1);
    // even with a different text under the same id: still nothing is done
    await cw.phone.cmd('prompt', { sid: s.sid, bind, text: 'something else' }, { cid: 'cid-replay-0123456789' });
    await sleep(150);
    expect(delivered()).toBe(n + 1);
  });

  it('drops a replayed envelope (same frame twice) before it reaches the pipeline', async () => {
    const s = await cw.session('k-frame'); const n = delivered(); const bind = await s.bind();
    const frame = await cw.phone.send('prompt', { cid: 'cid-frame-0123456789ab', sid: s.sid, bind, text: 'frame replay', x: Date.now() + 60_000 });
    await cw.phone.waitFor(() => cw.phone.cresults.find((r) => r.cid === 'cid-frame-0123456789ab' && r.outcome === 'applied'));
    cw.phone.conn!.sendFrame(frame);
    await sleep(200);
    expect(delivered()).toBe(n + 1);
    expect(cw.w.daemon.store.auditTail(40).some((l) => l.includes('"frame_rejected"') && l.includes('replay'))).toBe(true);
  });

  it('refuses an unknown session, an ended session and a malformed command', async () => {
    const n = delivered();
    expect(await result(cw.phone.cmd('prompt', { sid: 'abcdef123456', bind: 'a'.repeat(64), text: 'hi' }))).toMatchObject({ outcome: 'refused', why: 'unknown_session' });
    const s = await cw.session('k-ended'); cw.fake.end('k-ended');
    await waitFor(() => cw.w.daemon.host.sessions.byKey('k-ended')?.status === 'ended');
    expect(await result(cw.phone.cmd('prompt', { sid: s.sid, bind: 'a'.repeat(64), text: 'hi' }))).toMatchObject({ outcome: 'refused', why: 'ended' });
    expect(await result(cw.phone.cmd('prompt', { sid: s.sid, bind: 'a'.repeat(64), text: 'hi', extra: 1 }))).toMatchObject({ outcome: 'refused', why: 'schema' });
    expect(await result(cw.phone.cmd('prompt', { sid: s.sid, text: 'hi' }))).toMatchObject({ outcome: 'refused', why: 'schema' });
    // no usable command id: no answer is possible, and nothing happens
    await cw.phone.send('prompt', { cid: 'short', sid: s.sid, text: 'hi' });
    await sleep(100);
    expect(delivered()).toBe(n);
  });

  it('refuses a harness or project outside the owner\'s allowlist', async () => {
    const s = await cw.session('k-allow'); const n = delivered();
    cw.setControl({ harnesses: ['claude-code'] });
    try { expect(await prompt(s, 'hello')).toMatchObject({ outcome: 'refused', why: 'harness' }); } finally { cw.setControl({ harnesses: [] }); }
    cw.setControl({ projects: ['/somewhere/else'] });
    try { expect(await prompt(s, 'hello')).toMatchObject({ outcome: 'refused', why: 'project' }); } finally { cw.setControl({ projects: [] }); }
    cw.setControl({ projects: ['/work'] });
    try { expect(await prompt(s, 'hello')).toMatchObject({ outcome: 'applied' }); } finally { cw.setControl({ projects: [] }); }
    expect(delivered()).toBe(n + 1);
  });

  it('refuses a session whose adapter does not declare the capability (honest unsupported)', async () => {
    const weak = new FakeHarness({ id: 'fake-weak', control: { prompt: false, interrupt: false, answer: false, start: false, tail: false, route: 'none' } });
    cw.w.daemon.host.hub.register(weak);
    const s = await cw.session('k-weak', { harness: weak });
    expect(await prompt(s, 'hello')).toMatchObject({ outcome: 'refused', why: 'unsupported' });
    expect(await result(cw.phone.cmd('interrupt', { sid: s.sid, bind: await s.bind() }))).toMatchObject({ outcome: 'refused', why: 'unsupported' });
    const ctl = (await cw.phone.waitFor(() => cw.phone.latest?.sessions.find((x) => x.sid === s.sid)?.ctl))!;
    expect(ctl).toMatchObject({ route: 'none', why: 'unsupported', can: { prompt: false, interrupt: false, tail: false, text: false } });
    expect(weak.received.prompts).toHaveLength(0);
  });

  it('refuses a prompt the agent cannot take right now (busy) without remembering it, so the same command can be retried', async () => {
    const s = await cw.session('k-busy'); const n = delivered();
    cw.fake.nextResult = 'busy';
    const cid = 'cid-busy-retry-0123456789';
    expect(await prompt(s, 'hello', {}, { cid })).toMatchObject({ outcome: 'refused', why: 'busy' });
    const r = await prompt(s, 'hello', {}, { cid });
    expect(r.outcome).toBe('applied'); expect(r.dup).toBeUndefined();
    expect(delivered()).toBe(n + 1);
  });

  it('reports a delivery failure and remembers it (a retry of the same id is not run again)', async () => {
    const s = await cw.session('k-fail'); const n = delivered();
    cw.fake.nextResult = 'failed';
    const cid = 'cid-fail-0123456789abcdef';
    expect(await prompt(s, 'hello', {}, { cid })).toMatchObject({ outcome: 'failed' });
    await cw.phone.cmd('prompt', { sid: s.sid, bind: await s.bind(), text: 'hello' }, { cid });
    await cw.phone.waitFor(() => cw.phone.cresults.find((r) => r.cid === cid && r.dup));
    expect(delivered()).toBe(n);
  });

  it('refuses when the owner says no at the computer (local_declined), and nothing reaches the agent', async () => {
    const s = await cw.session('k-declined'); const n = delivered();
    cw.person.answer = false;
    try { expect(await prompt(s, 'hello')).toMatchObject({ outcome: 'refused', why: 'local_declined' }); } finally { cw.person.answer = true; }
    expect(delivered()).toBe(n);
  });

  it('refuses everything when paused, even a stop', async () => {
    const s = await cw.session('k-paused'); const n = delivered();
    const c = cw.w.daemon.store.config(); c.paused = true; cw.w.daemon.store.saveConfig(c);
    try {
      expect(await prompt(s, 'hello')).toMatchObject({ outcome: 'refused', why: 'paused' });
      expect(await result(cw.phone.cmd('interrupt', { sid: s.sid, bind: await s.bind() }))).toMatchObject({ outcome: 'refused', why: 'paused' });
    } finally { c.paused = false; cw.w.daemon.store.saveConfig(c); }
    expect(delivered()).toBe(n);
    expect(cw.fake.received.interrupts.filter((i) => i.key === 'k-paused')).toHaveLength(0);
  });

  // ---------------------------------------------------------------- the master switch
  it('control off and read-only refuse prompt, start and free-text answer, but a stop (like a deny) still works', async () => {
    const s = await cw.session('k-off'); const n = delivered();
    for (const mode of ['off', 'readonly'] as const) {
      cw.setControl({ mode });
      try {
        expect(await prompt(s, 'hello')).toMatchObject({ outcome: 'refused', why: 'control_off' });
        expect(await result(cw.phone.cmd('start', { launchId: 'dragons', mode: 'default' }))).toMatchObject({ outcome: 'refused', why: 'control_off' });
        const ctl = (await cw.phone.waitFor(() => { const c = cw.phone.latest?.sessions.find((x) => x.sid === s.sid)?.ctl; return c && cw.phone.latest?.host.ctl?.mode === mode ? c : undefined; }))!;
        expect(ctl.can.prompt).toBe(false); expect(ctl.why).toBe('control_off'); expect(ctl.can.interrupt).toBe(true);
        expect(await result(cw.phone.cmd('interrupt', { sid: s.sid, bind: await s.bind() }))).toMatchObject({ outcome: expect.stringMatching(/applied|sent/) });
      } finally { cw.setControl({ mode: 'on' }); }
    }
    expect(delivered()).toBe(n);
    // the old approve/deny path is untouched by the switch
    cw.setControl({ mode: 'off' });
    try {
      const native = await cw.fake.askPermission('k-off');
      const p = await waitFor(() => cw.w.daemon.host.sessions.byKey('k-off')?.pending?.pub);
      await cw.phone.waitFor(() => cw.phone.latest?.sessions.find((x) => x.sid === s.sid)?.pending?.rid === p.rid);
      await cw.phone.act({ rid: p.rid, sid: s.sid, a: 'approve', bind: p.bind });
      const out = await cw.phone.waitFor(() => cw.phone.results.find((x) => x.rid === p.rid));
      expect(['applied', 'sent']).toContain(out.outcome);
      expect(cw.fake.received.permissions.at(-1)!.native).toBe(native.id);
    } finally { cw.setControl({ mode: 'on' }); }
  });

  // ---------------------------------------------------------------- interrupt
  it('stops an agent: delivered once, applied when the tool shows it stopped, and a stale bind does not refuse it', async () => {
    const s = await cw.session('k-int'); cw.fake.work('k-int');
    const shown = await s.bind();
    cw.fake.finishTurn('k-int'); cw.fake.work('k-int'); // moved on since the person looked
    await sleep(60);
    const r = await result(cw.phone.cmd('interrupt', { sid: s.sid, bind: shown }));
    expect(r).toMatchObject({ kind: 'interrupt', outcome: 'applied' });
    expect(cw.fake.received.interrupts.filter((i) => i.key === 'k-int')).toHaveLength(1);
    await waitFor(() => cw.w.daemon.host.sessions.byKey('k-int')?.status === 'idle');
  });

  it('says sent for a stop whose effect the tool does not show', async () => {
    const s = await cw.session('k-int2'); cw.fake.followupMs = null;
    try { expect(await result(cw.phone.cmd('interrupt', { sid: s.sid, bind: await s.bind() }))).toMatchObject({ outcome: 'sent' }); } finally { cw.fake.followupMs = 10; }
  });

  // ---------------------------------------------------------------- answer (free text)
  it('delivers a free-text answer to the pending question, and refuses a stale or missing one', async () => {
    const s = await cw.session('k-ans');
    expect(await result(cw.phone.cmd('answer', { sid: s.sid, rid: 'aaaa-bbbbbb', bind: 'a'.repeat(64), text: 'main' }))).toMatchObject({ outcome: 'refused', why: 'no_question' });
    await cw.fake.askQuestion('k-ans', 'Which branch should I use?');
    const p = await waitFor(() => cw.w.daemon.host.sessions.byKey('k-ans')?.pending?.pub);
    await cw.phone.waitFor(() => cw.phone.latest?.sessions.find((x) => x.sid === s.sid)?.ctl?.can.text);
    expect(await result(cw.phone.cmd('answer', { sid: s.sid, rid: p.rid, bind: 'b'.repeat(64), text: 'main' }))).toMatchObject({ outcome: 'refused', why: 'stale' });
    expect(await result(cw.phone.cmd('answer', { sid: s.sid, rid: 'zzzz-zzzzzz', bind: p.bind, text: 'main' }))).toMatchObject({ outcome: 'refused', why: 'stale' });
    expect(cw.fake.received.answers).toHaveLength(0);
    const r = await result(cw.phone.cmd('answer', { sid: s.sid, rid: p.rid, bind: p.bind, text: 'use main' }));
    expect(r).toMatchObject({ kind: 'answer', outcome: 'applied' });
    expect(cw.fake.received.answers).toEqual([{ native: expect.any(String), text: 'use main', from: 'Sim phone' }]);
  });

  // ---------------------------------------------------------------- start
  it('starts a session from the owner\'s launch table only, and refuses an unknown entry or a mode the entry does not allow', async () => {
    const before = cw.fake.received.starts.length;
    expect(await result(cw.phone.cmd('start', { launchId: 'nope', mode: 'default' }))).toMatchObject({ outcome: 'refused', why: 'launch_unknown' });
    expect(await result(cw.phone.cmd('start', { launchId: 'dragons', mode: 'acceptEdits' }))).toMatchObject({ outcome: 'refused', why: 'mode_not_allowed' });
    expect(await result(cw.phone.cmd('start', { launchId: 'dragons', mode: 'bypassPermissions' }))).toMatchObject({ outcome: 'refused', why: 'schema' });
    expect(await result(cw.phone.cmd('start', { launchId: 'dragons', mode: 'default', path: '/etc', command: 'sh' }))).toMatchObject({ outcome: 'refused', why: 'schema' });
    expect(cw.fake.received.starts).toHaveLength(before);
    const r = await result(cw.phone.cmd('start', { launchId: 'dragons', mode: 'plan', text: 'Fix the dragon bug' }));
    expect(r).toMatchObject({ kind: 'start', outcome: 'applied' });
    expect(r.sid).toMatch(/^[a-z0-9]{6,24}$/);
    expect(cw.fake.received.starts.at(-1)).toMatchObject({ launch: { id: 'dragons', root: '/work/dragon-game', mode: 'plan', harness: 'other' }, first: { text: 'Fix the dragon bug' }, from: 'Sim phone' });
    expect(cw.asked.at(-1)).toMatchObject({ kind: 'start', preview: 'mode: plan\nFix the dragon bug' });
  });

  it('a start with no first prompt is allowed, and the state offers the launch table without any path', async () => {
    expect(await result(cw.phone.cmd('start', { launchId: 'dragons', mode: 'default' }))).toMatchObject({ outcome: expect.stringMatching(/applied|sent/) });
    const st = cw.phone.latest!;
    expect(st.host.ctl).toMatchObject({ mode: 'on', scope: 'control', stepup: 'local', launch: [{ id: 'dragons', label: 'Dragon game', harness: 'other', modes: ['default', 'plan'] }] });
    expect(JSON.stringify(st)).not.toContain('/work/dragon-game/');
    expect(JSON.stringify(st.host.ctl)).not.toContain('/work');
  });

  it('refuses a start for a harness that cannot start sessions', async () => {
    const weak = new FakeHarness({ id: 'fake-nostart', kind: 'opencode', control: { start: false } });
    cw.w.daemon.host.hub.register(weak);
    cw.setControl({ launch: [{ id: 'oc', label: 'OpenCode', harness: 'opencode', root: '/work/x', modes: ['default'] }] });
    try { expect(await result(cw.phone.cmd('start', { launchId: 'oc', mode: 'default' }))).toMatchObject({ outcome: 'refused', why: 'unsupported' }); } finally { cw.setControl({ launch: [{ id: 'dragons', label: 'Dragon game', harness: 'other', root: '/work/dragon-game', modes: ['default', 'plan'] }] }); }
  });
});

describe('remote control: rate buckets', () => {
  it('refuses the 4th prompt in an hour with rate, without delivering it, and the overall action bucket applies too', async () => {
    const cw = await controlWorld({ control: { promptsPerHour: 3 } });
    try {
      const s = await cw.session('k-rate');
      const send = async (t: string): Promise<CResultData> => cw.phone.result(await cw.phone.cmd('prompt', { sid: s.sid, bind: await s.bind(), text: t }));
      for (let i = 0; i < 3; i++) expect((await send(`p${i}`)).outcome).toBe('applied');
      expect(await send('p3')).toMatchObject({ outcome: 'refused', why: 'rate' });
      expect(cw.fake.received.prompts).toHaveLength(3);
      // a refusal does not spend the bucket and a stop has its own, so the person can still stop it
      expect(await cw.phone.result(await cw.phone.cmd('interrupt', { sid: s.sid, bind: await s.bind() }))).toMatchObject({ outcome: expect.stringMatching(/applied|sent/) });
    } finally { await cw.close(); }
  });

  it('shares the overall action bucket with approve/deny, and limits starts per hour', async () => {
    const cw = await controlWorld({ control: { startsPerHour: 1 } });
    try {
      const a = await cw.phone.result(await cw.phone.cmd('start', { launchId: 'dragons', mode: 'default' }));
      expect(a.outcome).toMatch(/applied|sent/);
      expect(await cw.phone.result(await cw.phone.cmd('start', { launchId: 'dragons', mode: 'default' }))).toMatchObject({ outcome: 'refused', why: 'rate' });
      expect(cw.fake.received.starts).toHaveLength(1);
    } finally { await cw.close(); }
    const cw2 = await controlWorld();
    try {
      const c = cw2.w.daemon.store.config(); c.maxActionsPerMinute = 1; cw2.w.daemon.store.saveConfig(c);
      const s = await cw2.session('k-overall');
      const send = async (t: string): Promise<CResultData> => cw2.phone.result(await cw2.phone.cmd('prompt', { sid: s.sid, bind: await s.bind(), text: t }));
      expect((await send('one')).outcome).toBe('applied');
      expect(await send('two')).toMatchObject({ outcome: 'refused', why: 'rate' });
    } finally { await cw2.close(); }
  });
});

describe('remote control: a second device', () => {
  it('has its own command ids and scope; a revoked device is refused at the envelope', async () => {
    const cw = await controlWorld();
    try {
      const s = await cw.session('k-two');
      const other = await cw.w.pairDevice('Second', { caps: [CAP_LONG], proto: 3 });
      await other.waitFor(() => other.latest);
      // default scope for a newly paired device is `answer`: it cannot send free text
      const cid = await other.cmd('prompt', { sid: s.sid, bind: await s.bind(), text: 'from the second device' });
      expect(await other.result(cid)).toMatchObject({ outcome: 'refused', why: 'scope' });
      // the same command id from the first device is a different command (ids are per device)
      const r = await cw.phone.result(await cw.phone.cmd('prompt', { sid: s.sid, bind: await s.bind(), text: 'first' }, { cid }));
      expect(r.dup).toBeUndefined(); expect(r.outcome).toBe('applied');
      const ctl = (await other.waitFor(() => other.latest?.host.ctl))!;
      expect(ctl.scope).toBe('answer');
      expect(ctl.launch).toEqual([]); // the launch table is for scope control only
      await cw.w.daemon.host.revokeDevice(other.id.id);
      const n = cw.fake.received.prompts.length;
      await other.cmd('prompt', { sid: s.sid, bind: await s.bind(), text: 'after revoke' }).catch(() => undefined);
      await sleep(200);
      expect(cw.fake.received.prompts).toHaveLength(n);
    } finally { await cw.close(); }
  });
});

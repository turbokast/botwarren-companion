/**
 * The host's side of the adapter contract, with a fake adapter: what is delivered, what is refused, how outcomes are told, how an older phone is served.
 * Every real adapter runs the same facts through its own tool (see the per-adapter tests).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { startWorld, type World } from './world.ts';
import type { SimDevice } from './simdevice.ts';
import { FakeAdapter } from './fake-adapter.ts';
import type { Pending } from '../src/protocol/index.ts';
import { needsLocalConfirmation } from '../src/policy.ts';
import { ConfigSchema } from '../src/store.ts';
import { versionVerified, stricter } from '../src/adapters/types.ts';

let w: World | null = null;
afterEach(async () => { await w?.close(); w = null; });

/** the state and result schemas of companion 0.1.x, verbatim in the parts that matter: strict, closed agent list, no proto 2 fields. A proto 1 phone parses with these. */
const Old = {
  pending: z.object({ rid: z.string(), kind: z.enum(['permission', 'question', 'idle']), tool: z.string().optional(), summary: z.string(), preview: z.string(), options: z.array(z.object({ id: z.string(), label: z.string() }).strict()).optional(), expires: z.number(), bind: z.string(), can: z.object({ approve: z.boolean(), reply: z.boolean() }).strict() }).strict(),
  get state() {
    return z.object({
      rev: z.number(),
      host: z.object({ name: z.string(), paused: z.boolean(), confirm: z.object({ approve: z.string(), reply: z.string() }).strict(), devices: z.array(z.object({ id8: z.string(), name: z.string(), lastSeen: z.number().nullable() }).strict()) }).strict(),
      presets: z.array(z.object({ id: z.string(), label: z.string() }).strict()),
      sessions: z.array(z.object({ sid: z.string(), agent: z.enum(['claude-code', 'codex', 'ninox']), label: z.string(), status: z.string(), since: z.number(), pending: this.pending.optional(), recent: z.array(z.object({ role: z.string(), text: z.string(), ts: z.number() }).strict()) }).strict()),
    }).strict();
  },
  outcome: z.enum(['applied', 'denied', 'expired', 'stale', 'rejected', 'needs_local', 'paused', 'rate_limited', 'failed']),
};

const pendingOf = (d: SimDevice, sid?: string): (Pending & { sid: string }) | undefined => {
  const s = d.latest?.sessions.find((x) => x.pending && (!sid || x.sid === sid));
  return s?.pending ? { ...s.pending, sid: s.sid } : undefined;
};
const act = (d: SimDevice, p: Pending & { sid: string }, a: 'approve' | 'deny' | 'reply', o: { opt?: string } = {}) =>
  d.act({ rid: p.rid, sid: p.sid, a, bind: p.bind, ...(o.opt ? { opt: o.opt } : {}) });
const lastResult = (d: SimDevice, n = 1) => d.waitFor(() => (d.results.length >= n ? d.results[n - 1] : undefined));

async function setup(o: { resolveWaitMs?: number; adapter?: ConstructorParameters<typeof FakeAdapter>[0] } = {}): Promise<{ w: World; d: SimDevice; fake: FakeAdapter }> {
  w = await startWorld({ resolveWaitMs: o.resolveWaitMs ?? 300 });
  const fake = new FakeAdapter(o.adapter);
  w.daemon.host.hub.register(fake);
  const d = await w.pairDevice();
  fake.session();
  return { w, d, fake };
}

describe('protocol 2 is sent only to a phone that said it understands it', () => {
  it('a proto 1 phone gets a state that parses with the 0.1.x schema (no new kinds, no new fields); a proto 2 phone gets all of it', async () => {
    w = await startWorld();
    const fake = new FakeAdapter({ kind: 'muse' });
    w.daemon.host.hub.register(fake);
    const oldPhone = await w.pairDevice('old', { proto: 1 });
    const newPhone = await w.pairDevice('new', { proto: 2 });
    fake.session('m-1', { mode: 'bypass' });
    await fake.pending({ sessionKey: 'm-1', risk: ['network'], can: { approve: false, reply: false } });
    // a claude session so the old phone has something it can show
    await w.hook('SessionStart', { session_id: 'c-1', cwd: '/work/claude-proj' });
    await newPhone.waitFor(() => newPhone.latest?.sessions.some((s) => s.agent === 'muse') && newPhone.latest?.sessions.some((s) => s.agent === 'claude-code'));
    await oldPhone.waitFor(() => oldPhone.latest?.sessions.some((s) => s.agent === 'claude-code'));
    for (const st of oldPhone.states) { expect(() => Old.state.parse(st)).not.toThrow(); }
    expect(oldPhone.latest?.sessions.some((s) => s.agent === 'muse')).toBe(false);
    const muse = newPhone.latest!.sessions.find((s) => s.agent === 'muse')!;
    expect(muse.mode).toBe('bypass');
    expect(muse.pending).toMatchObject({ risk: ['network'], source: 'structured', can: { approve: false, reply: false } });
  });

  it('the host does not send away to an old phone, and tells a new one', async () => {
    w = await startWorld();
    const oldPhone = await w.pairDevice('old', { proto: 1 });
    const newPhone = await w.pairDevice('new', { proto: 2 });
    w.daemon.host.setAway(Date.now() + 3_600_000);
    await newPhone.waitFor(() => newPhone.latest?.host.away === true);
    await oldPhone.waitFor(() => oldPhone.states.length > 0);
    await new Promise((r) => setTimeout(r, 300));
    for (const st of oldPhone.states) expect(() => Old.state.parse(st)).not.toThrow();
    w.daemon.host.setAway(0);
    await newPhone.waitFor(() => newPhone.latest?.host.away === undefined);
  });
});

describe('what the host delivers, and how it tells the outcome', () => {
  it('approve delivers exactly an allow-once and nothing else: no scope, no message, no extra field, whatever the phone adds', async () => {
    const s = await setup();
    await s.fake.pending({ tool: 'Bash', preview: 'npm test' });
    const p = await s.d.waitFor(() => pendingOf(s.d));
    await s.d.act({ rid: p.rid, sid: p.sid, a: 'approve', bind: p.bind, opt: 'always' });
    const native = s.fake.delivered;
    await s.d.waitFor(() => s.d.results[0]);
    expect(native).toHaveLength(1);
    expect(native[0]!.a).toEqual({ t: 'permission', behavior: 'allow' });
    expect(Object.keys(native[0]!.a).sort()).toEqual(['behavior', 't']);
  });

  it('an allow is "sent" until the tool confirms, "applied" when it does; a deny is "denied" at once', async () => {
    const s = await setup({ resolveWaitMs: 400 });
    await s.fake.pending();
    let p = await s.d.waitFor(() => pendingOf(s.d));
    await act(s.d, p, 'approve');
    expect((await lastResult(s.d, 1)).outcome).toBe('sent');

    await s.fake.pending({ preview: 'ls /tmp' });
    p = await s.d.waitFor(() => { const x = pendingOf(s.d); return x && x.preview === 'ls /tmp' ? x : undefined; });
    s.fake.resolveAfterMs = 30; // the tool's follow-up arrives within the wait
    await act(s.d, p, 'approve');
    expect((await lastResult(s.d, 2)).outcome).toBe('applied');

    await s.fake.pending({ preview: 'ls /var' });
    p = await s.d.waitFor(() => { const x = pendingOf(s.d); return x && x.preview === 'ls /var' ? x : undefined; });
    await act(s.d, p, 'deny');
    expect((await lastResult(s.d, 3)).outcome).toBe('denied');
    expect(s.fake.delivered.map((x) => x.a)).toEqual([{ t: 'permission', behavior: 'allow' }, { t: 'permission', behavior: 'allow' }, { t: 'permission', behavior: 'deny' }]);
  });

  it('a phone that only knows protocol 1 is told "applied" with a note instead of the unknown "sent"', async () => {
    w = await startWorld({ resolveWaitMs: 150 });
    const fake = new FakeAdapter();
    w.daemon.host.hub.register(fake);
    const d = await w.pairDevice('old', { proto: 1 });
    fake.session('x-1', { agent: 'codex' });
    await fake.pending({ sessionKey: 'x-1' });
    const p = await d.waitFor(() => pendingOf(d));
    await act(d, p, 'approve');
    const r = await lastResult(d);
    expect(() => Old.outcome.parse(r.outcome)).not.toThrow();
    expect(r.outcome).toBe('applied');
    expect(r.note).toMatch(/not seen/);
  });

  it('"Deny and say": only a non-affirming preset, delivered as the host\'s own text; yes-type presets and any other reply are refused', async () => {
    const s = await setup();
    await s.fake.pending({ denyWithPreset: true });
    const p = await s.d.waitFor(() => pendingOf(s.d));
    expect(p.denyWith).toBeDefined();
    expect(p.denyWith).toContain('no');
    expect(p.denyWith).not.toContain('yes');
    expect(p.denyWith).not.toContain('continue');
    await act(s.d, p, 'reply', { opt: 'yes' });
    expect((await lastResult(s.d, 1)).outcome).toBe('rejected');
    await act(s.d, p, 'reply', { opt: 'made-up' });
    expect((await lastResult(s.d, 2)).outcome).toBe('rejected');
    await act(s.d, p, 'reply', { opt: 'no' });
    expect((await lastResult(s.d, 3)).outcome).toBe('denied');
    expect(s.fake.delivered).toHaveLength(1);
    expect(s.fake.delivered[0]!.a).toEqual({ t: 'permission', behavior: 'deny', message: 'No, do not do that.' });
  });

  it('a reply on a permission request that did not offer "deny and say" is refused', async () => {
    const s = await setup();
    await s.fake.pending({});
    const p = await s.d.waitFor(() => pendingOf(s.d));
    expect(p.denyWith).toBeUndefined();
    await act(s.d, p, 'reply', { opt: 'no' });
    expect((await lastResult(s.d)).outcome).toBe('rejected');
    expect(s.fake.delivered).toHaveLength(0);
  });
});

describe('a request that can only be denied (the tool ignores an approval from outside)', () => {
  it('approve is refused, deny and "deny and say" are delivered, and a protocol 1 phone sees a card it can parse', async () => {
    const s = await setup();
    const old = await s.w.pairDevice('old', { proto: 1 });
    await s.fake.pending({ can: { approve: false, reply: false, deny: true }, denyWithPreset: true });
    const p = await s.d.waitFor(() => pendingOf(s.d));
    expect(p.can).toEqual({ approve: false, reply: false, deny: true });
    expect(p.denyWith).toBeDefined();
    const op = await old.waitFor(() => old.latest?.sessions.find((x) => x.pending)?.pending);
    expect(() => Old.pending.parse(op)).not.toThrow();
    expect(op.can).toEqual({ approve: false, reply: false });
    await act(s.d, p, 'approve');
    expect((await lastResult(s.d, 1)).outcome).toBe('rejected');
    await act(s.d, p, 'reply', { opt: 'no' });
    expect((await lastResult(s.d, 2)).outcome).toBe('denied');
    expect(s.fake.delivered.map((x) => x.a)).toEqual([{ t: 'permission', behavior: 'deny', message: 'No, do not do that.' }]);
  });
});

describe('what the host refuses', () => {
  it('text read from a screen, a bypassed session and a read-only request can never be approved or replied to', async () => {
    const s = await setup();
    s.fake.session('scr-1');
    await s.fake.pending({ sessionKey: 'scr-1', source: 'screen', can: { approve: true, reply: true } });
    s.fake.session('byp-1', { mode: 'bypass' });
    await s.fake.pending({ sessionKey: 'byp-1', can: { approve: true, reply: true } });
    s.fake.session('ro-1');
    await s.fake.pending({ sessionKey: 'ro-1', native: null, can: { approve: true, reply: true } });
    const state = await s.d.waitFor(() => (s.d.latest?.sessions.filter((x) => x.pending).length === 3 ? s.d.latest : undefined));
    const withPending = state.sessions.filter((x) => x.pending);
    for (const sess of withPending) expect(sess.pending!.can).toEqual({ approve: false, reply: false });
    let n = 0;
    for (const sess of withPending) { await s.d.act({ rid: sess.pending!.rid, sid: sess.sid, a: 'approve', bind: sess.pending!.bind }); n++; await lastResult(s.d, n); }
    expect(s.d.results.every((r) => r.outcome === 'rejected')).toBe(true);
    expect(s.fake.delivered).toHaveLength(0);
  });

  it('refuses (stale) when the native request has changed or is gone, and delivers nothing', async () => {
    const s = await setup();
    await s.fake.pending({});
    let p = await s.d.waitFor(() => pendingOf(s.d));
    s.fake.state = 'changed';
    await act(s.d, p, 'approve');
    expect((await lastResult(s.d, 1)).outcome).toBe('stale');
    s.fake.state = 'gone';
    await act(s.d, p, 'deny');
    expect((await lastResult(s.d, 2)).outcome).toBe('stale');
    s.fake.state = 'live';
    s.fake.deliverResult = 'gone';
    await act(s.d, p, 'approve');
    expect((await lastResult(s.d, 3)).outcome).toBe('stale');
    expect(s.fake.delivered).toHaveLength(0);
    void p;
  });

  it('after the request is cleared (answered on the computer), a late phone answer is stale and nothing is delivered', async () => {
    const s = await setup();
    await s.fake.pending({});
    const p = await s.d.waitFor(() => pendingOf(s.d));
    s.fake.ctx.report.cleared('fake-1', 'answered_local');
    await act(s.d, p, 'approve');
    expect((await lastResult(s.d)).outcome).toBe('stale');
    expect(s.fake.delivered).toHaveLength(0);
    expect(s.fake.released).toHaveLength(1); // the adapter was told to let go
  });

  it('a bind that does not match what was shown is stale; an unsupported delivery is "rejected"; a failed one "failed"', async () => {
    const s = await setup();
    await s.fake.pending({});
    const p = await s.d.waitFor(() => pendingOf(s.d));
    await s.d.act({ rid: p.rid, sid: p.sid, a: 'approve', bind: 'e'.repeat(64) });
    expect((await lastResult(s.d, 1)).outcome).toBe('stale');
    s.fake.deliverResult = 'unsupported';
    await act(s.d, p, 'approve');
    expect((await lastResult(s.d, 2)).outcome).toBe('rejected');
    s.fake.deliverResult = 'failed';
    await act(s.d, p, 'approve');
    expect((await lastResult(s.d, 3)).outcome).toBe('failed');
  });
});

describe('local confirmation floors and risk tags', () => {
  it('an adapter floor of "risky" confirms a tagged request on the computer and lets an untagged one through; the user can only tighten it', async () => {
    const s = await setup({ adapter: { floor: { approve: 'risky', reply: 'off' } } });
    await s.fake.pending({ preview: 'ls', risk: [] });
    let p = await s.d.waitFor(() => pendingOf(s.d));
    await act(s.d, p, 'approve');
    expect((await lastResult(s.d, 1)).outcome).toBe('sent'); // no risk: no confirmation needed (and no follow-up in this test)

    const seen: string[] = [];
    const stop = s.w.daemon.hub.watch((cid, req) => { seen.push(`${req.kind}:${req.tool}`); s.w.daemon.hub.decide(cid, false); });
    await s.fake.pending({ preview: 'cat ~/.ssh/config', risk: ['protected_write'] });
    p = await s.d.waitFor(() => { const x = pendingOf(s.d); return x && x.preview.includes('ssh') ? x : undefined; });
    await act(s.d, p, 'approve');
    await s.d.waitFor(() => s.d.results.find((r) => r.outcome === 'needs_local'));
    await s.d.waitFor(() => s.d.results.find((r) => r.outcome === 'denied'));
    stop();
    expect(seen).toEqual(['approve:Bash']);
    // the host denied it (not confirmed): the adapter got exactly one deny and no allow for that request
    expect(s.fake.delivered.filter((x) => x.a.t === 'permission' && x.a.behavior === 'allow')).toHaveLength(1);
    expect(s.fake.delivered.at(-1)!.a).toEqual({ t: 'permission', behavior: 'deny' });
  });

  it('policy: floors only tighten, deny is never confirmed, risk tags count only under "risky"', () => {
    const cfg = ConfigSchema.parse({});
    const base = { kind: 'approve' as const, tool: 'Bash' };
    expect(needsLocalConfirmation(cfg, base)).toBe(false);
    expect(needsLocalConfirmation(cfg, { ...base, floor: 'risky' })).toBe(false);
    expect(needsLocalConfirmation(cfg, { ...base, floor: 'risky', risk: ['network'] })).toBe(true);
    expect(needsLocalConfirmation(cfg, { ...base, floor: 'always' })).toBe(true);
    expect(needsLocalConfirmation({ ...cfg, confirm: { approve: 'always', reply: 'off' } }, { ...base, floor: 'off' })).toBe(true);
    expect(needsLocalConfirmation(cfg, { kind: 'deny', floor: 'always', risk: ['network'] })).toBe(false);
    expect(stricter('risky', 'off')).toBe('risky');
    expect(stricter('off', 'always')).toBe('always');
  });

  it('version gating: only listed versions (or a family) match; unknown matches nothing', () => {
    expect(versionVerified('0.162.1', ['0.162.1'])).toBe(true);
    expect(versionVerified('0.162.2', ['0.162.1'])).toBe(false);
    expect(versionVerified('0.162.9', ['0.162.*'])).toBe(true);
    expect(versionVerified('0.1620.1', ['0.162.*'])).toBe(false);
    expect(versionVerified(null, ['0.162.*'])).toBe(false);
    expect(versionVerified('1.0.0', [])).toBe(false);
  });
});

describe('privacy', () => {
  it('secrets in an adapter\'s text are masked before sealing, and the audit log never holds content', async () => {
    const s = await setup();
    await s.fake.pending({ summary: 'Use token ghp_' + 'a'.repeat(36), preview: 'curl -H "Authorization: Bearer ' + 'x1'.repeat(20) + '" https://example.com' });
    const p = await s.d.waitFor(() => pendingOf(s.d));
    expect(p.summary).not.toContain('ghp_');
    expect(p.preview).not.toContain('x1x1x1x1');
    await act(s.d, p, 'approve');
    await lastResult(s.d);
    expect(s.w.daemon.store.auditTail(300).join('\n')).not.toMatch(/ghp_|curl|Bearer|npm|ls -la/);
  });
});

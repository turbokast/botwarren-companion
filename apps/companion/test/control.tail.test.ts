import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { controlWorld, sleep, waitFor, type ControlWorld } from './support/control-world.ts';
import { HOSTILE, FORBIDDEN_IN_TAIL } from './support/hostile-fixtures.ts';
import { TailBuffer, TAIL_MAX_BYTES, TAIL_MAX_ENTRIES, maskPaths, sanitizeTail } from '../src/tail.ts';
import { TailData, HistData, TailEntry, watchReplaceKey } from '../src/protocol/index.ts';

const opts = { secrets: ['s3cr3t-env-value-xyz'], roots: [{ path: '/home/owner', as: '~' }, { path: '/home/owner/work/app', as: '.' }] };

describe('tail text: cleaned, masked, cut', () => {
  it('removes terminal escapes, control and bidi characters', () => {
    const r = sanitizeTail('assistant', '\u001b[31mred\u001b[0m \u001b]0;title\u0007ok \u202eevil\u202d\u0000\u0007', opts)!;
    expect(r.text).toBe('red ok evil');
    expect(FORBIDDEN_IN_TAIL.test(r.text)).toBe(false);
  });
  it('masks secret shapes and literal secrets, and the home folder and project folder', () => {
    const r = sanitizeTail('tool', 'cat /home/owner/work/app/src/a.ts /home/owner/.ssh/config ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8' + ' s3cr3t-env-value-xyz', opts)!;
    expect(r.text).toBe('cat ./src/a.ts ~/.ssh/config [token] [masked]');
    expect(r.masked).toBeGreaterThanOrEqual(2);
  });
  it('cuts a line to its limit at the end and counts what went; nothing is silent', () => {
    const a = sanitizeTail('assistant', 'x'.repeat(5000), opts)!;
    expect(Array.from(a.text)).toHaveLength(4000); expect(a.cut).toBe(1000);
    const t = sanitizeTail('tool', 'y'.repeat(400), opts)!;
    expect(Array.from(t.text)).toHaveLength(300); expect(t.cut).toBe(100);
    const huge = sanitizeTail('assistant', 'z'.repeat(2_000_000), opts)!;
    expect(Array.from(huge.text)).toHaveLength(4000); expect(huge.cut).toBeGreaterThan(1_900_000);
  });
  it('returns nothing for a text with nothing left, and does not stall on a huge hostile input', () => {
    expect(sanitizeTail('assistant', '\u001b[2J\u0007  \n ', opts)).toBeNull();
    const t0 = Date.now();
    for (const h of HOSTILE) sanitizeTail('assistant', h.text, opts);
    expect(Date.now() - t0).toBeLessThan(3000);
  });
  it('maskPaths replaces the longest root first and ignores a root of "/"', () => {
    expect(maskPaths('/home/owner/work/app/x /home/owner/y', opts.roots)).toBe('./x ~/y');
    expect(maskPaths('/etc/passwd', [{ path: '/', as: '~' }])).toBe('/etc/passwd');
  });
});

describe('tail buffer: bounded', () => {
  it('keeps at most 300 lines and 256 KB, newest last, with stable sequence numbers', () => {
    const b = new TailBuffer();
    for (let i = 0; i < 1000; i++) b.add('assistant', `line ${i}`, i);
    expect(b.size).toBe(TAIL_MAX_ENTRIES); expect(b.last).toBe(1000); expect(b.first).toBe(701);
    const big = new TailBuffer();
    for (let i = 0; i < 200; i++) big.add('assistant', 'q'.repeat(4000), i);
    expect(big.size * 4000).toBeLessThanOrEqual(TAIL_MAX_BYTES); expect(big.size).toBeLessThan(200);
  });
  it('window() fits a byte budget, page() walks back and says when there is more', () => {
    const b = new TailBuffer();
    for (let i = 0; i < 100; i++) b.add('assistant', 'w'.repeat(200), i);
    const w = b.window(2000);
    expect(JSON.stringify(w).length).toBeLessThanOrEqual(2100); expect(w.at(-1)!.seq).toBe(100);
    let before: number | undefined; let seen = 0; let more = true;
    while (more) { const p = b.page(before, 20, 100_000); seen += p.entries.length; more = p.more; before = p.entries[0]?.seq; if (!p.entries.length) break; }
    expect(seen).toBe(100);
  });
  it('purge() removes one kind', () => {
    const b = new TailBuffer(); b.add('tool', 'a', 1); b.add('tool_out', 'b', 2); b.add('assistant', 'c', 3);
    expect(b.purge('tool_out')).toBe(1); expect(b.window(10_000).map((e) => e.k)).toEqual(['tool', 'assistant']);
  });
});

describe('live tail through the host and the relay', () => {
  let cw: ControlWorld;
  beforeAll(async () => { cw = await controlWorld({ world: { tailGapMs: 150 } }); });
  afterAll(async () => { await cw.close(); });

  const tails = (sid: string) => cw.phone.tails.filter((t) => t.sid === sid);
  const watch = async (sid: string, on = true): Promise<void> => { await cw.phone.send('watch', { sid, on }); };

  it('sends the current window at once, then coalesced windows: at most one frame a gap per session, newest wins (replace key)', async () => {
    const s = await cw.session('t-coalesce');
    cw.fake.say('t-coalesce', 'first words');
    await watch(s.sid);
    const first = await cw.phone.waitFor(() => tails(s.sid)[0]);
    expect(TailData.safeParse(first).success).toBe(true);
    expect(first.entries.map((e) => e.text)).toEqual(['first words']);
    const before = tails(s.sid).length;
    for (let i = 0; i < 100; i++) cw.fake.say('t-coalesce', `burst ${i}`);
    await cw.phone.waitFor(() => tails(s.sid).at(-1)?.last === 101);
    expect(tails(s.sid).length - before).toBeLessThanOrEqual(3); // 100 lines, a few frames
    expect(tails(s.sid).at(-1)!.entries.at(-1)!.text).toBe('burst 99');
    // the frames carry the per-session replace key, so the relay holds only the newest one for an absent phone
    expect(cw.phone.headers.some((h) => h.r === watchReplaceKey(s.sid))).toBe(true);
  });

  it('stops pushing after unwatch, and only watched sessions are pushed', async () => {
    const s = await cw.session('t-unwatch'); const other = await cw.session('t-other');
    await watch(s.sid); await cw.phone.waitFor(() => tails(s.sid)[0]);
    cw.fake.say('t-other', 'nobody watches me'); await sleep(250);
    expect(tails(other.sid)).toHaveLength(0);
    await watch(s.sid, false); await sleep(200);
    const n = tails(s.sid).length;
    cw.fake.say('t-unwatch', 'after unwatch'); await sleep(300);
    expect(tails(s.sid).length).toBe(n);
  });

  it('keeps a window that fits one frame and lets history fetch earlier lines, bounded to what the host holds', async () => {
    const s = await cw.session('t-history');
    for (let i = 0; i < 400; i++) cw.fake.say('t-history', `n${i} ` + 'p'.repeat(1500));
    await watch(s.sid);
    const last = await waitFor(() => tails(s.sid).find((t) => t.last === 400));
    expect(JSON.stringify(last).length).toBeLessThan(24_600);
    expect(last.first).toBeGreaterThan(1); expect(last.total).toBeLessThan(300); expect(last.total).toBeGreaterThan(100); // 400 lines of 1.5 KB went in: the ring keeps what fits 256 KB
    const ringFirst = 400 - last.total + 1;
    expect(last.entries.at(-1)!.text.startsWith('n399')).toBe(true);
    // pull older lines before the window
    await cw.phone.send('history', { sid: s.sid, q: 'h1abcdef', before: last.first, limit: 50 });
    const h1 = await cw.phone.waitFor(() => cw.phone.hists.find((h) => h.q === 'h1abcdef'));
    expect(HistData.safeParse(h1).success).toBe(true);
    expect(h1.entries.length).toBeGreaterThan(0); expect(h1.entries.length).toBeLessThanOrEqual(50);
    expect(h1.entries.at(-1)!.seq).toBe(last.first - 1);
    expect(h1.entries.every((e) => e.seq < last.first)).toBe(true);
    expect(JSON.stringify(h1).length).toBeLessThan(24_600);
    // all the way back: the ring starts at ringFirst, nothing older exists
    await cw.phone.send('history', { sid: s.sid, q: 'h2abcdef', before: ringFirst + 1, limit: 50 });
    const h2 = await cw.phone.waitFor(() => cw.phone.hists.find((h) => h.q === 'h2abcdef'));
    expect(h2.entries.map((e) => e.seq)).toEqual([ringFirst]); expect(h2.more).toBe(false);
    // limit above 50 is not a valid request
    const nh = cw.phone.hists.length;
    await cw.phone.send('history', { sid: s.sid, q: 'h3abcdef', limit: 500 }); await sleep(150);
    expect(cw.phone.hists.length).toBe(nh);
  });

  it('is refused when remote control is off or the device is below observe; observe scope may watch', async () => {
    const s = await cw.session('t-gate');
    cw.setControl({ mode: 'off' });
    try { const n = tails(s.sid).length; await watch(s.sid); await sleep(250); expect(tails(s.sid).length).toBe(n); } finally { cw.setControl({ mode: 'on' }); }
    cw.w.daemon.host.setDeviceScope(cw.phone.id.id, 'observe');
    try { await watch(s.sid); expect(await cw.phone.waitFor(() => tails(s.sid)[0])).toBeTruthy(); } finally { cw.w.daemon.host.setDeviceScope(cw.phone.id.id, 'control'); }
  });

  it('does not tail a session whose adapter does not declare tail, and says so in ctl.can.tail', async () => {
    const { FakeHarness } = await import('./support/fake-harness/index.ts');
    const quiet = new FakeHarness({ id: 'fake-quiet', control: { tail: false } });
    cw.w.daemon.host.hub.register(quiet);
    const s = await cw.session('t-quiet', { harness: quiet });
    const ctl = (await cw.phone.waitFor(() => cw.phone.latest?.sessions.find((x) => x.sid === s.sid)?.ctl))!;
    expect(ctl.can.tail).toBe(false);
    await watch(s.sid); await sleep(250);
    expect(tails(s.sid)).toHaveLength(0);
  });

  it('keeps tool output out by default, includes it (masked) only after the owner turns it on for that session, and removes it again', async () => {
    const s = await cw.session('t-tools');
    await watch(s.sid); await cw.phone.waitFor(() => tails(s.sid)[0]);
    cw.fake.tool('t-tools', 'Bash: cat .env', 'DB_PASSWORD=hunter2hunter2 and token ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8');
    const t = await cw.phone.waitFor(() => tails(s.sid).find((x) => x.entries.some((e) => e.k === 'tool')));
    expect(t.tools).toBe(false);
    expect(t.entries.some((e) => e.k === 'tool_out')).toBe(false);
    expect(JSON.stringify(cw.phone.tails)).not.toContain('hunter2');
    await cw.phone.waitFor(() => cw.phone.latest?.sessions.find((x) => x.sid === s.sid)?.ctl?.tools === false);
    expect(cw.w.daemon.host.setToolOutput('t-tools', true)).toBe(false); // by session id or an unambiguous label, not by adapter key
    expect(cw.w.daemon.host.setToolOutput(s.sid, true)).toBe(true);
    await cw.phone.waitFor(() => cw.phone.latest?.sessions.find((x) => x.sid === s.sid)?.ctl?.tools === true);
    cw.fake.tool('t-tools', 'Bash: cat .env', 'DB_PASSWORD=hunter2hunter2 and token ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8');
    const on = await cw.phone.waitFor(() => tails(s.sid).find((x) => x.tools && x.entries.some((e) => e.k === 'tool_out')));
    const out = on.entries.find((e) => e.k === 'tool_out')!;
    expect(out.text).toContain('DB_PASSWORD=[masked]'); expect(out.text).toContain('[token]'); expect(out.text).not.toContain('hunter2');
    cw.w.daemon.host.setToolOutput(s.sid, false);
    const off = await cw.phone.waitFor(() => tails(s.sid).findLast((x) => !x.tools));
    expect(off.entries.some((e) => e.k === 'tool_out')).toBe(false);
  });

  it('writes a note into the tail when a prompt is sent, with the device name and the length, not the text', async () => {
    const s = await cw.session('t-note'); await watch(s.sid);
    const cid = await cw.phone.cmd('prompt', { sid: s.sid, bind: await s.bind(), text: 'note-canary-text' });
    await cw.phone.result(cid);
    const t = await cw.phone.waitFor(() => tails(s.sid).findLast((x) => x.entries.some((e) => e.k === 'note' && e.text.includes('prompt sent'))));
    const note = t.entries.findLast((e) => e.k === 'note' && e.text.includes('prompt sent'))!;
    expect(note.text).toBe('prompt sent from "Sim phone" (16 characters)');
    // the harness echoed the prompt as a `user` line (that is the tool's own record, not ours)
    expect(t.entries.some((e) => e.k === 'user' && e.text === 'note-canary-text')).toBe(true);
  });

  it('treats hostile output as inert text: nothing survives that could be interpreted, and nothing in it causes any action', async () => {
    const s = await cw.session('t-hostile'); await watch(s.sid);
    const deliveries = () => cw.fake.received.prompts.length + cw.fake.received.interrupts.length + cw.fake.received.answers.length + cw.fake.received.starts.length + cw.fake.received.permissions.length;
    const before = deliveries(); const kinds = cw.phone.kinds.length;
    for (const h of HOSTILE) cw.fake.rawTail('t-hostile', [{ k: 'assistant', text: h.text }, { k: 'tool', text: h.text }, { k: 'user', text: h.text }]);
    await waitFor(() => cw.w.daemon.host.sessions.byKey('t-hostile')!.tail.size >= 3 * (HOSTILE.length - 2));
    const sess = cw.w.daemon.host.sessions.byKey('t-hostile')!;
    const all = sess.tail.window(10_000_000, 300);
    for (const e of all) {
      expect(TailEntry.safeParse(e).success, `entry ${e.seq}`).toBe(true);
      expect(FORBIDDEN_IN_TAIL.test(e.text), `control characters in entry ${e.seq}`).toBe(false);
      expect(Array.from(e.text).length).toBeLessThanOrEqual(e.k === 'tool' ? 300 : 4000);
    }
    const joined = all.map((e) => e.text).join('\n');
    for (const h of HOSTILE) for (const lit of h.literal ?? []) expect(joined, `${h.name}: ${lit}`).toContain(lit); // markup stays literal text, it is not "cleaned" into something else
    expect(joined).not.toContain('ghp_A1b2'); expect(joined).not.toContain('hunter2hunter2'); expect(joined).not.toContain('sk-ant-api03');
    expect(joined).not.toContain('\u001b');
    // no action followed from any of it, and the only frames the phone got are tail windows and states
    await sleep(400);
    expect(deliveries()).toBe(before);
    expect(sess.pending).toBeUndefined();
    expect(new Set(cw.phone.kinds.slice(kinds))).toEqual(new Set(['tail', 'state'].filter((k) => cw.phone.kinds.slice(kinds).includes(k))));
    expect(cw.phone.kinds.slice(kinds).every((k) => k === 'tail' || k === 'state')).toBe(true);
  });

  it('never lets a planted string reach the relay in the clear (it carries sealed frames only)', async () => {
    const canary = 'canary-tail-9f3a61c2-visible-nowhere';
    const s = await cw.session('t-canary'); await watch(s.sid);
    cw.fake.say('t-canary', canary);
    await cw.phone.waitFor(() => tails(s.sid).find((x) => x.entries.some((e) => e.text === canary)));
    const relay = cw.w.relay as unknown as { queues: Map<string, unknown[]>; counters: Map<string, number> };
    const dump = JSON.stringify([...relay.queues.entries()]) + JSON.stringify([...relay.counters.entries()]);
    expect(dump).not.toContain(canary);
    expect(dump).not.toContain(Buffer.from(canary).toString('base64'));
    expect(dump).not.toContain(Buffer.from(canary).toString('base64url'));
  });
});

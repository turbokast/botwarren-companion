import { afterEach, describe, expect, it } from 'vitest';
import { assistant, startWorld, transcript, type World } from './world.ts';
import type { SimDevice } from './simdevice.ts';
import { CAP_LONG } from '../src/protocol/index.ts';
import { stateBytes } from '../src/stateview.ts';

/**
 * 0.1.3, item 4 of the owner's second test: long messages were truncated at 600 characters (and a command at 1200) BY THE COMPUTER before anything was sent.
 * A page that says it can read long messages (capability long1 in its `sync`) now gets up to 24,000 characters per text inside one 64 KB frame; an older
 * page keeps getting the short form; text that still does not fit is cut at the end and the cut is reported.
 */
describe('long messages', () => {
  let w: World | null = null;
  afterEach(async () => { await w?.close(); w = null; });
  const hookIn = (event: string, extra: Record<string, unknown> = {}) => ({ session_id: 'sess-1', cwd: '/work/dragon-game', hook_event_name: event, ...extra });
  const pending = (d: SimDevice) => d.latest?.sessions.find((s) => s.pending)?.pending;
  const ansi = (s: string): string => `\u001b[32m${s}\u001b[0m`;
  const longText = (n: number): string => Array.from({ length: Math.ceil(n / 40) }, (_, i) => `line ${String(i).padStart(4, '0')} of a long answer, kept whole`).join('\n').slice(0, n);

  it('a page that can read long messages gets all 20,000 characters (colours stripped, secrets masked); an older page gets the short form', async () => {
    w = await startWorld();
    const modern = await w.pairDevice('Modern phone', { caps: [CAP_LONG] });
    const old = await w.pairDevice('Old phone');
    const body = longText(20_000);
    const secret = ['gh', 'p_'].join('') + 'abcdefghijklmnopqrstuvwxyz0123456789AB';
    const tp = transcript(w.claudeDir, [assistant('first'), assistant(ansi(body) + `\nthe token is ${secret}\n`), assistant('Shall I go on?')]);
    await w.hook('Stop', hookIn('Stop', { transcript_path: tp }));
    await modern.waitFor(() => pending(modern));
    await old.waitFor(() => pending(old));
    const recent = modern.latest!.sessions[0]!.recent;
    expect(recent).toHaveLength(3);
    expect(recent[1]!.text.startsWith(body.slice(0, 200))).toBe(true);
    expect(recent[1]!.text.length).toBeGreaterThan(body.length);
    expect(body.length).toBeGreaterThan(19_000);
    expect(recent[1]!.text).not.toContain('\u001b');
    expect(recent[1]!.text).toContain('the token is [token]');
    expect(JSON.stringify(modern.latest)).not.toContain('ghp_');
    expect(recent[1]!.cut).toBeUndefined();
    // the old page: the first version's limit, no cut flags it could not parse
    const o = old.latest!.sessions[0]!.recent;
    expect(o.every((r) => r.text.length <= 600 && !('cut' in r))).toBe(true);
    expect(stateBytes(old.latest!)).toBeLessThanOrEqual(7500);
  }, 60_000);

  it('three messages of 24,000 characters do not fit 64 KB together: they share the room, are cut at the end, and say how much', async () => {
    w = await startWorld();
    const d = await w.pairDevice('Modern phone', { caps: [CAP_LONG] });
    const big = longText(40_000);
    const tp = transcript(w.claudeDir, [assistant(big), assistant(big), assistant(big)]);
    await w.hook('Stop', hookIn('Stop', { transcript_path: tp }));
    await d.waitFor(() => pending(d));
    const st = d.latest!;
    expect(stateBytes(st)).toBeLessThanOrEqual(65_534);
    const r = st.sessions[0]!.recent;
    for (const m of r) { expect(m.cut).toBeGreaterThan(0); expect(big.startsWith(m.text)).toBe(true); expect(m.text.length).toBeGreaterThan(8000); }
    // the frame the relay carried was the 64 KB bucket at most (the relay's limit is 96 KB per frame)
    expect(w.relay.counters.get('frame_bad_frame') ?? 0).toBe(0);
  }, 60_000);

  it('a request whose command is 5,000 characters is shown in full and can be approved on a modern page; an old page cannot approve what it only saw shortened', async () => {
    w = await startWorld();
    const modern = await w.pairDevice('Modern phone', { caps: [CAP_LONG] });
    const old = await w.pairDevice('Old phone');
    const ch = await w.channel();
    const cmd = `echo start && ${'echo more-and-more && '.repeat(230)}echo end`;
    expect(cmd.length).toBeGreaterThan(4800);
    ch.permissionRequest('abcde', 'Bash', 'Run a long command', cmd);
    await modern.waitFor(() => pending(modern)); await old.waitFor(() => pending(old));
    expect(pending(modern)!.preview).toBe(cmd);
    expect(pending(modern)!.cut).toBeUndefined();
    expect(pending(modern)!.can.approve).toBe(true);
    expect(pending(old)!.preview.length).toBeLessThanOrEqual(1200);
    expect(pending(old)!.can.approve).toBe(false);
    // and the approve really works for the modern page, bound to the full text it was shown
    const p = pending(modern)!; const sid = modern.latest!.sessions.find((s) => s.pending)!.sid;
    await modern.act({ rid: p.rid, sid, a: 'approve', bind: p.bind });
    await modern.waitFor(() => modern.results.find((x) => x.outcome === 'applied'));
  }, 60_000);

  it('a request that is too long even for the long form (30,000 characters) shows what fits, says what was cut, and cannot be approved from the phone', async () => {
    w = await startWorld();
    const d = await w.pairDevice('Modern phone', { caps: [CAP_LONG] });
    const ch = await w.channel();
    ch.permissionRequest('abcde', 'Bash', 'Run it', 'x'.repeat(30_000));
    await d.waitFor(() => pending(d));
    const p = pending(d)!;
    expect(p.preview.length).toBe(24_000);
    expect(p.cut).toBe(6000);
    expect(p.can.approve).toBe(false);
    const sid = d.latest!.sessions.find((s) => s.pending)!.sid;
    await d.act({ rid: p.rid, sid, a: 'approve', bind: p.bind });
    await d.waitFor(() => d.results.find((x) => x.outcome === 'rejected'));
  }, 60_000);

  it('against a relay that carries only 16 KB frames (0.1.2), even a modern page gets the short form: the relay would close the connection on a bigger frame', async () => {
    w = await startWorld();
    const d = await w.pairDevice('Modern phone', { caps: [CAP_LONG] });
    const host = w.daemon.host as unknown as { relayMaxFrame: number };
    host.relayMaxFrame = 16 * 1024;
    const tp = transcript(w.claudeDir, [assistant(longText(20_000))]);
    await w.hook('Stop', hookIn('Stop', { transcript_path: tp }));
    await d.waitFor(() => pending(d));
    await w.daemon.host.pushState(undefined, true);
    await d.waitFor(() => d.states.length > 1);
    expect(d.latest!.sessions[0]!.recent[0]!.text.length).toBeLessThanOrEqual(600);
    expect(w.relay.counters.get('conn_replaced') ?? 0).toBe(0);
  }, 60_000);

  it('the relay announces its frame limit in `ready` and the host takes it', async () => {
    w = await startWorld();
    const d = await w.pairDevice('Modern phone', { caps: [CAP_LONG] });
    const host = w.daemon.host as unknown as { relayMaxFrame: number };
    expect(host.relayMaxFrame).toBe(96 * 1024); // the authenticated host heard it
    expect(d.online).toBe(true);
  }, 60_000);
});

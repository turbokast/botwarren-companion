import { describe, expect, it } from 'vitest';
import { StateData, type StateData as State } from '../src/protocol/index.ts';
import { fitLong, fitText, stateBytes, toLegacy, LEGACY_STATE_BYTES } from '../src/stateview.ts';
import { cleanText } from '../src/textclean.ts';
import { cutEnd } from '../src/sessions.ts';
import { versionMismatchMessage } from '../src/service.ts';

const base = (sessions: State['sessions']): State => ({
  rev: 1, host: { name: 'Laptop', paused: false, confirm: { approve: 'off', reply: 'off' }, devices: [] }, presets: [{ id: 'continue', label: 'Continue' }], sessions,
});
const sess = (sid: string, o: { recent?: string[]; preview?: string; summary?: string; kind?: 'permission' | 'idle' } = {}): State['sessions'][number] => ({
  sid, agent: 'claude-code', label: `proj-${sid}`, status: o.preview !== undefined ? 'waiting' : 'working', since: 1, recent: (o.recent ?? []).map((text, i) => ({ role: 'assistant' as const, text, ts: i + 1 })),
  ...(o.preview !== undefined ? { pending: { rid: `abcd-${sid}1234`, kind: o.kind ?? 'permission', tool: 'Bash', summary: o.summary ?? 'Run a command', preview: o.preview, expires: 9, bind: 'a'.repeat(64), can: { approve: true, reply: false } } } : {}),
});

describe('the long form of the state (0.1.3)', () => {
  it('keeps everything, uncut, when it fits (a 20,000 character message arrives whole)', () => {
    const long = 'line of output\n'.repeat(1300); // 19,500 characters
    const st = base([sess('aaaaaa111111', { recent: [long, 'short'], preview: 'npm test', summary: 'Run the tests' })]);
    const out = fitLong(st, 65_534 - 220);
    expect(out.sessions[0]!.recent[0]!.text).toBe(long);
    expect(out.sessions[0]!.recent[0]!.cut).toBeUndefined();
    expect(out.sessions[0]!.pending!.can.approve).toBe(true);
    expect(StateData.safeParse(out).success).toBe(true);
  });

  it('when it does not all fit, shares the room by weight, cuts at the END, says how much, and never exceeds the budget', () => {
    const big = 'x'.repeat(24_000);
    const st = base([sess('aaaaaa111111', { recent: [big, big, big], preview: big, summary: 'Run a command' }), sess('bbbbbb222222', { recent: [big] })]);
    const budget = 60_000;
    const out = fitLong(st, budget);
    expect(stateBytes(out)).toBeLessThanOrEqual(budget);
    for (const s of out.sessions) for (const r of s.recent) { expect(big.startsWith(r.text)).toBe(true); expect(r.text.length + (r.cut ?? 0)).toBe(big.length); }
    const p = out.sessions[0]!.pending!;
    expect(p.cut).toBeGreaterThan(0);
    expect(p.preview.length + p.cut!).toBe(big.length);
    expect(p.can.approve).toBe(false); // it could not be shown in full: it cannot be approved from a phone
    // the waiting request's preview gets the biggest share
    expect(p.preview.length).toBeGreaterThan(out.sessions[0]!.recent[0]!.text.length);
    expect(StateData.safeParse(out).success).toBe(true);
  });

  it('measures JSON escaping and multi-byte characters, not characters', () => {
    const t = '"\n\\é€😀'.repeat(8000);
    const st = base([sess('aaaaaa111111', { recent: [t] })]);
    const out = fitLong(st, 30_000);
    expect(stateBytes(out)).toBeLessThanOrEqual(30_000);
    expect(out.sessions[0]!.recent[0]!.cut).toBeGreaterThan(0);
    expect(Array.from(t).slice(0, Array.from(out.sessions[0]!.recent[0]!.text).length).join('')).toBe(out.sessions[0]!.recent[0]!.text); // whole characters, a prefix
  });

  it('fitText never splits a surrogate pair', () => {
    const r = fitText('😀😀😀😀', 9); // each is 4 bytes in JSON as UTF-8
    expect(r.text).toBe('😀😀');
    expect(r.cut).toBe(2);
  });

  it('cutEnd counts characters, not UTF-16 units', () => {
    expect(cutEnd('😀😀😀', 2)).toEqual({ text: '😀😀', cut: 1 });
    expect(cutEnd('abc', 5)).toEqual({ text: 'abc', cut: 0 });
  });
});

describe('the short form every older page understands', () => {
  it('clips to the first versions\' limits, drops the cut flags, and stays inside one 8 KB bucket', () => {
    const big = 'y'.repeat(5000);
    const st = base([sess('aaaaaa111111', { recent: [big, big, big], preview: big }), sess('bbbbbb222222', { recent: [big] })]);
    st.sessions[0]!.recent[2]!.cut = 7;
    const out = toLegacy(st);
    expect(stateBytes(out)).toBeLessThanOrEqual(LEGACY_STATE_BYTES);
    for (const s of out.sessions) for (const r of s.recent) { expect(r.text.length).toBeLessThanOrEqual(600); expect('cut' in r).toBe(false); }
    expect(out.sessions[0]!.pending!.preview.length).toBeLessThanOrEqual(1200);
  });

  it('a request shown shortened to an old page cannot be approved there (an approval applies to what the person saw)', () => {
    const shortOk = toLegacy(base([sess('aaaaaa111111', { preview: 'npm test' })]));
    expect(shortOk.sessions[0]!.pending!.can.approve).toBe(true);
    const longCmd = toLegacy(base([sess('aaaaaa111111', { preview: 'echo hi && '.repeat(300) })]));
    expect(longCmd.sessions[0]!.pending!.can.approve).toBe(false);
  });
});

describe('cleanText: what a terminal printed becomes plain text', () => {
  it('removes colours, cursor moves, window titles, links, control characters and bidi overrides; keeps tabs and newlines', () => {
    expect(cleanText('\u001b[31mred\u001b[0m \u001b[1;32mgreen\u001b[0m')).toBe('red green');
    expect(cleanText('a\u001b]0;title\u0007b\u001b]8;;http://x\u001b\\link\u001b]8;;\u001b\\')).toBe('ablink');
    expect(cleanText('x\u001b[2K\u001b[1Gy')).toBe('xy');
    expect(cleanText('col1\tcol2\nline2')).toBe('col1\tcol2\nline2');
    expect(cleanText('ok\u0000\u0007\u0008\u007f.')).toBe('ok.');
    expect(cleanText('rm ‮-rf /')).toBe('rm -rf /');
    expect(cleanText('50%\r100%\r\ndone')).toBe('100%\ndone');
  });
});

describe('a running daemon older than the installed command', () => {
  const unit = { kind: 'systemd' as const, file: '/x/botwarren-companion.service', restart: 'systemctl --user restart botwarren-companion' };
  it('says so, names the version and the one command that fixes it; says nothing when they match', () => {
    expect(versionMismatchMessage({ running: '0.1.3', installed: '0.1.3', unit })).toBeNull();
    const m = versionMismatchMessage({ running: undefined, installed: '0.1.3', unit })!;
    expect(m).toContain('0.1.1 or older');
    expect(m).toContain('0.1.3 is installed');
    expect(m).toContain('systemctl --user restart botwarren-companion');
    expect(versionMismatchMessage({ running: '0.1.2', installed: '0.1.3', unit: null })).toContain('botwarren-companion daemon');
  });
});

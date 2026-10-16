import { describe, expect, it } from 'vitest';
import { ActionLimiter, checkControlText, projectAllowed, spendAll } from '../src/policy.ts';
import { AnswerData, CResultData, HistoryData, InterruptData, PromptData, REFUSALS, StartData, SuBeginData, WatchData, charLength, commandDigest, newCid, scopeAtLeast } from '../src/protocol/index.ts';

const bind = 'a'.repeat(64);

describe('text rules for anything a device types for an agent', () => {
  it('cleans, trims, and refuses empty and over-long text (characters, not units)', () => {
    expect(checkControlText('  hello \u001b[1mworld\u001b[0m\u202e \n', 'api')).toEqual({ ok: true, text: 'hello world' });
    expect(checkControlText(' \u0007 ', 'api')).toEqual({ ok: false, why: 'empty' });
    expect(checkControlText('x'.repeat(4000), 'api').ok).toBe(true);
    expect(checkControlText('x'.repeat(4001), 'api')).toEqual({ ok: false, why: 'size' });
    expect(checkControlText('\u{1F600}'.repeat(4000), 'api').ok).toBe(true);
    expect(charLength('\u{1F600}\u{1F600}')).toBe(2);
  });
  it('refuses a leading ! or / on any line for a keystroke route only', () => {
    for (const t of ['!ls', '/clear', ' \t/clear', 'ok\n!ls', 'ok\r\n  /x']) expect(checkControlText(t, 'keys'), t).toEqual({ ok: false, why: 'keystroke_prefix' });
    for (const t of ['!ls', '/clear', 'ok\n!ls']) for (const r of ['api', 'channel', 'hook'] as const) expect(checkControlText(t, r).ok, `${r} ${t}`).toBe(true);
    for (const t of ['hello! there', 'a/b', 'what? /not first', 'path is /usr/bin']) expect(checkControlText(t, 'keys').ok, t).toBe(true);
  });
  it('a bidi override or escape in front of "!" does not hide it (cleaning comes first)', () => {
    expect(checkControlText('\u202e!ls', 'keys')).toEqual({ ok: false, why: 'keystroke_prefix' });
    expect(checkControlText('\u001b[0m/clear', 'keys')).toEqual({ ok: false, why: 'keystroke_prefix' });
  });
});

describe('project allowlist', () => {
  it('empty allows anything; otherwise only inside a listed absolute folder', () => {
    expect(projectAllowed([], '/anything')).toBe(true);
    expect(projectAllowed(['/work'], '/work')).toBe(true);
    expect(projectAllowed(['/work'], '/work/app/src')).toBe(true);
    expect(projectAllowed(['/work'], '/workshop')).toBe(false);
    expect(projectAllowed(['/work'], '/work/../etc')).toBe(false);
    expect(projectAllowed(['/work'], '')).toBe(false);
    expect(projectAllowed(['work'], '/work')).toBe(false);
  });
});

describe('rate buckets', () => {
  it('wouldAllow spends nothing; record spends; spendAll takes from all or none', () => {
    const a = new ActionLimiter(2, 100); const b = new ActionLimiter(100, 1);
    expect(a.wouldAllow(0)).toBe(true); expect(a.wouldAllow(0)).toBe(true);
    expect(spendAll([a, b], 0)).toBe(true);
    expect(spendAll([a, b], 1)).toBe(false); // b is out (1 an hour)
    expect(a.wouldAllow(2)).toBe(true); // a was not charged by the failed attempt
    expect(a.allow(2)).toBe(true); expect(a.allow(3)).toBe(false); // 2 a minute
    expect(a.allow(61_000)).toBe(true);
  });
});

describe('scopes', () => {
  it('rank observe < answer < control, and a device with none recorded is answer', () => {
    expect(scopeAtLeast(undefined, 'answer')).toBe(true); expect(scopeAtLeast(undefined, 'control')).toBe(false);
    expect(scopeAtLeast('observe', 'answer')).toBe(false); expect(scopeAtLeast('control', 'observe')).toBe(true);
  });
});

describe('message schemas are strict', () => {
  const cid = newCid(); const x = Date.now() + 60_000;
  it('accepts exactly the documented fields and refuses extras (no path, command, flag or env can ride along)', () => {
    expect(PromptData.safeParse({ cid, sid: 'abcdef123456', bind, text: 'hi', x }).success).toBe(true);
    expect(PromptData.safeParse({ cid, sid: 'abcdef123456', bind, text: 'hi', x, cwd: '/' }).success).toBe(false);
    expect(InterruptData.safeParse({ cid, sid: 'abcdef123456', bind, x }).success).toBe(true);
    expect(StartData.safeParse({ cid, launchId: 'proj-1', mode: 'plan', x }).success).toBe(true);
    for (const bad of [{ mode: 'bypassPermissions' }, { mode: 'default', path: '/etc' }, { mode: 'default', command: 'sh' }, { mode: 'default', env: { A: '1' } }, { launchId: '../x', mode: 'default' }]) expect(StartData.safeParse({ cid, launchId: 'proj-1', x, ...bad }).success, JSON.stringify(bad)).toBe(false);
    expect(AnswerData.safeParse({ cid, sid: 'abcdef123456', rid: 'abcd-123456', bind, text: 'main', x }).success).toBe(true);
    expect(WatchData.safeParse({ sid: 'abcdef123456', on: true }).success).toBe(true);
    expect(HistoryData.safeParse({ sid: 'abcdef123456', q: 'abcd1234', limit: 51 }).success).toBe(false);
    expect(SuBeginData.safeParse({ for: 'cmd', cid, kind: 'prompt' }).success).toBe(false);
    expect(SuBeginData.safeParse({ for: 'cmd', cid, kind: 'interrupt', digest: bind }).success).toBe(false); // a stop never needs a step-up
  });
  it('command ids are 16 to 32 safe characters; newCid makes valid, distinct ones', () => {
    expect(PromptData.safeParse({ cid: 'short', sid: 'abcdef123456', bind, text: 'hi', x }).success).toBe(false);
    const a = newCid(); const b = newCid();
    expect(a).not.toBe(b); expect(a).toMatch(/^[A-Za-z0-9_-]{16,32}$/);
  });
  it('every refusal the host can give is a documented code in the result schema', () => {
    for (const why of REFUSALS) expect(CResultData.safeParse({ cid, kind: 'prompt', outcome: 'refused', why }).success, why).toBe(true);
    expect(CResultData.safeParse({ cid, kind: 'prompt', outcome: 'refused', why: 'because' }).success).toBe(false);
  });
  it('command digests are stable and differ for any change', async () => {
    const d = await commandDigest('prompt', 'abcdef123456', 'hello');
    expect(d).toMatch(/^[0-9a-f]{64}$/);
    expect(await commandDigest('prompt', 'abcdef123456', 'hello')).toBe(d);
    for (const other of [await commandDigest('prompt', 'abcdef123456', 'hellO'), await commandDigest('prompt', 'abcdef123457', 'hello'), await commandDigest('answer', 'abcdef123456', 'hello')]) expect(other).not.toBe(d);
  });
});

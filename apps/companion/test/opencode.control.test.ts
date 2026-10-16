/**
 * OpenCode v2 control (protocol 3, WP4): prompt, interrupt, free-text form answer, start and live tail, against the fake OpenCode server in the shapes recorded
 * from a real opencode 2.0.21 (test/support/fixtures/opencode-v2-shapes.json). Adapter-level tests first (what was put on the wire, what is claimed), then the
 * whole path through the real host (scope, step-up fallback, bind, delivery, follow-up) with a simulated paired phone.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeOpenCode, type FakeOpenCode } from './support/fake-opencode.ts';
import { recordingContext, type Recording } from './support/recording-context.ts';
import { controlWorld, waitFor, type ControlWorld } from './support/control-world.ts';
import { asControlText } from '../src/adapters/preset.ts';
import { ALLOWED, OpenCodeAdapter } from '../src/adapters/opencode/adapter.ts';
import { messageLines } from '../src/adapters/opencode/tail.ts';
import type { ControlPrompt, LaunchSpec, NativeRef } from '../src/adapters/types.ts';

const PASS = 'BW_TEST_OC_CONTROL';
const who = { device: 'Test phone' };
const framed = (text: string): ControlPrompt => ({ text: asControlText(text), framed: asControlText(`[Botwarren Companion: message from the owner's paired device "Test phone"]\n\n${text}`), from: 'Test phone' });

interface Rig { oc: FakeOpenCode; a: OpenCodeAdapter; rec: Recording; root: string; key: (sid: string) => string; add(sid: string, o?: { running?: boolean; permissions?: unknown[] }): Promise<string>; close(): Promise<void> }
const rigs: Rig[] = [];
afterEach(async () => { for (const r of rigs.splice(0)) await r.close(); });
async function rig(o: { version?: string; verified?: string[] } = {}): Promise<Rig> {
  const oc = await fakeOpenCode(o.version ? { version: o.version } : {});
  const root = mkdtempSync(join(tmpdir(), 'bwc-occtl-'));
  const a = new OpenCodeAdapter({ env: { [PASS]: oc.password! } });
  const rec = recordingContext();
  rec.ctx.config = () => ({ enabled: true, hold: 'never', holdSeconds: 30, port: oc.port, passwordEnv: PASS, ...(o.verified ? { verifiedVersions: o.verified } : {}) });
  await a.start(rec.ctx);
  const r: Rig = {
    oc, a, rec, root, key: (sid) => `opencode:${sid}`,
    async add(sid, x = {}) { oc.sessions.push({ id: sid, dir: root, ...(x.running ? { running: true } : {}), ...(x.permissions ? { permissions: x.permissions } : {}) }); await a.poll(); return `opencode:${sid}`; },
    async close() { await a.stop(); await oc.close(); rmSync(root, { recursive: true, force: true }); },
  };
  rigs.push(r);
  return r;
}
const SID = 'ses_aaaa1111'; const SID2 = 'ses_bbbb2222';
const launch = (r: Rig, mode: LaunchSpec['mode'] = 'default', harness: LaunchSpec['harness'] = 'opencode'): LaunchSpec => ({ id: 'oc', label: 'OpenCode project', harness, root: r.root, mode });

describe('OpenCode control: prompt', () => {
  it('sends {text: <the host\'s framed text>, delivery: "queue"} to the session\'s prompt route and nothing else, then claims the follow-up only after OpenCode has the message', async () => {
    const r = await rig(); const key = await r.add(SID);
    expect(await r.a.sendPrompt(key, framed('run the tests'), who)).toBe('delivered');
    await r.a.settled();
    expect(r.oc.prompts).toHaveLength(1);
    expect(r.oc.prompts[0]!.sessionID).toBe(SID);
    expect(r.oc.prompts[0]!.body).toEqual({ text: framed('run the tests').framed, delivery: 'queue' });
    expect(r.rec.followups).toEqual([{ key, what: 'prompt' }]);
    const post = r.oc.requests.filter((x) => x.method === 'POST');
    expect(post.map((x) => x.path)).toEqual([`/api/session/${SID}/prompt`]);
    expect(r.oc.requests.at(-1)).toMatchObject({ method: 'GET' }); // the confirmation read of the stored message
  });

  it('maps OpenCode\'s answers: 404 gone, 409 busy, anything else failed; no follow-up for any of them', async () => {
    const r = await rig(); const key = await r.add(SID);
    r.oc.promptConflict = true;
    expect(await r.a.sendPrompt(key, framed('x'), who)).toBe('busy');
    r.oc.sessions.length = 0; // the session was deleted behind our back
    expect(await r.a.sendPrompt(key, framed('x'), who)).toBe('gone');
    await r.a.settled();
    expect(r.rec.followups).toEqual([]);
    await r.oc.close();
    expect(await r.a.sendPrompt(key, framed('x'), who)).toBe('failed');
  });

  it('only a session the adapter itself reported is addressable; keys that are not `opencode:ses...` are "gone" and make no request', async () => {
    const r = await rig(); await r.add(SID);
    const n = r.oc.requests.length;
    for (const k of ['', 'ses_aaaa1111', `opencode:${SID2}`, 'opencode:../../shell', 'opencode:ses_aaaa1111/../../shell', 'opencode:ses_aaaa1111?x=1', 'claude:abc']) expect(await r.a.sendPrompt(k, framed('x'), who), k).toBe('gone');
    expect(r.oc.requests.length).toBe(n);
  });

  it('a version that was not verified gets no control: unsupported, and nothing is written to the server', async () => {
    const r = await rig({ version: '2.5.0' }); const key = await r.add(SID);
    expect(await r.a.sendPrompt(key, framed('x'), who)).toBe('unsupported');
    expect(await r.a.interrupt(key, who)).toBe('unsupported');
    expect((await r.a.startSession(launch(r), null, who)).result).toBe('unsupported');
    expect(r.oc.requests.filter((x) => x.method === 'POST')).toEqual([]);
    // a version the person verified themselves is allowed
    const r2 = await rig({ version: '2.5.0', verified: ['2.5.0'] }); const key2 = await r2.add(SID);
    expect(await r2.a.sendPrompt(key2, framed('x'), who)).toBe('delivered');
  });
});

describe('OpenCode control: interrupt', () => {
  it('posts the interrupt route; claims the follow-up only once the session is really not running any more', async () => {
    const r = await rig(); const key = await r.add(SID, { running: true });
    expect(await r.a.interrupt(key, who)).toBe('delivered');
    await r.a.settled();
    expect(r.oc.interrupts).toEqual([SID]);
    expect(r.rec.followups).toEqual([{ key, what: 'interrupt' }]);
    const post = r.oc.requests.filter((x) => x.method === 'POST');
    expect(post).toEqual([expect.objectContaining({ path: `/api/session/${SID}/interrupt`, body: undefined })]);
  });

  it('an idle session: accepted, but "nothing was running" is not claimed as a stop', async () => {
    const r = await rig(); const key = await r.add(SID);
    expect(await r.a.interrupt(key, who)).toBe('delivered');
    await r.a.settled();
    expect(r.rec.followups).toEqual([]);
  });

  it('does not claim the stop when the session keeps running', async () => {
    const r = await rig(); const key = await r.add(SID, { running: true });
    const s = r.oc.sessions[0]!;
    // the server says it interrupted, but the session is still active (it started another turn)
    // (a getter, not a timer: a timer races the adapter's next poll on a quiet machine)
    Object.defineProperty(s, 'running', { get: () => true, set: () => undefined });
    expect(await r.a.interrupt(key, who)).toBe('delivered');
    await r.a.settled();
    expect(r.rec.followups).toEqual([]);
  });
});

describe('OpenCode control: free-text answer to a question (form)', () => {
  const ask = async (r: Rig, fields: unknown[], id = 'frm_aaaa11112222') => {
    const key = await r.add(SID);
    r.oc.forms.push({ id, sessionID: SID, title: 'Which branch should I use?', dir: r.root, fields: fields as never });
    await r.a.poll();
    return { key, p: r.rec.pendings.filter((x) => x.kind === 'question').at(-1)! };
  };

  it('a question in a folder whose name has ~ ! \' ( ) * is still seen (Windows short names like RUNNER~1, "site (copy)")', async () => {
    const r = await rig();
    const odd = join(r.root, "RUNNER~1 (copy) it's!"); // no * : Windows forbids it in a folder name
    mkdirSync(odd);
    r.oc.sessions.push({ id: SID, dir: odd });
    r.oc.forms.push({ id: 'frm_aaaa11112222', sessionID: SID, title: 'Which branch?', dir: odd, fields: [{ key: 'branch', type: 'string' }] as never });
    await r.a.poll();
    expect(r.rec.pendings.some((x) => x.kind === 'question' && x.native?.id === 'frm_aaaa11112222')).toBe(true);
    expect(r.oc.requests.some((q) => q.path === '/api/form' && q.query.includes('%7E') && q.query.includes('%28'))).toBe(true);
  });

  it('a form that is exactly one free-text field is answerable: the reply body is {answer: {<key>: text}} for that form id', async () => {
    const r = await rig();
    const { key, p } = await ask(r, [{ key: 'branch', type: 'string', title: 'Branch', required: true }]);
    expect(p.native).toMatchObject({ adapter: 'opencode', kind: 'request_id', id: 'frm_aaaa11112222' });
    expect(p.summary).toBe('Which branch should I use?');
    expect(p.preview).toContain('Branch');
    expect(await r.a.revalidate(p.native!)).toBe('live');
    expect(await r.a.answerText(p.native!, asControlText('main'), who)).toBe('delivered');
    await r.a.settled();
    expect(r.oc.formReplies).toEqual([{ id: 'frm_aaaa11112222', body: { answer: { branch: 'main' } } }]);
    expect(r.rec.followups).toEqual([{ key, what: 'answer' }]);
    expect(await r.a.revalidate(p.native!)).toBe('gone');
    expect(r.oc.requests.filter((x) => x.method === 'POST').map((x) => x.path)).toEqual([`/api/session/${SID}/form/frm_aaaa11112222/reply`]);
  });

  it('a fixed choice, several fields, a boolean or a typed (email) field is shown read-only: no native handle, so no phone can answer it', async () => {
    for (const fields of [
      [{ key: 'db', type: 'string', options: [{ value: 'pg', label: 'Postgres' }], custom: false }],
      [{ key: 'a', type: 'string' }, { key: 'b', type: 'string' }],
      [{ key: 'ok', type: 'boolean' }],
      [{ key: 'mail', type: 'string', format: 'email' }],
      [],
    ]) {
      const r = await rig();
      const { p } = await ask(r, fields);
      expect(p.native, JSON.stringify(fields)).toBeNull();
    }
  });

  it('a choice that also allows custom text is answerable as text; a form settled at the terminal first is "gone"; a too-long answer is refused before it is sent', async () => {
    const r = await rig();
    const { p } = await ask(r, [{ key: 'db', type: 'string', options: [{ value: 'pg', label: 'Postgres' }], custom: true, maxLength: 5 }]);
    expect(p.native).not.toBeNull();
    expect(await r.a.answerText(p.native!, asControlText('way too long'), who)).toBe('failed');
    expect(r.oc.formReplies).toEqual([]);
    r.oc.forms[0]!.state = 'answered'; // answered at the terminal at the same moment
    expect(await r.a.revalidate(p.native!)).toBe('gone');
    expect(await r.a.answerText(p.native!, asControlText('pg'), who)).toBe('gone');
    expect(await r.a.answerText({ ...p.native!, id: 'frm_other0000' } as NativeRef, asControlText('pg'), who)).toBe('gone');
  });

  it('the card clears when the form is gone, and an answer to a different form is never sent to this one', async () => {
    const r = await rig();
    const { key, p } = await ask(r, [{ key: 'branch', type: 'string' }]);
    r.oc.forms[0]!.state = 'cancelled';
    await r.a.poll();
    expect(r.rec.cleared.some((c) => c.key === key && c.why === 'answered_local')).toBe(true);
    expect(await r.a.answerText(p.native!, asControlText('x'), who)).toBe('gone');
  });
});

describe('OpenCode control: start a session', () => {
  it('creates the session in the launch folder with ask-before-every-tool rules, reports it before returning its key, then sends the first prompt', async () => {
    const r = await rig();
    const res = await r.a.startSession(launch(r), framed('first task'), who);
    expect(res.result).toBe('delivered');
    expect(res.sessionKey).toMatch(/^opencode:ses_/);
    expect(r.oc.created).toEqual([{ location: { directory: r.root }, permissions: [{ action: '*', resource: '*', effect: 'ask' }] }]);
    expect(r.rec.sessions.find((s) => s.key === res.sessionKey)).toMatchObject({ agent: 'opencode', cwd: r.root, status: 'idle', mode: 'normal' });
    expect(r.oc.prompts).toHaveLength(1);
    expect(r.oc.prompts[0]!.body).toEqual({ text: framed('first task').framed, delivery: 'queue' });
    expect(r.oc.prompts[0]!.sessionID).toBe(res.sessionKey!.slice('opencode:'.length));
    await r.a.settled();
    expect(r.rec.followups).toEqual([{ key: res.sessionKey, what: 'prompt' }]);
    // the new session can be addressed straight away
    expect(await r.a.interrupt(res.sessionKey!, who)).toBe('delivered');
  });

  it('plan mode selects the plan agent (and still asks); acceptEdits and bypass-like modes have no verified meaning and are refused; a launch for another harness is not ours', async () => {
    const r = await rig();
    const p = await r.a.startSession(launch(r, 'plan'), null, who);
    expect(p.result).toBe('delivered');
    expect(r.oc.created.at(-1)).toEqual({ location: { directory: r.root }, agent: 'plan', permissions: [{ action: '*', resource: '*', effect: 'ask' }] });
    expect(r.oc.prompts).toEqual([]); // no first prompt, none sent
    const n = r.oc.created.length;
    expect((await r.a.startSession(launch(r, 'acceptEdits'), null, who)).result).toBe('unsupported');
    expect((await r.a.startSession({ ...launch(r), mode: 'bypass' as never }, null, who)).result).toBe('unsupported');
    expect((await r.a.startSession(launch(r, 'default', 'claude-code'), null, who)).result).toBe('unsupported');
    expect(r.oc.created.length).toBe(n);
  });

  it('a folder that is not absolute, or does not exist, is never sent to the server', async () => {
    const r = await rig();
    for (const root of ['relative/dir', '/definitely/not/here-8c1f', '/tmp/\n/x', '']) expect((await r.a.startSession({ ...launch(r), root }, null, who)).result, root).toBe('failed');
    expect(r.oc.created).toEqual([]);
  });

  it('a first prompt that OpenCode refuses leaves the session reported but is a failure the host can show', async () => {
    const r = await rig();
    r.oc.promptConflict = true;
    const res = await r.a.startSession(launch(r), framed('x'), who);
    expect(res.result).toBe('busy');
    expect(res.sessionKey).toMatch(/^opencode:ses_/);
  });

  it('a session whose own rules allow everything is reported as running without prompts (bypass); one with ask rules is normal', async () => {
    const r = await rig();
    await r.add(SID, { permissions: [{ action: '*', resource: '*', effect: 'allow' }] });
    await r.add(SID2, { permissions: [{ action: '*', resource: '*', effect: 'ask' }] });
    expect(r.rec.sessions.find((s) => s.key === `opencode:${SID}`)!.mode).toBe('bypass');
    expect(r.rec.sessions.find((s) => s.key === `opencode:${SID2}`)!.mode).toBe('normal');
  });
});

describe('OpenCode control: live tail', () => {
  it('reports the user\'s text, the assistant\'s finished text and one line per tool call; tool output as tool_out; never reasoning; nothing twice', async () => {
    const r = await rig(); const key = await r.add(SID);
    r.oc.sessions[0]!.messages = [{ id: 'msg_user00000001', type: 'user', time: { created: 1000 }, text: 'please list the files' }];
    r.oc.assistant(SID, [
      { type: 'reasoning', text: 'REASONING-CANARY the user wants a listing' },
      { type: 'text', text: 'Let me look.' },
      { type: 'tool', id: 'c1', name: 'bash', state: { status: 'completed', input: { command: 'ls -la', description: 'list' }, content: [{ type: 'text', text: 'a.txt\nb.txt' }] } },
      { type: 'text', text: 'There are two files.' },
    ]);
    await r.a.poll();
    const items = r.rec.tails.filter((t) => t.key === key).flatMap((t) => t.items);
    expect(items.map((i) => [i.k, i.text])).toEqual([
      ['user', 'please list the files'], ['assistant', 'Let me look.'], ['tool', 'bash: ls -la'], ['tool_out', 'a.txt\nb.txt'], ['assistant', 'There are two files.'],
    ]);
    expect(JSON.stringify(r.rec.tails)).not.toContain('REASONING-CANARY');
    await r.a.poll(); await r.a.poll();
    expect(r.rec.tails.filter((t) => t.key === key).flatMap((t) => t.items)).toHaveLength(5); // polling again adds nothing
  });

  it('holds back a text part that may still be streaming until the message is done, and picks it up later', async () => {
    const r = await rig(); const key = await r.add(SID);
    const m = r.oc.assistant(SID, [{ type: 'text', text: 'Working on' }], { done: false });
    await r.a.poll();
    expect(r.rec.tails.filter((t) => t.key === key)).toEqual([]);
    m.content = [{ type: 'text', text: 'Working on it, done.' }]; m.time.completed = Date.now(); r.oc.sessions[0]!.updated = Date.now() + 5;
    await r.a.poll();
    expect(r.rec.tails.filter((t) => t.key === key).flatMap((t) => t.items).map((i) => i.text)).toEqual(['Working on it, done.']);
  });

  it('a session that has just stopped is read once more, because its last message completes after the last poll that saw it running', async () => {
    const r = await rig(); const key = await r.add(SID, { running: true });
    const m = r.oc.assistant(SID, [{ type: 'text', text: 'Almost there' }], { done: false });
    await r.a.poll();
    expect(r.rec.tails.filter((t) => t.key === key)).toEqual([]);
    // the model finishes and the session goes idle without the session's own `updated` moving
    m.time.completed = Date.now(); r.oc.sessions[0]!.running = false;
    await r.a.poll();
    expect(r.rec.tails.filter((t) => t.key === key).flatMap((t) => t.items).map((i) => i.text)).toEqual(['Almost there']);
  });

  it('an errored turn shows one note; a running tool shows its call line only', async () => {
    const r = await rig(); const key = await r.add(SID);
    r.oc.assistant(SID, [{ type: 'tool', id: 'c1', name: 'edit', state: { status: 'running', input: { filePath: 'src/a.ts' }, metadata: {} } }], { done: false });
    r.oc.assistant(SID, [], { error: { type: 'ProviderAuthError', message: 'No credentials' } });
    await r.a.poll();
    expect(r.rec.tails.filter((t) => t.key === key).flatMap((t) => t.items).map((i) => [i.k, i.text])).toEqual([['tool', 'edit: src/a.ts'], ['note', 'OpenCode reported an error (ProviderAuthError): No credentials']]);
  });

  it('asks for the messages only of sessions that changed, and not at all with no paired device', async () => {
    const r = await rig(); await r.add(SID);
    const count = () => r.oc.requests.filter((x) => x.path.endsWith('/message')).length;
    expect(count()).toBe(1); // primed once
    await r.a.poll(); await r.a.poll();
    expect(count()).toBe(1); // nothing changed, nothing fetched
    r.rec.ctx.facts = () => ({ away: false, paused: false, relayOnline: true, devices: 0 });
    r.oc.assistant(SID, [{ type: 'text', text: 'later' }]);
    await r.a.poll();
    expect(count()).toBe(1);
  });

  it('message lines are plain strings with stable ids (unit)', () => {
    expect(messageLines({ id: 'm1', type: 'system', text: 'x', time: { created: 1 } }, 5)).toEqual([]);
    expect(messageLines({ id: 'm1', type: 'user', text: '  hi  ', time: { created: 1 } }, 5)).toEqual([{ id: 'm1:u', k: 'user', text: 'hi', ts: 1 }]);
    expect(messageLines(null, 5)).toEqual([]);
    expect(messageLines({ type: 'user', text: 'no id' }, 5)).toEqual([]);
  });
});

describe('OpenCode control: what may and may not go on the wire', () => {
  it('across every control operation: every request is on the allowlist, no body holds `always`, and no shell, command, terminal, file or credential route is touched', async () => {
    const r = await rig(); const key = await r.add(SID, { running: true });
    r.oc.forms.push({ id: 'frm_aaaa11112222', sessionID: SID, title: 'Q?', dir: r.root, fields: [{ key: 'q', type: 'string' }] });
    r.oc.perms.push({ id: 'per_aaaa1111', sessionID: SID, action: 'bash', resources: ['ls'], dir: r.root });
    await r.a.poll();
    const q = r.rec.pendings.find((p) => p.kind === 'question')?.native;
    const perm = r.rec.pendings.find((p) => p.kind === 'permission')!.native!;
    await r.a.sendPrompt(key, framed('an instruction with always and /shell in the text'), who);
    await r.a.interrupt(key, who);
    await r.a.startSession(launch(r), framed('go'), who);
    await r.a.startSession(launch(r, 'plan'), null, who);
    await r.a.deliver(perm, { t: 'permission', behavior: 'allow' }, who);
    if (q) await r.a.answerText(q, asControlText('x'), who);
    await r.a.settled();
    expect(r.oc.requests.length).toBeGreaterThan(15);
    for (const x of r.oc.requests) {
      expect(ALLOWED.some((a) => a.method === x.method && a.path.test(x.path)), `${x.method} ${x.path}`).toBe(true);
      expect(x.path, x.path).not.toMatch(/shell|\/command|pty|\/fs\/|worktree|config|credential|integration|synthetic|revert|fork|move|compact|rpc|\/agent|\/skill/);
      if (x.method === 'POST') {
        const b = JSON.stringify(x.body ?? null);
        if (/permission\/.*\/reply/.test(x.path)) expect(x.body).toEqual({ decision: 'once' });
        if (/\/prompt$/.test(x.path)) expect(Object.keys(x.body as object).sort()).toEqual(['delivery', 'text']);
        expect(b).not.toMatch(/"decision":"always"|"effect":"allow"/);
      }
    }
    expect(r.oc.replies.every((x) => (x.body as { decision: string }).decision === 'once' || (x.body as { decision: string }).decision === 'reject')).toBe(true);
    // the host's text is delivered exactly; the adapter added nothing to it
    expect(r.oc.prompts.map((p) => (p.body as { text: string }).text)[0]).toBe(framed('an instruction with always and /shell in the text').framed);
  });

  it('the adapter refuses to build a request outside its allowlist (a forged route throws before any socket is opened)', async () => {
    const r = await rig();
    const http = (r.a as unknown as { http(m: string, p: string, b?: unknown): Promise<unknown> }).http.bind(r.a);
    for (const [m, p] of [['POST', '/api/shell'], ['POST', `/api/session/${SID}/command`], ['GET', '/api/fs/read/etc/passwd'], ['POST', '/api/pty'], ['POST', `/api/session/${SID}/permission/per_aaaa1111/always`], ['GET', '/api/credential']] as const) {
      const n = r.oc.requests.length;
      await expect(http(m, p, {}), `${m} ${p}`).rejects.toThrow('request not allowed');
      expect(r.oc.requests.length).toBe(n);
    }
  });

  it('adapter source: the only text it hands an agent is a ControlPrompt\'s framed text or a ControlText; no helper makes text', () => {
    const src = readFileSync(fileURLToPath(new URL('../src/adapters/opencode/adapter.ts', import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    expect(src).not.toMatch(/asControlText|asPreset|as ControlText|as PresetText/);
    expect(src).toMatch(/promptNow\(sessionKey, sid, p\.framed\)/);
    expect(src).toMatch(/text\.framed/);
  });
});

describe('OpenCode control through the real host (paired phone, scope control)', () => {
  let cw: ControlWorld | null = null; let oc: FakeOpenCode | null = null; let root = '';
  afterEach(async () => { await cw?.close(); cw = null; await oc?.close(); oc = null; if (root) rmSync(root, { recursive: true, force: true }); root = ''; });

  async function boot(): Promise<{ cw: ControlWorld; oc: FakeOpenCode; adapter: OpenCodeAdapter; root: string }> {
    oc = await fakeOpenCode();
    root = mkdtempSync(join(tmpdir(), 'bwc-ochost-'));
    cw = await controlWorld({ world: { opencodeEnv: { [PASS]: oc.password! } }, control: { launch: [{ id: 'oc-main', label: 'Main project', harness: 'opencode', root, modes: ['default', 'plan'] }] } });
    const c = cw.w.daemon.store.config();
    cw.w.setConfig({ adapters: { ...c.adapters, opencode: { enabled: true, port: oc.port, passwordEnv: PASS } } });
    const adapter = cw.w.daemon.host.hub.get('opencode') as OpenCodeAdapter;
    return { cw, oc, adapter, root };
  }
  const shown = async (c: ControlWorld, o: FakeOpenCode, a: OpenCodeAdapter, sid: string): Promise<{ sid: string; bind: () => Promise<string> }> => {
    o.sessions.push({ id: sid, dir: root });
    await a.poll();
    const s = await waitFor(() => c.w.daemon.host.sessions.byKey(`opencode:${sid}`));
    const ctl = await c.phone.waitFor(() => c.phone.latest?.sessions.find((x) => x.sid === s.sid)?.ctl).catch((e) => { throw new Error(`no ctl: ${JSON.stringify(c.phone.latest?.sessions)} audit=${c.w.daemon.store.auditTail(8).join('|')} ${String(e)}`); });
    expect(ctl).toMatchObject({ route: 'api', can: { prompt: true, interrupt: true, tail: true } });
    return { sid: s.sid, bind: async () => (await c.phone.waitFor(() => c.phone.latest?.sessions.find((x) => x.sid === s.sid)?.ctl?.bind))! };
  };

  it('prompt: the phone sends text, the owner confirms at the computer, OpenCode receives the framed text and the outcome is applied; interrupt stops it', async () => {
    const b = await boot();
    const s = await shown(b.cw, b.oc, b.adapter, SID);
    const cid = await b.cw.phone.cmd('prompt', { sid: s.sid, bind: await s.bind(), text: 'Please add a unit test.' });
    const r = await b.cw.phone.result(cid);
    expect(r).toMatchObject({ kind: 'prompt', outcome: 'applied' });
    expect(b.oc.prompts).toHaveLength(1);
    const text = (b.oc.prompts[0]!.body as { text: string }).text;
    expect(text).toContain('Botwarren Companion'); expect(text).toContain('Sim phone'); expect(text.endsWith('Please add a unit test.')).toBe(true);
    expect(b.cw.asked.at(-1)).toMatchObject({ kind: 'prompt', preview: 'Please add a unit test.' });
    // the session is running now (the server says so); stop it
    await b.adapter.poll();
    const cid2 = await b.cw.phone.cmd('interrupt', { sid: s.sid, bind: await s.bind() });
    expect(await b.cw.phone.result(cid2)).toMatchObject({ kind: 'interrupt', outcome: 'applied' });
    expect(b.oc.interrupts).toEqual([SID]);
  });

  it('start: a launch entry from the host\'s table creates a session in its folder and the phone is told the new session', async () => {
    const b = await boot();
    const cid = await b.cw.phone.cmd('start', { launchId: 'oc-main', mode: 'plan', text: 'Explore the repo.' });
    const r = await b.cw.phone.result(cid);
    expect(r).toMatchObject({ kind: 'start', outcome: 'applied' });
    expect(r.sid).toBeTruthy();
    expect(b.oc.created).toEqual([{ location: { directory: b.root }, agent: 'plan', permissions: [{ action: '*', resource: '*', effect: 'ask' }] }]);
    expect((b.oc.prompts[0]!.body as { text: string }).text.endsWith('Explore the repo.')).toBe(true);
    // a launch id or mode the host did not list is refused before the adapter is asked
    const bad = await b.cw.phone.result(await b.cw.phone.cmd('start', { launchId: 'oc-main', mode: 'acceptEdits' }));
    expect(bad).toMatchObject({ outcome: 'refused', why: 'mode_not_allowed' });
    expect(b.oc.created).toHaveLength(1);
  });

  it('free-text answer: a one-line question shows as answerable, the answer reaches the exact form, and the card clears', async () => {
    const b = await boot();
    const s = await shown(b.cw, b.oc, b.adapter, SID);
    b.oc.forms.push({ id: 'frm_aaaa11112222', sessionID: SID, title: 'Which branch should I use?', dir: b.root, fields: [{ key: 'branch', type: 'string' }] });
    await b.adapter.poll();
    const card = await b.cw.phone.waitFor(() => { const x = b.cw.phone.latest?.sessions.find((y) => y.sid === s.sid); return x?.pending?.kind === 'question' && x.ctl?.can.text ? x : undefined; });
    const cid = await b.cw.phone.cmd('answer', { sid: s.sid, rid: card.pending!.rid, bind: card.pending!.bind, text: 'release/2.1' });
    expect(await b.cw.phone.result(cid)).toMatchObject({ kind: 'answer', outcome: 'applied' });
    expect(b.oc.formReplies).toEqual([{ id: 'frm_aaaa11112222', body: { answer: { branch: 'release/2.1' } } }]);
  });

  it('tail: the assistant\'s words reach a watching phone, tool output does not unless the owner turned it on; reasoning never', async () => {
    const b = await boot();
    const s = await shown(b.cw, b.oc, b.adapter, SID);
    await b.cw.phone.send('watch', { sid: s.sid, on: true });
    b.oc.assistant(SID, [{ type: 'reasoning', text: 'REASONING-CANARY' }, { type: 'tool', id: 'c', name: 'bash', state: { status: 'completed', input: { command: 'cat secrets.txt' }, content: [{ type: 'text', text: 'TOOL-OUTPUT-CANARY' }] } }, { type: 'text', text: 'All done here.' }]);
    await b.adapter.poll();
    const tail = await b.cw.phone.waitFor(() => b.cw.phone.tails.find((t) => t.entries.some((e) => e.text === 'All done here.')));
    const all = JSON.stringify(tail);
    expect(all).toContain('bash: cat secrets.txt');
    expect(all).not.toContain('TOOL-OUTPUT-CANARY');
    expect(all).not.toContain('REASONING-CANARY');
  });
});

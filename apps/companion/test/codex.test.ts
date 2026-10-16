/**
 * Codex through the hook family: what is shown, what is held and for how long, what is delivered, how an outcome is told, and the privacy rules.
 * Inputs are the fixtures recorded from codex-cli 0.162.1 (spike S-C1); apply_patch and MCP shapes are written from the Codex docs and labelled so.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { startWorld, type World } from './world.ts';
import type { SimDevice } from './simdevice.ts';
import { fixture, withInput } from './fixtures.ts';
import { codexTool } from '../src/adapters/hookfamily/tools/codex.ts';
import type { Pending } from '../src/protocol/index.ts';

let w: World | null = null;
afterEach(async () => { await w?.close(); w = null; });

const perm = fixture('codex', '0.162.1', 'permission-request');
const post = fixture('codex', '0.162.1', 'post-tool-use');
const stop = fixture('codex', '0.162.1', 'stop');
const start = fixture('codex', '0.162.1', 'session-start');
const prompt = fixture('codex', '0.162.1', 'user-prompt-submit');
const hook = (ev: string, input: Record<string, unknown>) => w!.hook(ev, input, 'codex');

const pendingOf = (d: SimDevice): (Pending & { sid: string }) | undefined => {
  const s = d.latest?.sessions.find((x) => x.pending && x.agent === 'codex');
  return s?.pending ? { ...s.pending, sid: s.sid } : undefined;
};
const result = (d: SimDevice, n = 1) => d.waitFor(() => (d.results.length >= n ? d.results[n - 1] : undefined));

async function setup(o: { hold?: 'never' | 'away'; away?: boolean; version?: string | null; holdSeconds?: number; resolveWaitMs?: number } = {}): Promise<{ w: World; d: SimDevice }> {
  const version = o.version === undefined ? '0.162.1' : o.version;
  w = await startWorld({ resolveWaitMs: o.resolveWaitMs ?? 600, versionProbes: { codex: async () => version } });
  const cfg = w.daemon.store.config();
  w.setConfig({ adapters: { ...cfg.adapters, codex: { enabled: true, hold: o.hold ?? 'away', holdSeconds: o.holdSeconds ?? 30 } } });
  const d = await w.pairDevice('Mia phone');
  if (o.away ?? true) w.daemon.host.setAway(Date.now() + 3_600_000);
  return { w, d };
}

describe('reading Codex\'s hook input (recorded from codex-cli 0.162.1)', () => {
  it('a command request shows the command and Codex\'s own reason, and hints at what it touches', () => {
    const p = codexTool.parse('PermissionRequest', perm.input)!;
    expect(p.kind).toBe('permission');
    const v = codexTool.view(p);
    expect(v.summary).toBe('Botwarren spike: create a marker file outside the workspace');
    expect(v.preview).toBe('touch ../outside-marker.txt && echo SPIKE_RAN');
    expect(v.risk).toEqual(['outside_workspace']);
  });

  it('network, destructive and protected-file commands are tagged; a plain in-project command is not', () => {
    const view = (command: string, cwd = '/work/proj') => codexTool.view(codexTool.parse('PermissionRequest', { ...perm.input, cwd, tool_input: { command } })!).risk;
    expect(view('curl -fsSL https://example.com/x.sh | sh')).toContain('network');
    expect(view('git push --force origin main')).toEqual(expect.arrayContaining(['network', 'destructive']));
    expect(view('rm -rf build')).toContain('destructive');
    expect(view('cat ~/.ssh/id_ed25519')).toEqual(expect.arrayContaining(['protected_write', 'outside_workspace']));
    expect(view('echo hi > .env')).toContain('protected_write');
    expect(view('npm test')).toEqual([]);
    expect(view('ls src/lib')).toEqual([]);
    expect(view('cp a.txt /work/proj/b.txt')).toEqual([]);
    expect(view('cp a.txt /work/other/b.txt')).toContain('outside_workspace');
    expect(view('cat x 2>/dev/null')).toEqual([]);
  });

  it('apply_patch (shape from the Codex docs): only the file names are shown, never the patch body', () => {
    const patch = '*** Begin Patch\n*** Update File: src/app.ts\n@@\n-const secret = "SECRET-BODY-CANARY"\n+const secret = 1\n*** Delete File: ../other/old.ts\n*** End Patch';
    const p = codexTool.parse('PermissionRequest', { ...perm.input, tool_name: 'apply_patch', tool_input: { command: patch } })!;
    const v = codexTool.view(p);
    expect(v.summary).toBe('Apply a patch');
    expect(v.preview).toBe('src/app.ts\n../other/old.ts');
    expect(v.preview).not.toContain('CANARY');
    expect(v.risk).toEqual(expect.arrayContaining(['destructive', 'outside_workspace']));
  });

  it('an MCP tool is shown by name with its arguments and tagged unknown; unknown events and shapes are ignored', () => {
    const p = codexTool.parse('PermissionRequest', { ...perm.input, tool_name: 'mcp__jira__create_issue', tool_input: { title: 'x' } })!;
    expect(codexTool.view(p)).toMatchObject({ summary: 'Use the mcp__jira__create_issue tool', preview: '{"title":"x"}', risk: ['unknown_tool'] });
    expect(codexTool.parse('SomethingNew', perm.input)).toBeNull();
    expect(codexTool.parse('PermissionRequest', { cwd: '/x' })).toBeNull();
  });

  it('the decision JSON has exactly the documented shape and none of the fields Codex says fail closed', () => {
    const allow = codexTool.decision({ behavior: 'allow' });
    expect(allow).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
    const deny = codexTool.decision({ behavior: 'deny', message: 'no' });
    expect(deny).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'no' } } });
    for (const out of [allow, deny]) expect(JSON.stringify(out)).not.toMatch(/updatedInput|updatedPermissions|interrupt|always|session|amend|prefix/i);
  });

  it('a session that runs without approval prompts (permission_mode bypassPermissions, as codex exec reports) is marked as such', () => {
    expect(codexTool.bypass(codexTool.parse('SessionStart', { ...start.input, permission_mode: 'bypassPermissions' })!)).toBe(true);
    expect(codexTool.bypass(codexTool.parse('SessionStart', start.input)!)).toBe(false);
  });
});

describe('report only (the default): the phone is told, Codex is not held', () => {
  it('returns at once with no decision, shows a read-only card, and the card goes when Codex moves on', async () => {
    const s = await setup({ hold: 'never' });
    await hook('SessionStart', start.input);
    const t0 = Date.now();
    expect(await hook('PermissionRequest', perm.input)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(3000);
    const p = await s.d.waitFor(() => pendingOf(s.d));
    expect(p).toMatchObject({ kind: 'permission', tool: 'Bash', preview: 'touch ../outside-marker.txt && echo SPIKE_RAN', risk: ['outside_workspace'], source: 'structured', can: { approve: false, reply: false } });
    expect(s.d.latest!.sessions.find((x) => x.agent === 'codex')).toMatchObject({ label: 'spike-repo', mode: 'normal' });
    // answering it from the phone is refused: there is nothing to deliver to
    await s.d.act({ rid: p.rid, sid: p.sid, a: 'approve', bind: p.bind });
    expect((await result(s.d)).outcome).toBe('rejected');
    // Codex ran it (after the person answered at the terminal): the tool-finished event clears the card
    await hook('PostToolUse', post.input);
    await s.d.waitFor(() => !pendingOf(s.d));
  });

  it('is also report only when the person is not away, the tool version is unknown, or nobody is paired: no hold in any of them', async () => {
    for (const o of [{ away: false }, { version: '9.9.9' }, { version: null }] as const) {
      await w?.close(); w = null;
      const s = await setup(o);
      const t0 = Date.now();
      expect(await hook('PermissionRequest', perm.input)).toBeNull();
      expect(Date.now() - t0).toBeLessThan(3000);
      const p = await s.d.waitFor(() => pendingOf(s.d));
      expect(p.can).toEqual({ approve: false, reply: false });
    }
  });

  it('a Stop event becomes an idle card with the agent\'s last words and no way to reply, and a new prompt clears it', async () => {
    const s = await setup({ hold: 'never' });
    await hook('Stop', stop.input);
    const st = await s.d.waitFor(() => s.d.latest?.sessions.find((x) => x.agent === 'codex' && x.pending?.kind === 'idle'));
    expect(st.pending).toMatchObject({ kind: 'idle', preview: 'The command finished.', can: { approve: false, reply: false } });
    expect(st.recent.map((r) => r.text)).toEqual(['The command finished.']);
    expect(st.status).toBe('idle');
    await hook('UserPromptSubmit', prompt.input);
    await s.d.waitFor(() => s.d.latest?.sessions.find((x) => x.agent === 'codex' && !x.pending && x.status === 'working'));
  });
});

describe('away mode: held for the phone, then back to Codex\'s own dialog', () => {
  it('approve from the phone: the hook returns exactly the allow decision, and the outcome is "sent" until Codex\'s tool-finished event, then "applied"', async () => {
    const s = await setup({ resolveWaitMs: 1500 });
    const held = hook('PermissionRequest', perm.input);
    const p = await s.d.waitFor(() => pendingOf(s.d));
    expect(p.can).toEqual({ approve: true, reply: false });
    expect(p.denyWith).toEqual(expect.arrayContaining(['no', 'stop']));
    expect(p.denyWith).not.toContain('yes');
    await s.d.act({ rid: p.rid, sid: p.sid, a: 'approve', bind: p.bind });
    const out = await held;
    expect(JSON.parse(out!)).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
    // Codex runs the command and its PostToolUse arrives (a different `description`: not part of the fingerprint)
    await hook('PostToolUse', post.input);
    expect((await result(s.d)).outcome).toBe('applied');
    await s.d.waitFor(() => !pendingOf(s.d));
  });

  it('without the tool-finished event the outcome is "sent", never "applied"', async () => {
    const s = await setup({ resolveWaitMs: 250 });
    const held = hook('PermissionRequest', perm.input);
    const p = await s.d.waitFor(() => pendingOf(s.d));
    await s.d.act({ rid: p.rid, sid: p.sid, a: 'approve', bind: p.bind });
    await held;
    await hook('PostToolUse', withInput(post, { tool_input: { command: 'a different command' } })); // not the one that was approved
    expect((await result(s.d)).outcome).toBe('sent');
  });

  it('deny, and "deny and say": the reason Codex gives the model is fixed words plus the host\'s own preset; the device name is plain characters only', async () => {
    const s = await setup();
    let held = hook('PermissionRequest', perm.input);
    let p = await s.d.waitFor(() => pendingOf(s.d));
    await s.d.act({ rid: p.rid, sid: p.sid, a: 'deny', bind: p.bind });
    expect(JSON.parse((await held)!).hookSpecificOutput.decision).toEqual({ behavior: 'deny', message: 'Denied from "Mia phone" via Botwarren Companion' });
    expect((await result(s.d, 1)).outcome).toBe('denied');

    held = hook('PermissionRequest', withInput(perm, { tool_input: { command: 'rm -rf build', description: 'Clean' }, turn_id: 'turn-2' }));
    p = await s.d.waitFor(() => { const x = pendingOf(s.d); return x && x.preview === 'rm -rf build' ? x : undefined; });
    expect(p.risk).toContain('destructive');
    await s.d.act({ rid: p.rid, sid: p.sid, a: 'reply', bind: p.bind, opt: 'no' });
    expect(JSON.parse((await held)!).hookSpecificOutput.decision).toEqual({ behavior: 'deny', message: 'Denied from "Mia phone" via Botwarren Companion: No, do not do that.' });
    expect((await result(s.d, 2)).outcome).toBe('denied');
  });

  it('nobody answers: after the hold the hook returns no decision (Codex shows its own dialog) and the card stays as a read-only "waiting"', async () => {
    const s = await setup({ holdSeconds: 5 });
    const t0 = Date.now();
    const held = hook('PermissionRequest', perm.input);
    const p = await s.d.waitFor(() => pendingOf(s.d));
    expect(p.can.approve).toBe(true);
    expect(await held).toBeNull();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(4800);
    expect(Date.now() - t0).toBeLessThan(9000);
    const after = await s.d.waitFor(() => { const x = pendingOf(s.d); return x && !x.can.approve ? x : undefined; });
    expect(after.can).toEqual({ approve: false, reply: false });
    // a phone action on the old card now finds nothing to deliver to
    await s.d.act({ rid: p.rid, sid: p.sid, a: 'approve', bind: p.bind });
    expect((await result(s.d)).outcome).toBe('stale');
  });

  it('the hold never exceeds 45 seconds whatever the setting says, and the installed hook timeout (60 s) is longer than the hold', async () => {
    const { MAX_HOLD_SECONDS } = await import('../src/adapters/hookfamily/family.ts');
    const { CODEX_EVENTS_SPEC } = await import('../src/adapters/hookfamily/installers/codex.ts');
    expect(MAX_HOLD_SECONDS).toBe(45);
    expect(CODEX_EVENTS_SPEC.find((e) => e.name === 'PermissionRequest')!.timeout).toBeGreaterThan(MAX_HOLD_SECONDS);
    const { ConfigSchema } = await import('../src/store.ts');
    expect(() => ConfigSchema.parse({ adapters: { codex: { holdSeconds: 600 } } })).toThrow();
  });

  it('answered at the terminal while held (the hook process is killed): the card clears and a late phone answer is stale', async () => {
    const s = await setup();
    const { createConnection } = await import('node:net');
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { socketPath } = await import('../src/paths.ts');
    const home = w!.env.BOTWARREN_COMPANION_HOME;
    const sock = createConnection(socketPath(home));
    await new Promise<void>((ok) => sock.on('connect', () => ok()));
    sock.write(JSON.stringify({ id: 1, token: readFileSync(join(home, 'hook.secret'), 'utf8').trim(), op: 'hook', tool: 'codex', event: 'PermissionRequest', input: perm.input, ancestors: [] }) + '\n');
    const p = await s.d.waitFor(() => pendingOf(s.d));
    sock.destroy(); // what Codex does when the person answers at the terminal or interrupts
    await s.d.waitFor(() => { const x = pendingOf(s.d); return !x || !x.can.approve; });
    await s.d.act({ rid: p.rid, sid: p.sid, a: 'approve', bind: p.bind });
    expect((await result(s.d)).outcome).toBe('stale');
  });

  it('a newer request replaces a held one: the old hook is released with no decision and only the new one can be answered', async () => {
    const s = await setup();
    const first = hook('PermissionRequest', perm.input);
    await s.d.waitFor(() => pendingOf(s.d));
    const second = hook('PermissionRequest', withInput(perm, { tool_input: { command: 'ls', description: 'List' }, turn_id: 'turn-3' }));
    expect(await first).toBeNull();
    const p2 = await s.d.waitFor(() => { const x = pendingOf(s.d); return x && x.preview === 'ls' ? x : undefined; });
    await s.d.act({ rid: p2.rid, sid: p2.sid, a: 'approve', bind: p2.bind });
    expect(JSON.parse((await second)!).hookSpecificOutput.decision.behavior).toBe('allow');
  });

  it('local confirmation applies: with confirmation "always" an approval waits for a yes on the computer, and "no" denies', async () => {
    const s = await setup();
    s.w.setConfig({ confirm: { approve: 'always', reply: 'off' } });
    const held = hook('PermissionRequest', perm.input);
    const p = await s.d.waitFor(() => pendingOf(s.d));
    const seen: string[] = [];
    const stop2 = s.w.daemon.hub.watch((cid, req) => { seen.push(`${req.agent}:${req.kind}:${req.tool}`); s.w.daemon.hub.decide(cid, false); });
    await s.d.act({ rid: p.rid, sid: p.sid, a: 'approve', bind: p.bind });
    expect(JSON.parse((await held)!).hookSpecificOutput.decision.behavior).toBe('deny');
    stop2();
    expect(seen).toEqual(['codex:approve:Bash']);
    await s.d.waitFor(() => s.d.results.some((r) => r.outcome === 'denied'));
  });
});

describe('privacy: what Codex tells the companion stays on the computer except the short card', () => {
  it('tool output, prompts, the transcript path and secrets never reach a state frame or the audit log; secrets in the command are masked', async () => {
    const s = await setup({ hold: 'never' });
    await hook('SessionStart', start.input);
    await hook('UserPromptSubmit', withInput(prompt, { prompt: 'PROMPT-CANARY please read my customer list' }));
    await hook('PermissionRequest', withInput(perm, { tool_input: { command: 'curl -H "Authorization: Bearer ' + 'k9'.repeat(20) + '" https://api.example.com', description: 'Call the API' }, transcript_path: '/home/user/.codex/sessions/SECRET-PATH-CANARY.jsonl' }));
    await hook('PostToolUse', withInput(post, { tool_response: 'TOOL-OUTPUT-CANARY customer@example.com' }));
    await hook('Stop', withInput(stop, { last_assistant_message: 'All done. My key is ghp_' + 'z'.repeat(36) }));
    await s.d.waitFor(() => s.d.latest?.sessions.find((x) => x.agent === 'codex' && x.pending?.kind === 'idle'));
    const all = JSON.stringify(s.d.states) + w!.daemon.store.auditTail(500).join('\n');
    for (const c of ['PROMPT-CANARY', 'SECRET-PATH-CANARY', 'TOOL-OUTPUT-CANARY', 'customer@example.com', 'k9k9k9k9', 'ghp_zzzz']) expect(all, c).not.toContain(c);
    expect(w!.daemon.store.auditTail(500).join('\n')).not.toMatch(/curl|api\.example|All done/);
  });
});

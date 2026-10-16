/**
 * Muse through the hook family and a generated plugin. The inputs are RECORDINGS from a real, logged-in Muse Code 1.4.9 TUI in the lab (fixtures `observed`).
 * What the lab showed (see tools/muse.ts): PermissionRequest fires for every evaluated call and mostly resolves at once; only an escalated request waits for a person;
 * a hook DENY works; a hook ALLOW is ignored for that request. So Muse can be denied from the phone and never approved, and only on the verified version.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { startWorld, type World } from './world.ts';
import type { SimDevice } from './simdevice.ts';
import { fixture, withInput } from './fixtures.ts';
import { museTool, MUSE_MANIFEST } from '../src/adapters/hookfamily/tools/muse.ts';
import { MUSE_HOOKS, MUSE_PLUGIN_ID, MUSE_PLUGIN_VERSION, musePluginManifest } from '../src/adapters/hookfamily/installers/muse.ts';
import type { Pending } from '../src/protocol/index.ts';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let w: World | null = null;
afterEach(async () => { await w?.close(); w = null; });

const perm = fixture('muse', '1.4.9', 'permission-request');
const escal = fixture('muse', '1.4.9', 'permission-request-escalated');
const fail = fixture('muse', '1.4.9', 'post-tool-use-failure');
const reminder = fixture('muse', '1.4.9', 'post-tool-use-reminder');
const stop = fixture('muse', '1.4.9', 'stop');
const note = fixture('muse', '1.4.9', 'notification');
const start = fixture('muse', '1.4.9', 'session-start');
const harness = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/muse/1.4.9/hook-test-results.json', import.meta.url)), 'utf8')) as { results: { stdout: string }[] };
const hook = (ev: string, input: Record<string, unknown>) => w!.hook(ev, input, 'muse');
const pendingOf = (d: SimDevice): (Pending & { sid: string }) | undefined => { const s = d.latest?.sessions.find((x) => x.pending && x.agent === 'muse'); return s?.pending ? { ...s.pending, sid: s.sid } : undefined; };
const result = (d: SimDevice, n = 1) => d.waitFor(() => (d.results.length >= n ? d.results[n - 1] : undefined));

async function setup(o: { version?: string; hold?: 'never' | 'away'; resolveWaitMs?: number } = {}): Promise<{ w: World; d: SimDevice }> {
  w = await startWorld({ resolveWaitMs: o.resolveWaitMs ?? 600, versionProbes: { muse: async () => o.version ?? '1.4.9' } });
  const cfg = w.daemon.store.config();
  w.setConfig({ adapters: { ...cfg.adapters, muse: { enabled: true, hold: o.hold ?? 'away', holdSeconds: 30, verifiedVersions: [] } } });
  const d = await w.pairDevice();
  w.daemon.host.setAway(Date.now() + 3_600_000);
  return { w, d };
}

describe('Muse input and decision (recorded from a real Muse 1.4.9)', () => {
  it('the decision is exactly what Muse accepted for allow and deny, and carries nothing Muse rejects', () => {
    expect(JSON.stringify(museTool.decision({ behavior: 'allow' }))).toBe(harness.results[0]!.stdout);
    expect(JSON.stringify(museTool.decision({ behavior: 'deny', message: 'Spike deny message' }))).toBe(harness.results[1]!.stdout);
    expect(harness.results[2]!.stdout).toContain('updatedPermissions');
    expect(JSON.stringify(museTool.decision({ behavior: 'allow' }))).not.toMatch(/updated|interrupt|always|session|persist/i);
  });

  it('reads the real request: the command, Muse\'s own description, no hint for a command inside the project; only the escalated request is holdable', () => {
    const p = museTool.parse('PermissionRequest', perm.input)!;
    const v = museTool.view(p);
    expect(v.summary).toBe('Create marker file');
    expect(v.preview).toMatch(/^touch \/work\/marker-/);
    expect(museTool.holdable!(p)).toBe(false); // evaluated and resolved by Muse itself
    expect(museTool.holdable!(museTool.parse('PermissionRequest', escal.input)!)).toBe(true); // sandbox_permissions: require_escalated: really waits for a person
    expect(museTool.approveEffective).toBe(false);
  });

  it('ignores Muse\'s own helper-tool events (they come from separate sessions), stale requests (post_stop) and unknown events', () => {
    expect(museTool.parse('PostToolUse', reminder.input)).toBeNull();
    expect(museTool.parse('PermissionRequest', { ...escal.input, post_stop: true })).toBeNull();
    expect(museTool.parse('Whatever', perm.input)).toBeNull();
    expect(museTool.parse('PostToolUseFailure', fail.input)!.kind).toBe('post');
    expect(museTool.bypass(museTool.parse('SessionStart', { ...start.input, permission_mode: 'allowAll' })!)).toBe(true);
    expect(museTool.bypass(museTool.parse('SessionStart', start.input)!)).toBe(false);
  });

  it('is pinned to the verified version, can only deny, and a Muse-flagged request still counts as risky', () => {
    expect(MUSE_MANIFEST.verified.versions).toEqual(['1.4.9']);
    expect(MUSE_MANIFEST.caps).toMatchObject({ approve: false, deny: true, presetReply: true });
    expect(MUSE_MANIFEST.confirmFloor).toEqual({ approve: 'risky', reply: 'off' });
    const f = museTool.view(museTool.parse('PermissionRequest', { ...escal.input, tool_input: { path: '.env', protectedWrite: true, judgeEscalated: true } })!);
    expect(f.risk).toEqual(expect.arrayContaining(['protected_write', 'escalated']));
  });
});

describe('Muse plugin manifest', () => {
  const m = JSON.parse(musePluginManifest({ node: '/usr/bin/node', script: '/h/.config/botwarren-companion/launch.mjs' })) as { schemaVersion: number; version: string; compat: unknown; capabilities: { hooks: { id: string; event: string; command: string[]; timeoutMs: number; async?: boolean }[] } };
  it('hooks are command arrays (no shell) that run the stable launcher with the tool and marker, and the version never follows the companion\'s', () => {
    expect(m.schemaVersion).toBe(1);
    expect(m.version).toBe(MUSE_PLUGIN_VERSION);
    expect(m.compat).toEqual({ source: 'native', manifestDir: '.muse-plugin' });
    expect(m.capabilities.hooks.map((h) => h.event)).toEqual(MUSE_HOOKS.map((h) => h.event));
    for (const h of m.capabilities.hooks) {
      expect(h.command.slice(0, 3)).toEqual(['/usr/bin/node', '--disable-warning=ExperimentalWarning', '/h/.config/botwarren-companion/launch.mjs']);
      expect(h.command.slice(3)).toEqual(['hook', h.event, '--tool', 'muse', '--bw-companion']);
    }
    expect(m.capabilities.hooks.find((h) => h.event === 'PermissionRequest')).toMatchObject({ timeoutMs: 60_000 });
    expect(m.capabilities.hooks.find((h) => h.event === 'PermissionRequest')!.async).toBeUndefined();
    expect(m.capabilities.hooks.find((h) => h.event === 'Interrupt')!.async).toBe(true); // Muse refuses a synchronous cancellation hook (found by the live plugin test)
    expect(MUSE_PLUGIN_ID).toBe('botwarren-companion');
  });
});

describe('Muse on the phone', () => {
  it('a request Muse resolves itself is reported and NOT held: the hook returns at once and the card is read-only', async () => {
    const s = await setup();
    const t0 = Date.now();
    expect(await hook('PermissionRequest', perm.input)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(3000);
    const p = await s.d.waitFor(() => pendingOf(s.d));
    expect(p).toMatchObject({ tool: 'bash', summary: 'Create marker file', can: { approve: false, reply: false } });
    expect(p.can.deny).toBeUndefined();
  });

  it('an escalated request is held while away and can be DENIED from the phone (the exact deny JSON), never approved; "deny and say" works', async () => {
    const s = await setup();
    let held = hook('PermissionRequest', escal.input);
    let p = await s.d.waitFor(() => { const x = pendingOf(s.d); return x?.can.deny ? x : undefined; });
    expect(p.can).toEqual({ approve: false, reply: false, deny: true });
    expect(p.denyWith).toEqual(expect.arrayContaining(['no', 'stop']));
    // approving is refused: Muse would ignore it
    await s.d.act({ rid: p.rid, sid: p.sid, a: 'approve', bind: p.bind });
    expect((await result(s.d, 1)).outcome).toBe('rejected');
    await s.d.act({ rid: p.rid, sid: p.sid, a: 'deny', bind: p.bind });
    expect(JSON.parse((await held)!)).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Denied from "Sim phone" via Botwarren Companion' } } });
    expect((await result(s.d, 2)).outcome).toBe('denied');

    held = hook('PermissionRequest', withInput(escal, { turn_id: 'turn-2', tool_input: { command: 'rm -rf build', description: 'Clean', sandbox_permissions: 'require_escalated' } }));
    p = await s.d.waitFor(() => { const x = pendingOf(s.d); return x && x.preview === 'rm -rf build' && x.can.deny ? x : undefined; });
    expect(p.risk).toContain('destructive');
    await s.d.act({ rid: p.rid, sid: p.sid, a: 'reply', bind: p.bind, opt: 'stop' });
    expect(JSON.parse((await held)!).hookSpecificOutput.decision).toEqual({ behavior: 'deny', message: 'Denied from "Sim phone" via Botwarren Companion: Please stop and wait for me to return.' });
  });

  it('a phone that only knows protocol 1 gets a card it can parse (no deny key) that says to answer on the computer', async () => {
    w = await startWorld({ resolveWaitMs: 600, versionProbes: { muse: async () => '1.4.9' } });
    const cfg = w.daemon.store.config();
    w.setConfig({ adapters: { ...cfg.adapters, muse: { enabled: true, hold: 'away', holdSeconds: 30, verifiedVersions: [] } } });
    const d = await w.pairDevice('old', { proto: 1 });
    w.daemon.host.setAway(Date.now() + 3_600_000);
    void hook('PermissionRequest', escal.input);
    await new Promise((r) => setTimeout(r, 800));
    // muse is a proto 2 kind: an old phone is not shown the session at all
    expect(d.latest?.sessions.some((x) => x.agent === 'muse')).toBeFalsy();
  });

  it('an unverified Muse version is shown read-only: nothing is held and nothing can be answered', async () => {
    const s = await setup({ version: '1.4.10' });
    const t0 = Date.now();
    expect(await hook('PermissionRequest', escal.input)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(3000);
    const p = await s.d.waitFor(() => pendingOf(s.d));
    expect(p.can).toEqual({ approve: false, reply: false });
  });

  it('Muse\'s own "needs a human" notification makes a read-only card, and never replaces a request that is being held', async () => {
    const s = await setup();
    await hook('Notification', note.input);
    const c = await s.d.waitFor(() => pendingOf(s.d));
    expect(c).toMatchObject({ kind: 'permission', summary: expect.stringContaining('waiting for approval'), can: { approve: false, reply: false } });
    const held = hook('PermissionRequest', escal.input);
    const p = await s.d.waitFor(() => { const x = pendingOf(s.d); return x?.can.deny ? x : undefined; });
    await hook('Notification', note.input);
    await new Promise((r) => setTimeout(r, 300));
    expect(pendingOf(s.d)!.rid).toBe(p.rid);
    await s.d.act({ rid: p.rid, sid: p.sid, a: 'deny', bind: p.bind });
    expect(JSON.parse((await held)!).hookSpecificOutput.decision.behavior).toBe('deny');
  });

  it('idle card with the agent\'s last words; the helper-tool session creates no card; prompts, tool output and paths never reach the phone', async () => {
    const s = await setup({ hold: 'never' });
    await hook('SessionStart', start.input);
    await hook('UserPromptSubmit', withInput(perm, { hook_event_name: 'UserPromptSubmit', prompt: 'MUSE-PROMPT-CANARY' }));
    await hook('PostToolUse', reminder.input);
    await hook('PostToolUseFailure', withInput(fail, { error: 'MUSE-OUTPUT-CANARY bwrap: boom' }));
    await hook('Stop', stop.input);
    const st = await s.d.waitFor(() => s.d.latest?.sessions.find((x) => x.agent === 'muse' && x.pending?.kind === 'idle'));
    expect(st.pending!.preview.length).toBeGreaterThan(0);
    expect(st.pending).toMatchObject({ can: { approve: false, reply: false } });
    expect(s.d.latest!.sessions.filter((x) => x.agent === 'muse')).toHaveLength(1); // the reminder helper's own session id made no phantom card
    const all = JSON.stringify(s.d.states) + w!.daemon.store.auditTail(300).join('\n');
    expect(all).not.toContain('CANARY');
  });
});

/**
 * Ninox (read-only forever: the "No approval prompts" badge) and agy (read-only: points at Google's own remote control), plus the bypass note for Claude Code's own
 * `--dangerously-skip-permissions` sessions. Ninox is tested against a fake server in the shape read from its source at v0.34.0 (it is not installed here: UNVERIFIED live).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { startWorld, type World } from './world.ts';
import { fakeHerdr, type FakeHerdr } from './support/fake-herdr.ts';
import { NinoxAdapter, NINOX_ALLOWED_PATHS, verifyNinoxShape } from '../src/adapters/ninox/adapter.ts';
import { HerdrAdapter } from '../src/adapters/herdr/adapter.ts';
import { AgyAdapter, AGY_MANIFEST } from '../src/adapters/agy/adapter.ts';
import { NINOX_MANIFEST } from '../src/adapters/ninox/adapter.ts';
import { fixture } from './fixtures.ts';

let w: World | null = null; let srv: Server | null = null; let h: FakeHerdr | null = null;
afterEach(async () => { await w?.close(); w = null; if (srv) await new Promise<void>((ok) => { srv!.close(() => ok()); srv!.closeAllConnections(); }); srv = null; await h?.close(); h = null; });

const ORCH = '11111111-1111-4111-8111-111111111111';
const WORKER = '22222222-2222-4222-8222-222222222222';
const rows = () => [
  { id: 'orch1', status: 'working', activity: 'working', agent_type: 'claude-code', claude_session_id: ORCH, workspace_path: '/work/ship-it', name: 'PRIVATE-NAME-CANARY', summary: 'PRIVATE-SUMMARY-CANARY', cost_usd: 12 },
  { id: 'w1', status: 'working', activity: 'working', agent_type: 'claude-code', orchestrator_id: 'orch1', claude_session_id: WORKER, workspace_path: '/work/ship-it-wt1' },
  { id: 'w2', status: 'working', activity: 'idle', agent_type: 'codex', orchestrator_id: 'orch1', workspace_path: '/work/ship-it-wt2' },
  { id: 'old', status: 'done', activity: 'idle', agent_type: 'claude-code', workspace_path: '/work/finished' },
];

async function ninox(sessions: unknown): Promise<{ w: World; seen: { method: string; url: string }[]; adapter: NinoxAdapter; port: number }> {
  const seen: { method: string; url: string }[] = [];
  srv = createServer((req, res) => { seen.push({ method: req.method ?? '', url: req.url ?? '' }); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(typeof sessions === 'function' ? (sessions as () => unknown)() : sessions)); });
  await new Promise<void>((ok) => srv!.listen(0, '127.0.0.1', () => ok()));
  const port = (srv.address() as { port: number }).port;
  w = await startWorld();
  const cfg = w.daemon.store.config();
  w.setConfig({ adapters: { ...cfg.adapters, ninox: { enabled: true, port } } });
  return { w, seen, adapter: w.daemon.host.hub.get('ninox') as NinoxAdapter, port };
}

describe('Ninox (read only)', () => {
  it('shows workers with mode bypass, merges an orchestrator into the Claude Code card of the same session, and drops everything private', async () => {
    const s = await ninox(rows);
    const d = await s.w.pairDevice();
    await s.w.hook('SessionStart', { session_id: ORCH, cwd: '/work/ship-it', hook_event_name: 'SessionStart' }); // Claude Code's own hook for the orchestrator
    await s.w.hook('SessionStart', { session_id: WORKER, cwd: '/work/ship-it-wt1', hook_event_name: 'SessionStart' }); // ...and for worker 1 (hooks apply to workers too)
    await s.adapter.poll();
    const st = await d.waitFor(() => (d.latest?.sessions.some((x) => x.agent === 'ninox') ? d.latest : undefined));
    const byLabel = (l: string) => st.sessions.filter((x) => x.label === l);
    expect(byLabel('ship-it')).toHaveLength(1);                                      // orchestrator: one card, Claude Code's
    expect(byLabel('ship-it')[0]).toMatchObject({ agent: 'claude-code' });
    expect(byLabel('ship-it')[0]!.mode).not.toBe('bypass');
    expect(byLabel('ship-it-wt1')).toHaveLength(1);                                  // worker with a hook session: merged, and marked
    expect(byLabel('ship-it-wt1')[0]).toMatchObject({ agent: 'claude-code', mode: 'bypass' });
    expect(byLabel('ship-it-wt2')[0]).toMatchObject({ agent: 'ninox', mode: 'bypass', status: 'idle' }); // worker only Ninox knows
    expect(byLabel('finished')).toEqual([]);
    expect(JSON.stringify(d.states)).not.toContain('CANARY');
    expect(s.w.daemon.store.auditTail(300).join('\n')).not.toContain('CANARY');
  });

  it('asks for exactly one path with GET and nothing else (no terminal, diff, delete, orchestrators, brain)', async () => {
    const s = await ninox(rows);
    await s.adapter.poll(); await s.adapter.poll();
    expect(new Set(s.seen.map((r) => `${r.method} ${r.url}`))).toEqual(new Set(['GET /api/v1/sessions']));
    expect(NINOX_ALLOWED_PATHS).toEqual(['/api/v1/sessions']);
    expect(s.adapter.sent.every((p) => NINOX_ALLOWED_PATHS.includes(p))).toBe(true);
  });

  it('something else on the port (another JSON shape, HTML) is ignored; the adapter is off until enabled; it can answer nothing', async () => {
    const s = await ninox({ hello: 'world' });
    const d = await s.w.pairDevice();
    await s.adapter.poll();
    await new Promise((r) => setTimeout(r, 300));
    expect(d.latest?.sessions.filter((x) => x.agent === 'ninox')).toEqual([]);
    expect((await s.adapter.detect()).present).toBe(false);
    expect(verifyNinoxShape('<html></html>')).toBeNull();
    expect(NINOX_MANIFEST.caps).toMatchObject({ approve: false, deny: false, presetReply: false, optionAnswer: false });
    expect(await s.adapter.deliver({ adapter: 'ninox', kind: 'screen', id: 'x', fingerprint: 'x' }, { t: 'permission', behavior: 'allow' }, { device: 'p' })).toBe('unsupported');
    // disabled: no request at all
    const cfg = s.w.daemon.store.config();
    s.w.setConfig({ adapters: { ...cfg.adapters, ninox: { ...cfg.adapters.ninox, enabled: false } } });
    s.seen.length = 0;
    await s.adapter.poll();
    expect(s.seen).toEqual([]);
  });

  it('a session whose own hook says bypassPermissions (--dangerously-skip-permissions) is marked and never offers Approve, even with answering enabled elsewhere', async () => {
    w = await startWorld();
    const d = await w.pairDevice();
    await w.hook('SessionStart', { session_id: 'yolo-1', cwd: '/work/yolo', hook_event_name: 'SessionStart', permission_mode: 'bypassPermissions' });
    const st = await d.waitFor(() => d.latest?.sessions.find((x) => x.label === 'yolo' && x.mode === 'bypass'));
    expect(st.mode).toBe('bypass');
  });
});

describe('agy (read only)', () => {
  it('reports the version and points at Herdr for cards and Google\'s own remote control for answers; it can answer nothing and installs no hook', async () => {
    const a = new AgyAdapter({ versionProbe: async () => '1.2.14' });
    expect(await a.detect()).toMatchObject({ present: true, version: '1.2.14' });
    const lines = (await a.doctor()).map((l) => l.value).join('\n');
    expect(lines).toContain('agy remote-control');
    expect(lines).toContain('adapters enable herdr');
    expect(AGY_MANIFEST.caps).toMatchObject({ approve: false, deny: false, presetReply: false, optionAnswer: false, readPending: false });
    expect(await a.deliver({ adapter: 'agy', kind: 'screen', id: 'x', fingerprint: 'x' }, { t: 'permission', behavior: 'allow' }, { device: 'p' })).toBe('unsupported');
    expect(await new AgyAdapter({ versionProbe: async () => null }).detect()).toMatchObject({ present: false });
  });

  it('Herdr shows a blocked agy (either name Herdr uses) as an agy card marked "answer on your computer"', async () => {
    if (process.platform === 'win32') return;
    h = await fakeHerdr();
    w = await startWorld({ herdrTargets: () => [{ name: 'fake', path: h!.path }] });
    const cfg = w.daemon.store.config();
    w.setConfig({ adapters: { ...cfg.adapters, herdr: { enabled: true, screenPreview: false } } });
    const d = await w.pairDevice();
    h.panes.push({ pane_id: 'w1:p1', agent: 'agy', agent_status: 'blocked', cwd: '/work/notes' }, { pane_id: 'w1:p2', agent: 'antigravity-cli', agent_status: 'idle', cwd: '/work/docs' });
    await (w.daemon.host.hub.get('herdr') as HerdrAdapter).poll();
    const st = await d.waitFor(() => (d.latest?.sessions.filter((x) => x.agent === 'agy').length === 2 ? d.latest : undefined));
    expect(st.sessions.find((x) => x.label === 'notes')).toMatchObject({ agent: 'agy', status: 'waiting', pending: { source: 'screen', can: { approve: false, reply: false } } });
    void fixture;
  });
});

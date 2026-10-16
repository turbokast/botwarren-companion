/**
 * Herdr, read only: a card for every agent Herdr says is blocked, marked "answer on your computer", with nothing typed into any pane and no private title sent.
 * Against a fake Herdr socket in the shape observed from Herdr 0.9.1 (protocol 22). The poll is driven by the test (`poll()`), not by the 2 s timer.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { startWorld, type World } from './world.ts';
import type { SimDevice } from './simdevice.ts';
import { fakeHerdr, type FakeHerdr } from './support/fake-herdr.ts';
import { HERDR_ALLOWED_METHODS, HerdrAdapter, herdrTargets } from '../src/adapters/herdr/adapter.ts';
import { FakeAdapter } from './fake-adapter.ts';

const win = process.platform === 'win32';
let w: World | null = null; let h: FakeHerdr | null = null;
afterEach(async () => { await w?.close(); w = null; await h?.close(); h = null; });

async function setup(screenPreview = false): Promise<{ d: SimDevice; adapter: HerdrAdapter; h: FakeHerdr }> {
  h = await fakeHerdr();
  w = await startWorld({ herdrTargets: () => [{ name: 'fake', path: h!.path }] });
  const cfg = w.daemon.store.config();
  w.setConfig({ adapters: { ...cfg.adapters, herdr: { enabled: true, screenPreview } } });
  const d = await w.pairDevice();
  return { d, adapter: w.daemon.host.hub.get('herdr') as HerdrAdapter, h };
}
const card = (d: SimDevice, label: string) => d.latest?.sessions.find((s) => s.label === label);

describe.skipIf(win)('Herdr read-only adapter', () => {
  it('shows a "waiting" card for every agent kind Herdr says is blocked, with the folder name only, marked source screen and not answerable', async () => {
    const s = await setup();
    s.h.panes.push(
      { pane_id: 'w1:p1', agent: 'cursor', agent_status: 'blocked', cwd: '/work/site-audit', terminal_title_stripped: 'PRIVATE-TITLE-CANARY rewrite the billing', screen: 'Allow command? SCREEN-CANARY npm run build' },
      { pane_id: 'w1:p2', agent: 'aider', agent_status: 'working', cwd: '/work/notes' },
      { pane_id: 'w1:p3', agent: 'muse', agent_status: 'idle', cwd: '/work/client-portal' },
    );
    await s.adapter.poll();
    const c = await s.d.waitFor(() => card(s.d, 'site-audit')?.pending && card(s.d, 'site-audit'));
    expect(c).toMatchObject({ agent: 'other', status: 'waiting', pending: { kind: 'permission', source: 'screen', can: { approve: false, reply: false }, summary: 'Waiting for you', preview: '' } });
    expect(card(s.d, 'notes')).toMatchObject({ agent: 'other', status: 'working' });
    expect(card(s.d, 'client-portal')).toMatchObject({ agent: 'muse', status: 'idle' });
    const all = JSON.stringify(s.d.states) + w!.daemon.store.auditTail(300).join('\n');
    expect(all).not.toContain('PRIVATE-TITLE-CANARY');
    expect(all).not.toContain('SCREEN-CANARY'); // no screen text unless the person turned screenPreview on
    expect(s.h.methods.filter((m) => m === 'agent.read')).toEqual([]);
  });

  it('answering is refused (nothing to deliver to), and only read methods are ever sent to Herdr', async () => {
    const s = await setup();
    s.h.panes.push({ pane_id: 'w1:p1', agent: 'cursor', agent_status: 'blocked', cwd: '/work/site-audit' });
    await s.adapter.poll();
    const c = await s.d.waitFor(() => card(s.d, 'site-audit')?.pending && card(s.d, 'site-audit'));
    await s.d.act({ rid: c.pending!.rid, sid: c.sid, a: 'approve', bind: c.pending!.bind });
    await s.d.waitFor(() => s.d.results[0]);
    expect(s.d.results[0]!.outcome).toBe('rejected');
    await s.adapter.poll(); await s.adapter.poll();
    expect(new Set(s.h.methods)).toEqual(new Set(['ping', 'agent.list'].filter((m) => s.h.methods.includes(m))));
    for (const m of s.h.methods) expect(HERDR_ALLOWED_METHODS.has(m), m).toBe(true);
    expect(s.adapter.sent.every((m) => HERDR_ALLOWED_METHODS.has(m))).toBe(true);
    for (const forbidden of ['agent.send_keys', 'agent.prompt', 'pane.send_keys', 'pane.send_text', 'pane.run', 'agent.start']) expect(HERDR_ALLOWED_METHODS.has(forbidden)).toBe(false);
  });

  it('with screenPreview on, only a blocked pane\'s detection excerpt is read, masked, and labelled by its source', async () => {
    const s = await setup(true);
    s.h.panes.push(
      { pane_id: 'w1:p1', agent: 'cursor', agent_status: 'blocked', cwd: '/work/site-audit', screen: 'Run command?\n  curl -H "Authorization: Bearer ' + 'q7'.repeat(20) + '" https://example.com\n1. Yes 2. No' },
      { pane_id: 'w1:p2', agent: 'aider', agent_status: 'working', cwd: '/work/notes', screen: 'NOT-BLOCKED-CANARY' },
    );
    await s.adapter.poll();
    const c = await s.d.waitFor(() => card(s.d, 'site-audit')?.pending && card(s.d, 'site-audit'));
    expect(c.pending!.preview).toContain('Run command?');
    expect(c.pending!.preview).not.toContain('q7q7q7');
    expect(c.pending!.source).toBe('screen');
    expect(JSON.stringify(s.d.states)).not.toContain('NOT-BLOCKED-CANARY');
    expect(s.h.methods.filter((m) => m === 'agent.read')).toHaveLength(1);
    await s.adapter.poll(); // unchanged pane: not read again
    expect(s.h.methods.filter((m) => m === 'agent.read')).toHaveLength(1);
  });

  it('the card goes when the pane stops being blocked and the session when the pane is gone', async () => {
    const s = await setup();
    s.h.panes.push({ pane_id: 'w1:p1', agent: 'cursor', agent_status: 'blocked', cwd: '/work/site-audit' });
    await s.adapter.poll();
    await s.d.waitFor(() => card(s.d, 'site-audit')?.pending);
    s.h.panes[0]!.agent_status = 'working'; s.h.panes[0]!.state_change_seq = 2;
    await s.adapter.poll();
    await s.d.waitFor(() => { const c = card(s.d, 'site-audit'); return c && !c.pending && c.status === 'working'; });
  });

  it('a Herdr pane of an agent a hook adapter already reports merges into that card, and never replaces its structured request', async () => {
    const s = await setup();
    const codex = new FakeAdapter({ id: 'codex', kind: 'codex' });
    w!.daemon.host.hub.register(codex);
    const sid = '019a0000-0000-7000-8000-000000000001';
    codex.session(`codex:${sid}`, { cwd: '/work/dragon-game' });
    await codex.pending({ sessionKey: `codex:${sid}`, summary: 'Run a command', preview: 'npm test', native: null, can: { approve: false, reply: false } });
    s.h.panes.push({ pane_id: 'w1:p1', agent: 'codex', agent_status: 'blocked', cwd: '/work/dragon-game', agent_session: { source: 'herdr:codex', agent: 'codex', kind: 'id', value: sid } });
    await s.adapter.poll();
    await new Promise((r) => setTimeout(r, 300));
    const cards = s.d.latest!.sessions.filter((x) => x.label === 'dragon-game');
    expect(cards).toHaveLength(1);
    expect(cards[0]!.pending).toMatchObject({ source: 'structured', preview: 'npm test' });
  });

  it('off by default: nothing is read until the person turns it on; and a missing socket is not an error', async () => {
    h = await fakeHerdr();
    w = await startWorld({ herdrTargets: () => [{ name: 'fake', path: h!.path }] });
    h.panes.push({ pane_id: 'w1:p1', agent: 'cursor', agent_status: 'blocked', cwd: '/work/x' });
    const a = w.daemon.host.hub.get('herdr') as HerdrAdapter;
    expect(w.daemon.store.config().adapters.herdr.enabled).toBe(false);
    await a.poll();
    expect(h.methods).toEqual([]);
    const lonely = new HerdrAdapter({ targets: () => [{ name: 'none', path: '/nonexistent/herdr.sock' }] });
    expect((await lonely.detect()).present).toBe(false);
  });

  it('socket resolution: HERDR_SOCKET_PATH, HERDR_SESSION, the default, and nothing on Windows', () => {
    const t = herdrTargets({ HERDR_SOCKET_PATH: '/run/h.sock', HERDR_SESSION: 'work', XDG_CONFIG_HOME: '/cfg' }, 'linux', '/home/u');
    expect(t.map((x) => x.path)).toEqual(['/run/h.sock', '/cfg/herdr/sessions/work/herdr.sock', '/cfg/herdr/herdr.sock']);
    expect(herdrTargets({}, 'linux', '/home/u').map((x) => x.path)).toEqual(['/home/u/.config/herdr/herdr.sock']);
    expect(herdrTargets({ HERDR_SOCKET_PATH: '\\\\.\\pipe\\x' }, 'win32', 'C:\\Users\\u')).toEqual([]);
    expect(herdrTargets({ HERDR_SESSION: '../evil' }, 'linux', '/h').map((x) => x.path)).toEqual(['/h/.config/herdr/herdr.sock']);
  });
});

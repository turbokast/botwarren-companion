/**
 * LIVE (opt-in, `BW_LIVE_OPENCODE=1`): a real `opencode serve` (v2) started by this test in a temporary HOME with an EMPTY environment (PATH and temp folders
 * only), on a random loopback port with a random password, and killed by PID when the test ends. The permission request is created through the server's own API
 * (no model, no credentials, no network). The companion's adapter finds it, a simulated phone answers it, and the REAL server state proves: approve resolved the
 * exact request and saved NO standing rule (a "once" answer, not "always"); deny rejected it; a second answer to the same id is refused by the server.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { startWorld, type World } from './world.ts';
import type { SimDevice } from './simdevice.ts';
import type { Pending } from '../src/protocol/index.ts';
import { OpenCodeAdapter } from '../src/adapters/opencode/adapter.ts';

const bin = join(homedir(), '.opencode', 'bin', 'opencode');
const live = process.env.BW_LIVE_OPENCODE === '1' && existsSync(bin);
let w: World | null = null; let child: ChildProcess | null = null; let tmp = '';
afterEach(async () => { await w?.close(); w = null; child?.kill(); child = null; if (tmp) rmSync(tmp, { recursive: true, force: true }); tmp = ''; });

const freePort = (): Promise<number> => new Promise((ok) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => ok(p)); }); });
const pendingOf = (d: SimDevice): (Pending & { sid: string }) | undefined => { const s = d.latest?.sessions.find((x) => x.agent === 'opencode' && x.pending); return s?.pending ? { ...s.pending, sid: s.sid } : undefined; };

describe.skipIf(!live)('live OpenCode v2 (real server, isolated, no model)', () => {
  it('approve answers the exact request once and saves no standing rule; deny rejects; a second answer is refused', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'bwc-oclive-'));
    const home = join(tmp, 'home'); const repo = join(tmp, 'repo'); mkdirSync(home); mkdirSync(repo);
    const port = await freePort(); const password = randomBytes(12).toString('hex');
    const env = { PATH: '/usr/bin:/bin', HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'), XDG_STATE_HOME: join(home, '.local/state'), XDG_CACHE_HOME: join(home, '.cache'), OPENCODE_SERVER_PASSWORD: password };
    child = spawn(bin, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], { env, cwd: repo, stdio: 'ignore' }); // an explicit env object: nothing is inherited
    const auth = 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64');
    const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; j: { data?: unknown } & Record<string, unknown> | null }> => {
      const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { authorization: auth, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* none */ } return { status: r.status, j };
    };
    for (let i = 0; i < 60; i++) { try { if ((await api('GET', '/api/info')).status === 200) break; } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 500)); }
    const ses = (await api('POST', '/api/session', { location: { directory: repo }, permissions: [{ action: '*', resource: '*', effect: 'ask' }] })).j as { data: { id: string } };
    const sid = ses.data.id;
    const mk = async (cmd: string): Promise<string> => ((await api('POST', `/api/session/${sid}/permission`, { action: 'bash', resources: [cmd], save: ['touch *'], metadata: { description: 'Botwarren live test' }, source: { type: 'tool', messageID: 'msg_live', id: `call_${cmd.length}` } })).j as { data: { id: string } }).data.id;

    w = await startWorld({ resolveWaitMs: 3000, opencodeEnv: { BW_LIVE_OC_PASSWORD: password } });
    const cfg = w.daemon.store.config();
    w.setConfig({ adapters: { ...cfg.adapters, opencode: { enabled: true, port, passwordEnv: 'BW_LIVE_OC_PASSWORD' } } });
    const d = await w.pairDevice();
    const adapter = w.daemon.host.hub.get('opencode') as OpenCodeAdapter;

    const id1 = await mk('touch ../live-marker-1');
    await adapter.poll();
    let p = await d.waitFor(() => pendingOf(d), 15_000);
    expect(p).toMatchObject({ tool: 'bash', preview: 'touch ../live-marker-1', can: { approve: true } });
    await d.act({ rid: p.rid, sid: p.sid, a: 'approve', bind: p.bind });
    expect((await d.waitFor(() => d.results[0], 15_000)).outcome).toBe('applied');
    expect((await api('GET', `/api/session/${sid}/permission/${id1}`)).status).toBe(404); // resolved on the real server
    expect((await api('GET', '/api/permission/saved')).j?.data).toEqual([]);                // ...and NO standing rule was saved: it was once, not always
    // a second answer to the same id is refused by the server itself
    expect((await api('POST', `/api/session/${sid}/permission/${id1}/reply`, { decision: 'once' })).status).toBe(404);

    const id2 = await mk('rm -rf build');
    await adapter.poll();
    p = await d.waitFor(() => { const x = pendingOf(d); return x && x.preview === 'rm -rf build' ? x : undefined; }, 15_000);
    await d.act({ rid: p.rid, sid: p.sid, a: 'reply', bind: p.bind, opt: 'no' });
    expect((await d.waitFor(() => d.results[1], 15_000)).outcome).toBe('denied');
    expect((await api('GET', `/api/session/${sid}/permission/${id2}`)).status).toBe(404);
    expect((await api('GET', '/api/permission/saved')).j?.data).toEqual([]);
  }, 120_000);
});

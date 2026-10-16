/**
 * A fake Herdr socket (newline-delimited JSON, the shape observed from Herdr 0.9.1: `{id, method, params}` -> `{id, result: {type, ...}}`) with a scripted
 * pane list, so the Herdr adapter is tested without Herdr. It records every method it was sent: a test asserts nothing but read methods ever arrives.
 */
import { createServer, type Server } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface FakePane { pane_id: string; agent: string | null; agent_status: 'idle' | 'working' | 'blocked' | 'done' | 'unknown'; cwd: string; terminal_title_stripped?: string; agent_session?: { source: string; agent: string; kind: 'id'; value: string } | null; revision?: number; state_change_seq?: number; screen?: string }
export interface FakeHerdr { path: string; panes: FakePane[]; methods: string[]; close(): Promise<void> }

export async function fakeHerdr(): Promise<FakeHerdr> {
  const dir = mkdtempSync(join(tmpdir(), 'bwh-'));
  const path = join(dir, 'herdr.sock');
  const me: FakeHerdr = { path, panes: [], methods: [], close: async () => undefined };
  const socks = new Set<import('node:net').Socket>();
  const server: Server = createServer((sock) => {
    socks.add(sock); sock.on('close', () => socks.delete(sock));
    let buf = ''; sock.setEncoding('utf8');
    sock.on('data', (c: string) => {
      buf += c; let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m: { id?: string; method?: string; params?: { target?: string } };
        try { m = JSON.parse(line) as typeof m; } catch { continue; }
        me.methods.push(String(m.method));
        const reply = (result: unknown): void => { sock.write(JSON.stringify({ id: m.id, result }) + '\n'); };
        if (m.method === 'ping') reply({ type: 'pong', version: '0.9.1', protocol: 22, capabilities: {} });
        else if (m.method === 'agent.list') reply({ type: 'agents', agents: me.panes.map((p) => ({ terminal_id: `t-${p.pane_id}`, agent: p.agent, terminal_title: p.terminal_title_stripped, terminal_title_stripped: p.terminal_title_stripped, agent_status: p.agent_status, agent_session: p.agent_session ?? null, workspace_id: 'w1', tab_id: 'w1:t1', pane_id: p.pane_id, focused: false, state_change_seq: p.state_change_seq ?? 1, cwd: p.cwd, foreground_cwd: p.cwd, revision: p.revision ?? 1 })) });
        else if (m.method === 'agent.read') { const p = me.panes.find((x) => x.pane_id === m.params?.target); reply({ type: 'agent_read', read: { pane_id: m.params?.target, workspace_id: 'w1', tab_id: 'w1:t1', source: 'detection', format: 'text', text: p?.screen ?? '', revision: p?.revision ?? 1, truncated: false } }); }
        else sock.write(JSON.stringify({ id: m.id, error: { code: 'unknown_method' } }) + '\n');
      }
    });
    sock.on('error', () => undefined);
  });
  await new Promise<void>((ok) => server.listen(path, ok));
  me.close = () => new Promise<void>((ok) => { server.close(() => { rmSync(dir, { recursive: true, force: true }); ok(); }); for (const x of socks) x.destroy(); });
  return me;
}

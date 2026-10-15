import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { Relay } from '../../relay/src/relay.ts';
import { generateVapidKeys } from '../../relay/src/webpush.ts';
import { b64u, generateIdentity, signTicket, type Identity } from '../src/protocol/index.ts';
import { startDaemon, type Daemon } from '../src/daemon.ts';
import { runChannelServer } from '../src/claude/channel.ts';
import { runHook } from '../src/claude/hookClient.ts';
import { connectDaemon } from '../src/ipc.ts';
import { SimDevice } from './simdevice.ts';

/** a stand-in for a browser push service: records what the relay delivers and answers with the status the test sets */
export interface MockPush {
  fetchImpl: typeof fetch;
  posts: { url: string; headers: Record<string, string>; body: Buffer }[];
  status: number;
}
export function mockPush(): MockPush {
  const m: MockPush = { posts: [], status: 201, fetchImpl: undefined as never };
  m.fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    m.posts.push({ url: String(url), headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)), body: Buffer.from(init?.body as Uint8Array) });
    return new Response(null, { status: m.status });
  }) as typeof fetch;
  return m;
}

export interface World {
  dir: string;
  claudeDir: string;
  relay: Relay;
  /** present when the world was started with `push` */
  push: MockPush | null;
  base: string;
  server: Identity;
  daemon: Daemon;
  env: { BOTWARREN_COMPANION_HOME: string };
  /** pair a new simulated phone (the owner says yes at the computer) */
  pairDevice(name?: string): Promise<SimDevice>;
  hook(event: string, input: Record<string, unknown>): Promise<string | null>;
  channel(cwd?: string): Promise<Channel>;
  setConfig(patch: Record<string, unknown>): void;
  close(): Promise<void>;
}

export interface Channel {
  stdin: PassThrough;
  lines: Record<string, unknown>[];
  permissionRequest(requestId: string, tool: string, description: string, input: string): void;
  waitFor(pred: (m: Record<string, unknown>) => boolean, ms?: number): Promise<Record<string, unknown>>;
  stop(): void;
}

export async function startWorld(o: { now?: () => number; clientDir?: string; push?: boolean } = {}): Promise<World> {
  const dir = mkdtempSync(join(tmpdir(), 'bwc-'));
  const claudeDir = join(dir, 'claude');
  mkdirSync(join(claudeDir, 'projects', 'p'), { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  const server = await generateIdentity(true);
  const push = o.push ? mockPush() : null;
  const relay = new Relay({ port: 0, host: '127.0.0.1', ticketKeys: [server.pub], ...(o.clientDir ? { clientDir: o.clientDir } : {}), ...(push ? { push: { vapid: generateVapidKeys(), subject: 'mailto:test@example.com', fetchImpl: push.fetchImpl } } : {}) });
  const port = await relay.listen();
  relay.origin = `http://127.0.0.1:${port}`;
  const base = relay.origin;
  const env = { BOTWARREN_COMPANION_HOME: join(dir, 'home') };
  const daemon = await startDaemon({ dir: env.BOTWARREN_COMPANION_HOME, env, ...(o.now ? { now: o.now } : {}) });
  const { host, store } = daemon;
  const ticket = await signTicket(server, { v: 1, acct: 'acct-aaaaaaaaaaaaaaaa', host: host.hostId, hostSig: host.hostSigPub, iat: Date.now(), exp: Date.now() + 86_400_000 });
  store.writeJson('enrollment.json', { v: 1, relayUrl: base, ticket, acct: 'acct-aaaaaaaaaaaaaaaa' });
  const cfg = store.config(); cfg.allowRelayHosts = ['127.0.0.1']; cfg.name = 'Test laptop'; store.saveConfig(cfg);
  if (!host.start()) throw new Error('host did not start');
  const t0 = Date.now();
  while (host.relayState !== 'online') { if (Date.now() - t0 > 5000) throw new Error('host never connected'); await new Promise((r) => setTimeout(r, 20)); }

  const devices: SimDevice[] = [];
  const channels: Channel[] = [];

  const world: World = {
    dir, claudeDir, relay, push, base, server, daemon, env,
    async pairDevice(name = 'Sim phone') {
      const link = await connectDaemon(env.BOTWARREN_COMPANION_HOME);
      if (!link) throw new Error('no daemon link');
      const confirmed = new Promise<{ sas: string }>((ok) => { link.onEvent((ev) => { if (ev.t === 'pair_confirm') { void link.request('pair_decision', { cid: ev.cid, ok: true }); ok({ sas: String(ev.sas) }); } }); });
      const r = await link.request('pair_start');
      const d = new SimDevice(base, name);
      const { sas, finish } = await d.pair(String(r.code));
      const host = await confirmed;
      if (host.sas !== sas) throw new Error(`SAS mismatch ${host.sas} vs ${sas}`);
      if (!(await finish())) throw new Error('pairing failed');
      link.close();
      d.connect();
      await d.waitFor(() => d.online);
      devices.push(d);
      return d;
    },
    hook: (event, input) => runHook(event, JSON.stringify(input), env, 8000),
    async channel(cwd = '/work/dragon-game') {
      const stdin = new PassThrough(); const stdout = new PassThrough();
      const lines: Record<string, unknown>[] = [];
      let buf = '';
      stdout.on('data', (c: Buffer) => { buf += c.toString('utf8'); let i: number; while ((i = buf.indexOf('\n')) >= 0) { try { lines.push(JSON.parse(buf.slice(0, i)) as Record<string, unknown>); } catch { /* ignore */ } buf = buf.slice(i + 1); } });
      void runChannelServer({ stdin, stdout, env, cwd, pid: 4242, ppid: 4241, retryMs: 50 });
      const send = (m: unknown): void => { stdin.write(JSON.stringify(m) + '\n'); };
      const waitFor = async (pred: (m: Record<string, unknown>) => boolean, ms = 5000): Promise<Record<string, unknown>> => {
        const t = Date.now();
        for (;;) { const f = lines.find(pred); if (f) return f; if (Date.now() - t > ms) throw new Error('timeout waiting for channel line'); await new Promise((r) => setTimeout(r, 20)); }
      };
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
      await waitFor((m) => m.id === 1);
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      const t0 = Date.now();
      while (!world.daemon.host.sessions.byChannelPid(4242)) { if (Date.now() - t0 > 5000) throw new Error('channel never registered'); await new Promise((r) => setTimeout(r, 20)); }
      const ch: Channel = {
        stdin, lines, waitFor,
        permissionRequest: (requestId, tool, description, input) => send({ jsonrpc: '2.0', method: 'notifications/claude/channel/permission_request', params: { request_id: requestId, tool_name: tool, description, input_preview: input } }),
        stop: () => stdin.end(),
      };
      channels.push(ch);
      return ch;
    },
    setConfig(patch) { const c = { ...store.config(), ...patch }; store.saveConfig(c as never); },
    async close() {
      for (const d of devices) d.stop();
      for (const c of channels) c.stop();
      await daemon.stop();
      await relay.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return world;
}

export const transcript = (dir: string, lines: unknown[]): string => {
  const p = join(dir, 'projects', 'p', 's1.jsonl');
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return p;
};

export const assistant = (text: string, ts = '2026-10-15T12:00:00Z') => ({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text }] } });
export { b64u };

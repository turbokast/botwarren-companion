/**
 * The companion daemon: store + host + Claude bridge + local socket. Runs in the foreground (a service manager or the ship agent
 * starts it); logs one line per notable event and never any message content. Licence: Apache-2.0.
 */
import { ClaudeBridge } from './claude/bridge.ts';
import { CompanionHost, type ConnectionLike } from './host.ts';
import type { ConnectionOptions } from './link/connection.ts';
import { ConfirmHub, LocalServer } from './local.ts';
import { Store, homeDir, socketPath } from './store.ts';
import { installLauncher } from './claude/launcher.ts';
import { builtinAdapters } from './adapters/builtin.ts';

export interface DaemonOptions {
  dir?: string;
  now?: () => number;
  makeConnection?: (o: ConnectionOptions) => ConnectionLike;
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
  /** how often the daemon checks that its socket file is still the one it created (ms; 0 = never; default 5000) */
  socketWatchMs?: number;
  /** how long to wait for a tool's own follow-up after delivering an allow before saying `sent` (ms; default 10 s) */
  resolveWaitMs?: number;
  /** replaces `<tool> --version` for the hook-family adapters (tests) */
  versionProbes?: Record<string, () => Promise<string | null>>;
  /** where to look for a Herdr socket (tests) */
  herdrTargets?: () => { name: string; path: string }[];
  /** the environment OpenCode's password variable is read from (tests) */
  opencodeEnv?: Record<string, string | undefined>;
  /** tests: the host's minimum gap between non-urgent state pushes (ms) */
  minStateGapMs?: number;
  /** tests: the minimum gap between two live-tail pushes of one session (ms) */
  tailGapMs?: number;
  /** what is running (the daemon's own node, script and version): written to entry.json so Claude Code's hooks and channel, which use the stable launcher, run this version */
  entry?: { node: string; script: string; version: string };
}

export interface Daemon {
  host: CompanionHost;
  hub: ConfirmHub;
  server: LocalServer;
  store: Store;
  socket: string;
  stop(): Promise<void>;
}

export async function startDaemon(o: DaemonOptions = {}): Promise<Daemon> {
  const dir = o.dir ?? homeDir(o.env ?? process.env);
  const store = new Store(dir);
  const hub = new ConfirmHub();
  const host = new CompanionHost({
    store, confirmer: (r) => hub.ask(r),
    ...(o.now ? { now: o.now } : {}), ...(o.makeConnection ? { makeConnection: o.makeConnection } : {}), ...(o.env ? { env: o.env } : {}), ...(o.minStateGapMs !== undefined ? { minStateGapMs: o.minStateGapMs } : {}), ...(o.resolveWaitMs !== undefined ? { resolveWaitMs: o.resolveWaitMs } : {}), ...(o.tailGapMs !== undefined ? { tailGapMs: o.tailGapMs } : {}),
  });
  await host.init();
  const bridge = new ClaudeBridge(host);
  host.hub.register(bridge);
  for (const a of builtinAdapters(host, { ...(o.versionProbes ? { versionProbes: o.versionProbes } : {}), ...(o.herdrTargets ? { herdrTargets: o.herdrTargets } : {}), ...(o.opencodeEnv ? { opencodeEnv: o.opencodeEnv } : {}) })) host.hub.register(a);
  const socket = socketPath(dir);
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return; stopped = true;
    host.stop();
    await host.hub.stop();
    await server.close();
    store.audit('daemon_stopped');
  };
  const server = new LocalServer({ host, bridge, hub, secret: store.hookSecret(), path: socket, shutdown: () => { void stop().then(() => { if (!o.dir) process.exit(0); }); }, ...(o.socketWatchMs !== undefined ? { watchMs: o.socketWatchMs } : {}) });
  server.onSocketEvent = (e) => { store.audit(e === 'rebound' ? 'socket_rebound' : 'socket_taken'); o.log?.(JSON.stringify({ c: e === 'rebound' ? 'socket_rebound' : 'socket_taken' })); };
  await server.listen();
  if (o.entry) { try { installLauncher(dir, o.entry); } catch { /* the launcher is a convenience: a read-only home must not stop the daemon */ } }
  await host.hub.start();
  const started = host.start();
  store.audit('daemon_started', { enrolled: started });
  o.log?.(JSON.stringify({ c: 'daemon_started', enrolled: started, devices: host.listDevices().length }));
  return { host, hub, server, store, socket, stop };
}

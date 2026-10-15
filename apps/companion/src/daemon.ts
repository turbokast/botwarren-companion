/**
 * The companion daemon: store + host + Claude bridge + local socket. Runs in the foreground (a service manager or the ship agent
 * starts it); logs one line per notable event and never any message content. Licence: Apache-2.0.
 */
import { ClaudeBridge } from './claude/bridge.ts';
import { CompanionHost, type ConnectionLike } from './host.ts';
import type { ConnectionOptions } from './link/connection.ts';
import { ConfirmHub, LocalServer } from './local.ts';
import { Store, homeDir, socketPath } from './store.ts';

export interface DaemonOptions {
  dir?: string;
  now?: () => number;
  makeConnection?: (o: ConnectionOptions) => ConnectionLike;
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
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
    ...(o.now ? { now: o.now } : {}), ...(o.makeConnection ? { makeConnection: o.makeConnection } : {}), ...(o.env ? { env: o.env } : {}),
  });
  await host.init();
  const bridge = new ClaudeBridge(host);
  const socket = socketPath(dir);
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return; stopped = true;
    host.stop();
    await server.close();
    store.audit('daemon_stopped');
  };
  const server = new LocalServer({ host, bridge, hub, secret: store.hookSecret(), path: socket, shutdown: () => { void stop().then(() => { if (!o.dir) process.exit(0); }); } });
  await server.listen();
  const started = host.start();
  store.audit('daemon_started', { enrolled: started });
  o.log?.(JSON.stringify({ c: 'daemon_started', enrolled: started, devices: host.listDevices().length }));
  return { host, hub, server, store, socket, stop };
}

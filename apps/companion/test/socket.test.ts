import { afterEach, describe, expect, it } from 'vitest';
import { createConnection, createServer, type Server } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDaemon, type Daemon } from '../src/daemon.ts';
import { connectDaemon, waitForRestart } from '../src/ipc.ts';
import { noDaemonMessage, serviceUnit } from '../src/service.ts';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'bwc-s-'));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean | Promise<boolean>, ms = 5000): Promise<void> => { const t = Date.now(); while (!(await cond())) { if (Date.now() - t > ms) throw new Error('timeout'); await sleep(25); } };
const listening = (path: string): Promise<Server> => new Promise((ok, bad) => { const s = createServer((c) => c.end()); s.once('error', bad); s.listen(path, () => ok(s)); });
const answers = async (dir: string): Promise<boolean> => { const l = await connectDaemon(dir); l?.close(); return !!l; };

// Unix sockets only: on Windows the daemon listens on a named pipe, which has no file to be replaced
describe.skipIf(process.platform === 'win32')('item 3: the daemon keeps its socket reachable', () => {
  const live: Daemon[] = []; const servers: Server[] = [];
  afterEach(async () => { for (const d of live.splice(0)) await d.stop(); for (const s of servers.splice(0)) s.close(); });
  const start = async (dir: string, watchMs = 40): Promise<Daemon> => { const d = await startDaemon({ dir, env: { BOTWARREN_COMPANION_HOME: dir }, socketWatchMs: watchMs }); live.push(d); return d; };

  it('binds the socket again when its file was deleted (nothing else touched it)', async () => {
    const dir = join(tmp(), 'home');
    const d = await start(dir);
    expect(await answers(dir)).toBe(true);
    unlinkSync(d.socket);
    expect(await answers(dir)).toBe(false); // what the owner's CLI saw
    await until(() => answers(dir));
    expect(d.store.auditTail(20).some((l) => l.includes('socket_rebound'))).toBe(true);
    expect(statSync(d.socket).mode & 0o777).toBe(0o600);
  });

  it('binds again when the file was replaced by a dead one (a stale socket file or any file)', async () => {
    const dir = join(tmp(), 'home');
    const d = await start(dir);
    unlinkSync(d.socket);
    writeFileSync(d.socket, 'not a socket');
    expect(await answers(dir)).toBe(false);
    await until(() => answers(dir));
  });

  it('does not take the path from another daemon that is alive on it, and says so', async () => {
    const dir = join(tmp(), 'home');
    const d = await start(dir);
    unlinkSync(d.socket);
    const other = await listening(d.socket); servers.push(other);
    await until(() => d.store.auditTail(20).some((l) => l.includes('socket_taken')));
    expect(await d.server.verify()).toBe('taken');
    expect(existsSync(d.socket)).toBe(true); // still the other one's file
  });

  it('closing the OLD daemon does not delete the socket of the NEW one (the race behind the owner\'s "connection refused")', async () => {
    const dir = join(tmp(), 'home');
    const old = await startDaemon({ dir, env: { BOTWARREN_COMPANION_HOME: dir }, socketWatchMs: 0 });
    // the service has started the next daemon on the same path while the old one is still shutting down
    unlinkSync(old.socket);
    const next = await listening(old.socket); servers.push(next);
    await old.stop();
    expect(existsSync(old.socket)).toBe(true);
    const c = await new Promise<boolean>((ok) => { const s = createConnection(old.socket); s.once('connect', () => { s.destroy(); ok(true); }); s.once('error', () => ok(false)); });
    expect(c).toBe(true);
  });

  it('refuses to start on a path another live daemon answers on (no ping-pong between two daemons)', async () => {
    const dir = join(tmp(), 'home');
    await start(dir);
    await expect(startDaemon({ dir, env: { BOTWARREN_COMPANION_HOME: dir } })).rejects.toThrow(/already running/);
    expect(await answers(dir)).toBe(true); // the first one was not knocked off
  });

  it('removes a leftover socket file from a crashed run and starts', async () => {
    const dir = join(tmp(), 'home'); mkdirSync(dir, { recursive: true });
    const stale = await listening(join(dir, 'daemon.sock'));
    // a crash leaves the file behind with nobody listening: simulate by closing without removing
    await new Promise<void>((ok) => stale.close(() => ok()));
    if (!existsSync(join(dir, 'daemon.sock'))) writeFileSync(join(dir, 'daemon.sock'), '');
    const d = await start(dir);
    expect(await answers(dir)).toBe(true);
    expect(d.socket).toBe(join(dir, 'daemon.sock'));
  });

  it('enrol\'s wait: the old daemon goes away, a new one answers, and the new status comes back', async () => {
    const dir = join(tmp(), 'home');
    const a = await startDaemon({ dir, env: { BOTWARREN_COMPANION_HOME: dir }, socketWatchMs: 0 });
    const waiting = waitForRestart(dir, { timeoutMs: 15_000, pollMs: 60 });
    await sleep(150);
    await a.stop(); // "shutdown": the service then starts it again
    await sleep(500);
    const b = await startDaemon({ dir, env: { BOTWARREN_COMPANION_HOME: dir }, socketWatchMs: 0 }); live.push(b);
    const st = await waiting;
    expect(st?.ok).toBe(true);
    expect((st?.status as { hostId?: string } | undefined)?.hostId).toBe(b.host.hostId);
  });

  it('gives up after the timeout when nothing comes back', async () => {
    const dir = join(tmp(), 'home');
    expect(await waitForRestart(dir, { timeoutMs: 300, pollMs: 50 })).toBeNull();
  });
});

describe('the hint when the daemon cannot be reached', () => {
  const home = (): string => tmp();
  it('names the service and its restart command when a unit exists (Linux, macOS, Windows layouts)', () => {
    const h = home();
    mkdirSync(join(h, '.config', 'systemd', 'user'), { recursive: true });
    writeFileSync(join(h, '.config', 'systemd', 'user', 'botwarren-companion.service'), '');
    const linux = serviceUnit({ os: 'linux', home: h, env: {} });
    expect(linux?.restart).toBe('systemctl --user restart botwarren-companion');
    expect(noDaemonMessage({ socketFile: true, unit: linux })).toMatch(/stale or replaced socket[\s\S]*systemctl --user restart botwarren-companion/);

    mkdirSync(join(h, 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(join(h, 'Library', 'LaunchAgents', 'com.botwarren.companion.plist'), '');
    expect(serviceUnit({ os: 'darwin', home: h, env: {} })?.restart).toContain('launchctl kickstart -k gui/$(id -u)/com.botwarren.companion');

    const appdata = join(h, 'AppData', 'Roaming');
    mkdirSync(join(appdata, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'), { recursive: true });
    writeFileSync(join(appdata, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Botwarren Companion.vbs'), '');
    expect(serviceUnit({ os: 'win32', home: h, env: { APPDATA: appdata } })?.kind).toBe('startup');
  });

  it('says "not running" with the way to start it when there is no service unit, and does not claim a stale socket without a socket file', () => {
    const h = home();
    expect(serviceUnit({ os: 'linux', home: h, env: {} })).toBeNull();
    const m = noDaemonMessage({ socketFile: false, unit: null });
    expect(m).toContain('is not running');
    expect(m).toContain('botwarren-companion daemon');
    expect(m).not.toContain('stale');
  });
});

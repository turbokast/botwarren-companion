import { describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HOOK_EVENTS, MARKER, hasOurHooks, hookCommand, quoteWord, readSettings, versionedHooks, withHooks } from '../src/claude/settings.ts';
import { ENTRY_FILE, LAUNCHER_FILE, installLauncher, isVersionedPath, launcherHealth, launcherPath, readEntry } from '../src/claude/launcher.ts';
import { claudeMcpConfigPath, registeredChannel } from '../src/commands.ts';
import { Store } from '../src/store.ts';
import { b64u, generateIdentity, signTicket } from '../src/protocol/index.ts';
import { startDaemon, type Daemon } from '../src/daemon.ts';
import { startWorld } from './world.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const tmp = (): string => mkdtempSync(join(tmpdir(), 'bwc-o-'));
const posixOnly = process.platform === 'win32';
/** the same file through any symlink or short name (macOS /var is /private/var; Windows temp folders can have 8.3 names), so comparisons do not depend on how a path was spelled */
const real = (p: string): string => realpathSync.native(p);

/** every place the command could read or write is a temporary folder: the real ~/.claude, ~/.claude.json, the companion's home and the service files are never touched */
function sandbox() {
  const root = tmp();
  const dirs = { home: join(root, 'user'), claude: join(root, 'claude'), companion: join(root, 'companion'), bin: join(root, 'bin') };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  const env: Record<string, string> = {
    HOME: dirs.home, USERPROFILE: dirs.home, APPDATA: join(dirs.home, 'AppData', 'Roaming'), LOCALAPPDATA: join(dirs.home, 'AppData', 'Local'), XDG_CONFIG_HOME: join(dirs.home, '.config'),
    CLAUDE_CONFIG_DIR: dirs.claude, BOTWARREN_COMPANION_HOME: dirs.companion,
  };
  const run = (args: string[], o: { input?: string; env?: Record<string, string> } = {}) =>
    spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', cli, ...args], { env: { ...process.env, ...env, ...o.env }, input: o.input, encoding: 'utf8', timeout: 30_000 });
  return { root, ...dirs, env, run, settings: join(dirs.claude, 'settings.json'), launcher: launcherPath(dirs.companion) };
}

const OLD = '/home/u/.local/share/botwarren-companion/versions/0.1.1/companion.mjs';
const oldHooks = (extra: Record<string, unknown> = {}) => withHooks({ theme: 'dark', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] }, ...extra }, { node: '/usr/bin/node', script: OLD, holdSeconds: 0 });

describe('item 4: Claude Code is pointed at a path that survives updates', () => {
  it('quotes a command line for POSIX, macOS (a space in "Application Support") and Windows (forward slashes, spaces quoted)', () => {
    expect(hookCommand('Stop', { node: '/usr/bin/node', script: '/home/u/.config/botwarren-companion/launch.mjs', win: false }))
      .toBe('/usr/bin/node --disable-warning=ExperimentalWarning /home/u/.config/botwarren-companion/launch.mjs hook Stop --bw-companion');
    expect(hookCommand('Stop', { node: '/usr/local/bin/node', script: '/Users/me/Library/Application Support/botwarren-companion/launch.mjs', win: false }))
      .toBe('/usr/local/bin/node --disable-warning=ExperimentalWarning "/Users/me/Library/Application Support/botwarren-companion/launch.mjs" hook Stop --bw-companion');
    expect(hookCommand('Stop', { node: 'C:\\Program Files\\nodejs\\node.exe', script: 'C:\\Users\\u\\AppData\\Roaming\\botwarren-companion\\launch.mjs', win: true }))
      .toBe('"C:/Program Files/nodejs/node.exe" --disable-warning=ExperimentalWarning C:/Users/u/AppData/Roaming/botwarren-companion/launch.mjs hook Stop --bw-companion');
    expect(quoteWord('/tmp/$(touch pwned)/`id`/a"b', false)).toBe('"/tmp/\\$(touch pwned)/\\`id\\`/a\\"b"');
    expect(quoteWord('C:\\Users\\a "b"\\x', true)).toBe('"C:/Users/a b/x"');
  });

  it('recognises a per-version path on every platform\'s separators and realpath form, and nothing else', () => {
    for (const p of [OLD, 'C:\\Users\\u\\AppData\\Local\\Botwarren\\companion\\versions\\0.1.1\\companion.mjs', '/private/var/folders/ab/xyz/T/x/versions/0.1.2-rc.1/companion.mjs', '"/Users/me/Library/Application Support/Botwarren/companion/versions/10.20.30/companion.mjs"'])
      expect(isVersionedPath(p), p).toBe(true);
    for (const p of ['/home/u/.config/botwarren-companion/launch.mjs', '/x/versions/latest/companion.mjs', '/x/versions/0.1.1/other.mjs', 'C:/Users/u/AppData/Roaming/botwarren-companion/launch.mjs'])
      expect(isVersionedPath(p), p).toBe(false);
  });

  it('install-hooks rewrites hooks that point at a versioned path to the stable launcher, with a backup, keeping the user\'s own hooks', () => {
    const sb = sandbox();
    const before = oldHooks();
    writeFileSync(sb.settings, JSON.stringify(before, null, 2));
    expect(versionedHooks(readSettings(sb.settings))).toHaveLength(HOOK_EVENTS.length);
    // doctor says what is wrong and what to do
    const d = sb.run(['claude', 'doctor']);
    expect(d.stdout).toMatch(/hooks \(user\)\s+installed, but 7 point at a per-version path: run "botwarren-companion claude install-hooks --yes"/);
    const r = sb.run(['claude', 'install-hooks', '--yes']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('older version point at a per-version path');
    expect(r.stdout).toContain('migrated from a per-version path');
    const after = readSettings(sb.settings);
    expect(versionedHooks(after)).toEqual([]);
    expect(hasOurHooks(after)).toBe(true);
    for (const ev of HOOK_EVENTS) {
      const ours = (after.hooks![ev] ?? []).flatMap((g) => g.hooks ?? []).filter((h) => h.command?.includes(MARKER));
      expect(ours).toHaveLength(1);
      expect(ours[0]!.command).toContain(quoteWord(sb.launcher));
      expect(ours[0]!.command).not.toContain('versions');
    }
    expect(after.hooks!.Stop!.flatMap((g) => g.hooks ?? []).some((h) => h.command === 'echo mine')).toBe(true); // the user's own hook is still there
    expect(after.theme).toBe('dark');
    // a backup with the OLD content was written next to it
    const backup = readdirSync(sb.claude).find((f) => f.includes('bw-backup'));
    expect(backup).toBeDefined();
    expect(JSON.parse(readFileSync(join(sb.claude, backup!), 'utf8'))).toEqual(JSON.parse(JSON.stringify(before)));
    // the launcher and its entry exist and name this very script; running it again changes nothing
    expect(launcherHealth(sb.companion)).toMatchObject({ ok: true });
    expect(real(readEntry(sb.companion)!.script)).toBe(real(cli));
    expect(sb.run(['claude', 'install-hooks', '--yes']).stdout).toContain('already installed');
    expect(sb.run(['claude', 'doctor']).stdout).toMatch(/hooks \(user\)\s+installed\s/);
  });

  it('the launcher runs whatever version the companion last started as: an update moves the hooks without touching Claude\'s settings', () => {
    const sb = sandbox();
    const a = join(sb.root, 'versions', '0.1.1'); const b = join(sb.root, 'versions', '0.1.2');
    mkdirSync(a, { recursive: true }); mkdirSync(b, { recursive: true });
    const script = (v: string): string => `process.stdout.write(JSON.stringify({ v: '${v}', args: process.argv.slice(2), home: process.env.BOTWARREN_COMPANION_HOME }) + '\\n');\n`;
    writeFileSync(join(a, 'companion.mjs'), script('v1')); writeFileSync(join(b, 'companion.mjs'), script('v2'));
    const launcher = installLauncher(sb.companion, { node: process.execPath, script: join(a, 'companion.mjs'), version: '0.1.1' });
    const go = (): { v: string; args: string[]; home: string } => JSON.parse(spawnSync(process.execPath, [launcher, 'hook', 'Stop', MARKER], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } }).stdout.trim()) as { v: string; args: string[]; home: string };
    expect(go()).toMatchObject({ v: 'v1', args: ['hook', 'Stop', MARKER] });
    expect(real(go().home)).toBe(real(sb.companion)); // and it knows its own home
    // the new version starts (the daemon calls installLauncher on every start)
    installLauncher(sb.companion, { node: process.execPath, script: join(b, 'companion.mjs'), version: '0.1.2' });
    expect(go()).toMatchObject({ v: 'v2', args: ['hook', 'Stop', MARKER] });
    expect(launcher).toBe(launcherPath(sb.companion)); // the path in Claude's settings never changed
    // rewriting identical content is a no-op (no churn on every daemon start)
    const m1 = readFileSync(launcher, 'utf8'); installLauncher(sb.companion, { node: process.execPath, script: join(b, 'companion.mjs'), version: '0.1.2' });
    expect(readFileSync(launcher, 'utf8')).toBe(m1);
    // the entry file is the only moving part
    expect(readdirSync(sb.companion).sort()).toEqual([ENTRY_FILE, LAUNCHER_FILE].sort());
    // and a removed version is noticed
    installLauncher(sb.companion, { node: process.execPath, script: join(sb.root, 'gone', 'companion.mjs'), version: '0.0.0' });
    expect(launcherHealth(sb.companion)).toEqual({ ok: false, why: 'script_missing' });
  });

  it('fails open: a hook through a broken launcher prints nothing and exits 0; the channel server says what is wrong and exits 1', () => {
    const sb = sandbox();
    const launcher = installLauncher(sb.companion, { node: process.execPath, script: join(sb.root, 'nope', 'companion.mjs'), version: '0.0.0' });
    const hook = spawnSync(process.execPath, [launcher, 'hook', 'PermissionRequest', MARKER], { encoding: 'utf8', input: '{}' });
    expect(hook.status).toBe(0);
    expect(hook.stdout).toBe('');
    const chan = spawnSync(process.execPath, [launcher, 'channel'], { encoding: 'utf8', input: '' });
    expect(chan.status).toBe(1);
    expect(chan.stderr).toContain('launcher');
  });

  it('a real hook through the launcher reaches the running daemon', async () => {
    const w = await startWorld();
    try {
      const launcher = installLauncher(w.env.BOTWARREN_COMPANION_HOME, { node: process.execPath, script: cli, version: 'test' });
      // asynchronous on purpose: the daemon runs in this very process, so a blocking spawn would starve it
      const status = await new Promise<number | null>((ok) => {
        const c = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', launcher, 'hook', 'SessionStart', MARKER], { env: { PATH: process.env.PATH ?? '' }, stdio: ['pipe', 'ignore', 'ignore'] });
        c.on('close', ok);
        c.stdin.end(JSON.stringify({ session_id: 'via-launcher', cwd: '/work/launcher-test', hook_event_name: 'SessionStart' }));
      });
      expect(status).toBe(0);
      expect(w.daemon.host.sessions.byKey('via-launcher')?.label).toBe('launcher-test');
    } finally { await w.close(); }
  });

  it('the daemon writes the entry itself, so the first start of a new version moves the hooks over', async () => {
    const dir = join(tmp(), 'home');
    const { startDaemon } = await import('../src/daemon.ts');
    const d = await startDaemon({ dir, env: { BOTWARREN_COMPANION_HOME: dir }, entry: { node: process.execPath, script: cli, version: '9.9.9' }, socketWatchMs: 0 });
    try { expect(readEntry(dir)).toMatchObject({ version: '9.9.9', script: cli }); } finally { await d.stop(); } // (the entry is written verbatim from what the daemon was given)
  });
});

describe('item 5: a command that needs an answer never waits for one that cannot come', () => {
  it('install-hooks with no terminal shows the change, says "Re-run with --yes to apply" and changes nothing', () => {
    const sb = sandbox();
    writeFileSync(sb.settings, JSON.stringify({ theme: 'dark' }, null, 2));
    const r = sb.run(['claude', 'install-hooks']); // stdin is a pipe, as when another program runs it
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('This will change');
    expect(r.stdout).toMatch(/Not applied: no terminal is attached to ask "install these hooks"/);
    expect(r.stdout).toContain('Re-run with --yes to apply it.');
    expect(JSON.parse(readFileSync(sb.settings, 'utf8'))).toEqual({ theme: 'dark' });
    expect(readdirSync(sb.claude)).toEqual(['settings.json']); // no backup, no stray file
    expect(existsSync(sb.launcher)).toBe(false);
  });

  it('answers on stdin are ignored without a terminal (a pipe saying "y" does not apply a change nobody saw)', () => {
    const sb = sandbox();
    const r = sb.run(['claude', 'install-hooks'], { input: 'y\n' });
    expect(r.status).toBe(1);
    expect(hasOurHooks(readSettings(sb.settings))).toBe(false);
  });

  it('uninstall --purge with no terminal keeps the keys and says how to confirm', () => {
    const sb = sandbox();
    new Store(sb.companion).audit('x');
    const r = sb.run(['uninstall', '--purge']);
    expect(r.stdout).toContain('Re-run with --yes to delete');
    expect(existsSync(join(sb.companion, 'audit.log'))).toBe(true);
    expect(sb.run(['uninstall', '--purge', '--yes']).stdout).toContain('deleted.');
    expect(existsSync(sb.companion)).toBe(false);
  });
});

describe.skipIf(posixOnly)('claude register-channel (with a stand-in for the claude command)', () => {
  /** a `claude` that records its arguments, one per line, and exits with the status it is told to */
  function fakeClaude(sb: ReturnType<typeof sandbox>, status = 0): string {
    const log = join(sb.root, 'claude-calls.log');
    writeFileSync(join(sb.bin, 'claude'), `#!/bin/sh\nprintf '%s\\n' "CALL" "$@" >> '${log}'\nexit ${status}\n`);
    chmodSync(join(sb.bin, 'claude'), 0o755);
    return log;
  }
  const calls = (log: string): string[][] => (existsSync(log) ? readFileSync(log, 'utf8').split('CALL\n').filter(Boolean).map((c) => c.trim().split('\n')) : []);
  const envWith = (sb: ReturnType<typeof sandbox>) => ({ env: { PATH: sb.bin } });

  it('registers the channel with the stable launcher (claude mcp add --scope user ...)', () => {
    const sb = sandbox(); const log = fakeClaude(sb);
    const r = sb.run(['claude', 'register-channel', '--yes'], envWith(sb));
    expect(r.status, r.stderr).toBe(0);
    expect(calls(log)).toEqual([['mcp', 'add', '--scope', 'user', 'botwarren-companion', '--', process.execPath, '--disable-warning=ExperimentalWarning', sb.launcher, 'channel']]);
    expect(r.stdout).toContain('claude --dangerously-load-development-channels server:botwarren-companion');
    expect(launcherHealth(sb.companion)).toMatchObject({ ok: true });
  });

  it('replaces a registration that points at a versioned path: remove, then add', () => {
    const sb = sandbox(); const log = fakeClaude(sb);
    writeFileSync(claudeMcpConfigPath({ CLAUDE_CONFIG_DIR: sb.claude }), JSON.stringify({ mcpServers: { 'botwarren-companion': { type: 'stdio', command: '/usr/bin/node', args: ['--disable-warning=ExperimentalWarning', OLD, 'channel'] }, other: { command: 'x' } } }));
    expect(registeredChannel({ CLAUDE_CONFIG_DIR: sb.claude })).toMatchObject({ command: '/usr/bin/node' });
    const r = sb.run(['claude', 'register-channel', '--yes'], envWith(sb));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('per-version path');
    expect(calls(log).map((c) => c.slice(0, 2).join(' '))).toEqual(['mcp remove', 'mcp add']);
    const doctor = sb.run(['claude', 'doctor'], envWith(sb));
    expect(doctor.stdout).toContain('registered with a per-version path');
  });

  it('does nothing when the registration already uses the stable launcher', () => {
    const sb = sandbox(); const log = fakeClaude(sb);
    installLauncher(sb.companion, { node: process.execPath, script: cli, version: 'test' });
    writeFileSync(claudeMcpConfigPath({ CLAUDE_CONFIG_DIR: sb.claude }), JSON.stringify({ mcpServers: { 'botwarren-companion': { command: process.execPath, args: ['--disable-warning=ExperimentalWarning', sb.launcher, 'channel'] } } }));
    const r = sb.run(['claude', 'register-channel', '--yes'], envWith(sb));
    expect(r.stdout).toContain('Already registered with the stable launcher');
    expect(calls(log)).toEqual([]);
  });

  it('with no terminal and no --yes it prints the command and says to re-run with --yes; it does not run claude', () => {
    const sb = sandbox(); const log = fakeClaude(sb);
    const r = sb.run(['claude', 'register-channel'], envWith(sb));
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('claude mcp add --scope user botwarren-companion --');
    expect(r.stdout).toContain('Re-run with --yes to apply it.');
    expect(calls(log)).toEqual([]);
  });

  it('when claude fails it says so and prints the command to run by hand', () => {
    const sb = sandbox(); fakeClaude(sb, 3);
    const r = sb.run(['claude', 'register-channel', '--yes'], envWith(sb));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('could not run "claude mcp add"');
    expect(r.stderr).toContain('claude mcp add --scope user botwarren-companion');
  });

  it('with no claude command at all it says so instead of crashing', () => {
    const sb = sandbox();
    const r = sb.run(['claude', 'register-channel', '--yes'], envWith(sb));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('could not run "claude mcp add"');
  });
});

describe('where Claude Code keeps its MCP servers', () => {
  it('~/.claude.json, or $CLAUDE_CONFIG_DIR/.claude.json when that is set', () => {
    expect(claudeMcpConfigPath({ HOME: '/h' })).toBe(join('/h', '.claude.json'));
    expect(claudeMcpConfigPath({ HOME: '/h', CLAUDE_CONFIG_DIR: '/c' })).toBe(join('/c', '.claude.json'));
    expect(registeredChannel({ HOME: join(tmp(), 'none') })).toBeNull();
  });
});

describe('alerts: the computer-side switches', () => {
  it('shows what an alert says, and the master switch, idle turns and quiet hours are saved in config.json', () => {
    const sb = sandbox();
    const show = sb.run(['alerts']);
    expect(show.status).toBe(0);
    expect(show.stdout).toContain('"An agent is waiting for you"');
    expect(show.stdout).toContain('phone alerts from this computer: on');
    expect(sb.run(['alerts', 'off']).stdout).toContain('phone alerts from this computer: off');
    expect(new Store(sb.companion).config().alerts.enabled).toBe(false);
    sb.run(['alerts', 'on']); sb.run(['alerts', 'idle', 'on']);
    expect(new Store(sb.companion).config().alerts).toMatchObject({ enabled: true, idle: true });
    expect(sb.run(['alerts', 'quiet', '22:30-06:45']).stdout).toContain('quiet hours: 22:30 to 06:45');
    expect(new Store(sb.companion).config().alerts.quiet).toEqual({ on: true, start: '22:30', end: '06:45' });
    expect(sb.run(['alerts', 'quiet', '25:00-06:00']).status).toBe(2);
    expect(sb.run(['alerts', 'quiet', 'off']).status).toBe(0);
    expect(new Store(sb.companion).config().alerts.quiet.on).toBe(false);
    expect(sb.run(['alerts', 'bogus']).status).toBe(2);
  });
});

describe.skipIf(posixOnly)('item 3: enrol waits for the service-restarted daemon', () => {
  it('at a terminal, enrol stops the running daemon, waits until the service has started it again, and says so', async () => {
    const { run: runCommand } = await import('../src/commands.ts');
    const root = tmp(); const home = join(root, 'companion'); const userHome = join(root, 'user');
    // a service unit exists on this (pretend) computer; HOME and XDG point at the temporary folder so no real unit is ever seen
    mkdirSync(join(userHome, '.config', 'systemd', 'user'), { recursive: true });
    writeFileSync(join(userHome, '.config', 'systemd', 'user', 'botwarren-companion.service'), '');
    const saved = { env: process.env.BOTWARREN_COMPANION_HOME, home: process.env.HOME, xdg: process.env.XDG_CONFIG_HOME, tty: Object.getOwnPropertyDescriptor(process.stdin, 'isTTY') };
    process.env.BOTWARREN_COMPANION_HOME = home; process.env.HOME = userHome; delete process.env.XDG_CONFIG_HOME;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    let printed = ''; const write = process.stdout.write.bind(process.stdout); 
    process.stdout.write = ((x: string | Uint8Array) => { printed += String(x); return true; }) as typeof process.stdout.write;
    const live: Daemon[] = [];
    try {
      const a = await startDaemon({ dir: home, env: { BOTWARREN_COMPANION_HOME: home }, socketWatchMs: 0 }); live.push(a);
      const store = new Store(home); const cfg = store.config(); cfg.allowRelayHosts = ['127.0.0.1']; store.saveConfig(cfg); // never a real relay from a test
      const server = await generateIdentity(true);
      const enrolment = JSON.stringify({ v: 1, relayUrl: 'ws://127.0.0.1:9', acct: 'acct-aaaaaaaaaaaaaaaa', ticket: await signTicket(server, { v: 1, acct: 'acct-aaaaaaaaaaaaaaaa', host: a.host.hostId, hostSig: a.host.hostSigPub, iat: Date.now(), exp: Date.now() + 1e9 }) });
      // the "service": a new daemon appears a second and a half after the old one was told to stop
      const service = new Promise<void>((ok) => { setTimeout(() => { void startDaemon({ dir: home, env: { BOTWARREN_COMPANION_HOME: home }, socketWatchMs: 0 }).then((d) => { live.push(d); ok(); }); }, 1500); });
      const code = await runCommand(['enroll'], { script: cli, node: process.execPath, tty: true, ask: async () => enrolment });
      await service;
      expect(code).toBe(0);
      expect(printed).toContain('Waiting for the service to start it again');
      expect(printed).toMatch(/The daemon is back/);
      expect(live).toHaveLength(2);
      expect(live[1]!.host.store.enrollment()?.acct).toBe('acct-aaaaaaaaaaaaaaaa'); // the new daemon started WITH the enrolment
    } finally {
      process.stdout.write = write;
      for (const d of live) await d.stop();
      if (saved.env === undefined) delete process.env.BOTWARREN_COMPANION_HOME; else process.env.BOTWARREN_COMPANION_HOME = saved.env;
      if (saved.home === undefined) delete process.env.HOME; else process.env.HOME = saved.home;
      if (saved.xdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = saved.xdg;
      if (saved.tty) Object.defineProperty(process.stdin, 'isTTY', saved.tty); else delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
  }, 60_000);
});

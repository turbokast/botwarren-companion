/**
 * The interactive commands of botwarren-companion. Licence: Apache-2.0.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import qrcode from 'qrcode-generator';
import { startDaemon } from './daemon.ts';
import { connectDaemon, waitForRestart, type DaemonLink } from './ipc.ts';
import { homeDir, socketPath } from './paths.ts';
import { CompanionHost } from './host.ts';
import { EnrollmentSchema, Store, type AlertsConfig } from './store.ts';
import { relayAllowed } from './policy.ts';
import { Ticket, unb64u } from './protocol/index.ts';
import { HOOK_EVENTS, hasOurHooks, quoteWord, readSettings, settingsPath, simpleDiff, versionedHooks, withHooks, withoutHooks, writeSettings } from './claude/settings.ts';
import { installLauncher, isVersionedPath, launcherHealth, launcherPath } from './claude/launcher.ts';
import { CHANNEL_NAME } from './claude/channel.ts';
import { noDaemonMessage, serviceUnit, versionMismatchMessage } from './service.ts';
import { parseClock } from './alerts.ts';

import { VERSION } from './version.ts';
export { VERSION };

/** `tty`: a person is at the other end of stdin and can answer a question; false when a script, a pipe or another program runs the command */
export interface Ctx { script: string; node: string; ask: (q: string) => Promise<string>; tty: boolean }

const out = (s = ''): void => { process.stdout.write(s + '\n'); };
const flag = (a: string[], name: string): string | undefined => { const i = a.indexOf(name); return i >= 0 ? a[i + 1] : undefined; };
const has = (a: string[], name: string): boolean => a.includes(name);

/** a QR code as terminal text (two rows per line with half blocks) */
export function qrText(data: string): string {
  const qr = qrcode(0, 'M'); qr.addData(data); qr.make();
  const n = qr.getModuleCount(); const lines: string[] = [];
  const dark = (r: number, c: number): boolean => r >= 0 && c >= 0 && r < n && c < n && qr.isDark(r, c);
  for (let r = -2; r < n + 2; r += 2) {
    let l = '';
    for (let c = -2; c < n + 2; c++) { const t = dark(r, c); const b = dark(r + 1, c); l += t && b ? '█' : t ? '▀' : b ? '▄' : ' '; }
    lines.push(l);
  }
  return lines.join('\n');
}

export async function run(argv: string[], ctx: Ctx): Promise<number> {
  const dir = homeDir();
  const [cmd, sub] = [argv[0], argv[1]];
  switch (cmd) {
    case undefined: case 'help': case '--help': return help();
    case 'version': case '--version': out(VERSION); return 0;
    case 'daemon': return daemon(ctx);
    case 'init': return init(dir, has(argv, '--json'));
    case 'enroll': return enroll(dir, ctx);
    case 'pair': return pair(dir);
    case 'alerts': return alerts(dir, argv.slice(1));
    case 'status': return status(dir);
    case 'devices': return devices(dir, argv.slice(1));
    case 'pause': case 'resume': return pause(dir, cmd === 'pause');
    case 'confirm': return confirm(dir, ctx);
    case 'log': { for (const l of new Store(dir).auditTail(Number(sub) || 50)) out(l); return 0; }
    case 'claude': return claude(dir, argv.slice(1), ctx);
    case 'uninstall': return uninstall(dir, argv.slice(1), ctx);
    default: process.stderr.write(`unknown command "${cmd}"\n`); help(); return 2;
  }
}

function help(): number {
  out(`botwarren-companion ${VERSION}
Opt-in, end-to-end encrypted remote approvals for your coding agents (Apache-2.0).

  daemon                 run the companion in the foreground
  init [--json]          create this computer's key (prints the public key)
  enroll                 save the enrolment: paste it from your account page (at a terminal), or JSON on stdin (your ship agent does this)
  pair                   show a code and QR to pair a phone (confirm the phone here)
  alerts [on|off]        phone alerts ("an agent is waiting for you"): status, master switch;
                         alerts idle on|off  also alert when an agent finished a turn;  alerts quiet 22:00-07:00 | off
  status                 relay, devices, sessions
  devices                list paired devices;  devices revoke <name>
  pause | resume         stop or resume answering from devices
  confirm                answer "confirm on this computer" requests
  log [n]                the local audit log
  claude install-hooks [--scope user|project|local] [--yes] [--hold SECONDS]
                         (also rewrites hooks written by an older version that point at a per-version path; needs --yes when no terminal is attached)
  claude uninstall-hooks [--scope ...]
  claude register-channel [--yes]   register the MCP channel with Claude Code (runs "claude mcp add" with --yes)
  claude doctor
  uninstall [--purge] [--yes]   revoke all devices, stop the daemon, remove the hooks`);
  return 0;
}

async function daemon(ctx: Ctx): Promise<number> {
  let d;
  try { d = await startDaemon({ log: (l) => out(l), entry: { node: ctx.node, script: ctx.script, version: VERSION } }); } catch (e) { process.stderr.write(`${(e as Error).message}\n`); return 1; }
  // SIGHUP: check at once that the socket file is still ours (it is also checked every few seconds), e.g. after something cleaned the config directory
  if (platform() !== 'win32') process.on('SIGHUP', () => { void d.server.verify(); });
  await new Promise<void>((ok) => { for (const s of ['SIGINT', 'SIGTERM'] as const) process.on(s, () => ok()); });
  await d.stop();
  return 0;
}

async function init(dir: string, json: boolean): Promise<number> {
  const store = new Store(dir);
  const host = new CompanionHost({ store, confirmer: async () => false });
  await host.init();
  if (json) out(JSON.stringify({ hostId: host.hostId, hostSig: host.hostSigPub }));
  else { out(`host id   ${host.hostId}`); out(`public key ${host.hostSigPub}`); out(`keys are stored only in ${dir}`); }
  return 0;
}

/**
 * Saves the enrolment: JSON on stdin (the ship agent writes it), or, at a terminal, pasted from the Botwarren account page ("Enrol a computer"), for an
 * install without a ship agent. The page needs only this computer's PUBLIC key, which is printed here; nothing secret is pasted anywhere.
 */
async function enroll(dir: string, ctx: Ctx): Promise<number> {
  const store = new Store(dir);
  const host = new CompanionHost({ store, confirmer: async () => false });
  await host.init();
  let raw: string;
  const typed = process.stdin.isTTY === true;
  if (typed) {
    out('Enrol this computer with your Botwarren account (for remote approvals).');
    out('  1. Open https://botwarren.com/account and find "Remote approvals" (it is there once your account has been enabled and you agreed).');
    out('  2. Choose "Enrol a computer" and paste this computer\'s public key (not secret):');
    out(); out(`     ${host.hostSigPub}`); out();
    raw = await ctx.ask('  3. Paste the enrolment text the page shows, then press Enter: ');
  } else {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    raw = Buffer.concat(chunks).toString('utf8');
  }
  let e;
  try { e = EnrollmentSchema.parse(JSON.parse(raw.trim())); } catch { process.stderr.write('enrolment is not valid\n'); return 1; }
  let ticket;
  try { ticket = Ticket.parse(JSON.parse(new TextDecoder().decode(unb64u(e.ticket.j)))); } catch { process.stderr.write('ticket is not valid\n'); return 1; }
  if (ticket.host !== host.hostId) { process.stderr.write('this ticket is for another computer\n'); return 1; }
  if (ticket.exp <= Date.now()) { process.stderr.write('this ticket has expired\n'); return 1; }
  if (!relayAllowed(e.relayUrl, store.config().allowRelayHosts)) { process.stderr.write('that relay address is not allowed by this computer\'s settings\n'); return 1; }
  store.writeJson('enrollment.json', e);
  store.audit('enrolled', { acct: ticket.acct.slice(0, 6) });
  out('enrolled. (re)start the daemon to connect.');
  if (typed) {
    // a service manager (or the ship agent) starts it again with the enrolment; with none, start it yourself
    const l = await link(dir);
    const unit = serviceUnit();
    if (l) {
      await l.request('shutdown'); l.close();
      if (!unit) { out('The running daemon was stopped so it restarts with the enrolment. No background service is installed: start it again with: botwarren-companion daemon (leave it running).'); return 0; }
      out('The running daemon was stopped so it restarts with the enrolment. Waiting for the service to start it again...');
      const st = await waitForRestart(dir, { timeoutMs: 40_000 });
      if (!st) { process.stderr.write(`The daemon did not come back within 40 seconds. Restart the service: ${unit.restart}\n`); return 1; }
      const s = st.status as { relay?: string } | undefined;
      out(s?.relay === 'online' ? 'The daemon is back and connected to the relay. Pair a phone with: botwarren-companion pair' : `The daemon is back (relay: ${String(s?.relay ?? 'unknown')}). Pair a phone with: botwarren-companion pair`);
    } else if (unit) out(`No daemon is running. The background service is installed but not answering: start it with: ${unit.restart}`);
    else out('Start the daemon with: botwarren-companion daemon (leave it running; the installer\'s --service does this for you), then pair a phone with: botwarren-companion pair');
  }
  return 0;
}

async function link(dir: string): Promise<DaemonLink | null> { return connectDaemon(dir); }

/** the daemon, or null after saying exactly what is wrong (not running / stale socket) and what to do (restart the service when one is installed) */
async function needLink(dir: string): Promise<DaemonLink | null> {
  const l = await connectDaemon(dir);
  if (l) return l;
  process.stderr.write(noDaemonMessage({ socketFile: existsSync(socketPath(dir)), unit: serviceUnit() }) + '\n');
  return null;
}

async function pair(dir: string): Promise<number> {
  const l = await needLink(dir);
  if (!l) return 1;
  const done = new Promise<number>((resolve) => {
    l.onEvent((ev) => {
      if (ev.t !== 'pair_confirm') return;
      out(); out('A device wants to pair.'); out(`  name   ${String(ev.device)}`); out(`  check  ${String(ev.sas)}`);
      out('Does the phone show the same number? If you did not just start this pairing, answer n.');
      const rl = (async () => { const { createInterface } = await import('node:readline'); const i = createInterface({ input: process.stdin, output: process.stdout }); i.question('[y] yes, pair it   [n] no : ', (a) => { i.close(); void l.request('pair_decision', { cid: ev.cid, ok: a.trim().toLowerCase().startsWith('y') }).then(() => { out(a.trim().toLowerCase().startsWith('y') ? 'paired.' : 'declined.'); resolve(0); }); }); })();
      void rl;
    });
  });
  const r = await l.request('pair_start');
  if (!r.ok) { process.stderr.write(r.error === 'device_limit' ? 'eight devices are paired already; remove one first\n' : 'could not start pairing\n'); l.close(); return 1; }
  const cfg = new Store(dir).config(); const enr = new Store(dir).enrollment();
  const relay = (enr?.relayUrl || cfg.relayUrl).replace(/^ws/, 'http').replace(/\/v1\/ws$/, '').replace(/\/$/, '');
  const url = `${relay}/#/pair/${String(r.code)}`;
  out(); out('Pair a phone. Valid 10 minutes, one use.'); out(`On the phone open  ${relay}`); out('and type this code, or scan the QR:'); out(); out(`   ${String(r.code)}`); out();
  out(qrText(url)); out(); out('waiting for the phone...');
  const code = await Promise.race([done, new Promise<number>((ok) => setTimeout(() => ok(3), Math.max(1000, Number(r.expiresAt) - Date.now())))]);
  if (code === 3) out('the code expired.');
  l.close();
  return code;
}

async function status(dir: string): Promise<number> {
  const store = new Store(dir);
  const l = await link(dir);
  if (!l) { out('daemon: not running'); out(noDaemonMessage({ socketFile: existsSync(socketPath(dir)), unit: serviceUnit() }).split('\n').slice(1).join('\n')); out(`enrolled: ${store.enrollment() ? 'yes' : 'no'}`); out(`devices: ${store.devices().length}`); out(`paused: ${store.config().paused}`); return 0; }
  const r = await l.request('status'); l.close();
  const s = r.status as { version?: string; relay: string; enrolled: boolean; paused: boolean; devices: { id: string; name: string; lastSeen: number | null }[]; sessions: { label: string; status: string; waiting: boolean; channel: boolean; masked: number }[]; alerts?: { enabled: boolean; phones: number }; pendingConfirmations: number };
  out(`daemon: running${s.version ? ` (version ${s.version})` : ''}`);
  const mm = versionMismatchMessage({ running: s.version, installed: VERSION, unit: serviceUnit() });
  if (mm) out(mm);
  out(`relay: ${s.relay}   enrolled: ${s.enrolled}   paused: ${s.paused}`);
  out(`devices (${s.devices.length}): ${s.devices.map((d) => d.name).join(', ') || 'none'}`);
  if (s.alerts) out(`phone alerts: ${s.alerts.enabled ? 'on' : 'OFF'}, ${s.alerts.phones} phone(s) subscribed`);
  for (const x of s.sessions) out(`  ${x.label}  ${x.status}${x.waiting ? '  WAITING' : ''}${x.channel ? '  channel' : ''}${x.masked ? `  ${x.masked} masked` : ''}`);
  if (s.pendingConfirmations) out(`${s.pendingConfirmations} request(s) need your confirmation: run botwarren-companion confirm`);
  return 0;
}

async function devices(dir: string, a: string[]): Promise<number> {
  const store = new Store(dir);
  if (a[1] === 'revoke') {
    const who = a[2];
    if (!who) { process.stderr.write('usage: devices revoke <name or id>\n'); return 2; }
    const l = await link(dir);
    if (l) { const r = await l.request('revoke_device', { device: who }); l.close(); out(r.ok ? 'revoked.' : 'no such device.'); return r.ok ? 0 : 1; }
    const left = store.devices().filter((d) => d.name !== who && !d.id.startsWith(who));
    if (left.length === store.devices().length) { out('no such device.'); return 1; }
    store.saveDevices(left); out('removed from this computer. The relay learns about it when the daemon next runs; start it to finish the revocation.'); return 0;
  }
  for (const d of store.devices()) out(`${d.id.slice(0, 8)}  ${d.name}  paired ${new Date(d.pairedAt).toISOString()}  seen ${d.lastSeen ? new Date(d.lastSeen).toISOString() : 'never'}`);
  return 0;
}

function pause(dir: string, on: boolean): number {
  const store = new Store(dir); const c = store.config(); c.paused = on; store.saveConfig(c); store.audit(on ? 'paused' : 'resumed');
  out(on ? 'paused: no device can answer your agents until you resume.' : 'resumed.');
  return 0;
}

async function confirm(dir: string, ctx: Ctx): Promise<number> {
  const l = await needLink(dir);
  if (!l) return 1;
  out('waiting for requests that need your confirmation (Ctrl-C to stop)...');
  l.onEvent((ev) => {
    if (ev.t !== 'confirm') return;
    const r = ev.req as { kind: string; agent: string; label: string; tool?: string; preview: string; device: string };
    out(); out(r.kind === 'reply' ? 'Remote reply requested' : 'Remote approve requested'); out(`  agent  ${r.agent} · ${r.label}`); if (r.tool) out(`  asks   ${r.tool}`); out(`  text   ${r.preview.slice(0, 300)}`); out(`  from   ${r.device}`);
    void ctx.ask('[y] allow   [n] deny : ').then((a) => l.request('confirm_decision', { cid: ev.cid, ok: a.trim().toLowerCase().startsWith('y') }));
  });
  await l.request('confirm_attach');
  await new Promise<void>((ok) => { for (const s of ['SIGINT', 'SIGTERM'] as const) process.on(s, () => ok()); });
  l.close();
  return 0;
}

/** where Claude Code keeps its user-level MCP servers: `~/.claude.json`, or `$CLAUDE_CONFIG_DIR/.claude.json` when that is set */
export function claudeMcpConfigPath(env: Record<string, string | undefined> = process.env): string {
  return join(env.CLAUDE_CONFIG_DIR ?? env.HOME ?? env.USERPROFILE ?? homedir(), '.claude.json');
}

/** the registered channel server, if any: its command and arguments as Claude Code has them */
export function registeredChannel(env: Record<string, string | undefined> = process.env): { command: string; args: string[] } | null {
  try {
    const j = JSON.parse(readFileSync(claudeMcpConfigPath(env), 'utf8')) as { mcpServers?: Record<string, { command?: unknown; args?: unknown }> };
    const e = j.mcpServers?.[CHANNEL_NAME];
    if (!e || typeof e.command !== 'string') return null;
    return { command: e.command, args: Array.isArray(e.args) ? e.args.filter((a): a is string => typeof a === 'string') : [] };
  } catch { return null; }
}

/** the lines to re-run with --yes when nothing can answer a question here */
const needYes = (what: string): void => { out(`Not applied: no terminal is attached to ask "${what}". Nothing was changed.`); out('Re-run with --yes to apply it.'); };

/** at a terminal, ask; with no terminal, never wait for an answer that cannot come */
async function confirmed(a: string[], ctx: Ctx, question: string, what: string): Promise<boolean> {
  if (has(a, '--yes')) return true;
  if (!ctx.tty) { needYes(what); return false; }
  const ok = (await ctx.ask(`${question} [y/N] `)).trim().toLowerCase().startsWith('y');
  if (!ok) out('nothing changed.');
  return ok;
}

async function claude(dir: string, a: string[], ctx: Ctx): Promise<number> {
  const scope = (flag(a, '--scope') ?? 'user') as 'user' | 'project' | 'local';
  const path = settingsPath(scope, process.cwd());
  // Claude Code's settings and MCP configuration name the STABLE launcher in the companion's own directory, never a per-version path
  const launcher = launcherPath(dir);
  const entry = { node: ctx.node, script: ctx.script, version: VERSION };
  switch (a[0]) {
    case 'install-hooks': {
      const store = new Store(dir);
      const hold = Number(flag(a, '--hold') ?? store.config().holdSeconds);
      let cur;
      try { cur = readSettings(path); } catch (e) { process.stderr.write(`cannot read ${path}: ${(e as Error).message}\n`); return 1; }
      const stale = versionedHooks(cur);
      const next = withHooks(cur, { node: ctx.node, script: launcher, holdSeconds: hold });
      const diff = simpleDiff(JSON.stringify(cur, null, 2), JSON.stringify(next, null, 2));
      if (!diff) { out('hooks are already installed.'); return 0; }
      if (stale.length) { out(`${stale.length} hook(s) from an older version point at a per-version path, which breaks on every update:`); out(`  ${stale[0]}`); out(`They will be rewritten to the stable launcher ${launcher}. A backup of ${path} is written first.`); out(); }
      out(`This will change ${path}:`); out(diff); out();
      out('The hooks only report to your own companion on this computer and fail open: if it is not running, Claude Code behaves as before.');
      if (!(await confirmed(a, ctx, 'Install these hooks?', 'install these hooks'))) return 1;
      installLauncher(dir, entry);
      const backup = writeSettings(path, next);
      if (hold !== store.config().holdSeconds) { const c = store.config(); c.holdSeconds = hold; store.saveConfig(c); }
      store.audit('claude_hooks_installed', { scope, migrated: stale.length });
      out(`done.${backup ? ` backup: ${backup}` : ''}${stale.length ? ' (migrated from a per-version path)' : ''}`);
      return 0;
    }
    case 'uninstall-hooks': {
      let cur;
      try { cur = readSettings(path); } catch { return 1; }
      if (!hasOurHooks(cur)) { out('no companion hooks found.'); return 0; }
      const backup = writeSettings(path, withoutHooks(cur));
      new Store(dir).audit('claude_hooks_removed', { scope });
      out(`removed.${backup ? ` backup: ${backup}` : ''}`); return 0;
    }
    case 'register-channel': {
      out('The channel lets your phone answer permission prompts and send preset replies while the terminal dialog stays live.');
      out('It is a Claude Code research preview. It is registered once (user scope) and Claude Code is then started with the development flag.');
      const win = platform() === 'win32';
      const add = ['mcp', 'add', '--scope', 'user', CHANNEL_NAME, '--', ctx.node, '--disable-warning=ExperimentalWarning', launcher, 'channel'];
      const remove = ['mcp', 'remove', '--scope', 'user', CHANNEL_NAME];
      const show = (args: string[]): string => ['claude', ...args.map((x) => quoteWord(x, win))].join(' ');
      const reg = registeredChannel();
      const regPath = reg ? [reg.command, ...reg.args].join(' ') : '';
      const stale = !!reg && (isVersionedPath(regPath) || !regPath.includes('launch.mjs'));
      if (reg && !stale) { out(`Already registered with the stable launcher (${claudeMcpConfigPath()}). Nothing to do.`); installLauncher(dir, entry); out(`Start Claude Code with: claude --dangerously-load-development-channels server:${CHANNEL_NAME}`); return 0; }
      if (stale) { out(`The existing registration points at ${isVersionedPath(regPath) ? 'a per-version path (it breaks on every update)' : 'a path that is not the stable launcher'}: it is replaced.`); }
      const steps = stale ? [remove, add] : [add];
      out(); for (const st of steps) out(`  ${show(st)}`); out();
      if (win) { out('Run the line(s) above in a terminal where the "claude" command works (they are not run automatically on Windows). Then start Claude Code with:'); out(`  claude --dangerously-load-development-channels server:${CHANNEL_NAME}`); installLauncher(dir, entry); return 0; }
      if (!has(a, '--yes') && !ctx.tty) { needYes('register the channel'); return 1; }
      if (!has(a, '--yes') && !(await ctx.ask('Run this for you? [y/N] ')).trim().toLowerCase().startsWith('y')) { out(`nothing changed. Run the line(s) yourself, then start Claude Code with: claude --dangerously-load-development-channels server:${CHANNEL_NAME}`); return 1; }
      installLauncher(dir, entry);
      for (const st of steps) {
        const r = spawnSync('claude', st, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 30_000 });
        if (r.error || r.status !== 0) { if (st === remove) continue; process.stderr.write(`could not run "claude mcp add" (${r.error ? r.error.message : `exit ${String(r.status)}`}). Run it yourself: ${show(st)}\n`); return 1; }
      }
      new Store(dir).audit('claude_channel_registered', { migrated: stale });
      out('registered. Start Claude Code with:'); out(`  claude --dangerously-load-development-channels server:${CHANNEL_NAME}`);
      return 0;
    }
    case 'doctor': {
      const l = await link(dir);
      out(`daemon          ${l ? 'running' : 'NOT running'}`);
      if (!l) for (const line of noDaemonMessage({ socketFile: existsSync(socketPath(dir)), unit: serviceUnit() }).split('\n').slice(1)) out(`                ${line}`);
      const h = launcherHealth(dir);
      out(`launcher        ${h.ok ? `ok (companion ${h.version})` : h.why === 'script_missing' ? 'entry.json names a file that no longer exists: start the daemon again (it rewrites it)' : 'not written yet: run "claude install-hooks" or start the daemon'}`);
      for (const sc of ['user', 'project'] as const) {
        const p = settingsPath(sc, process.cwd()); let ok = false; let stale = 0;
        try { const s = readSettings(p); ok = hasOurHooks(s); stale = versionedHooks(s).length; } catch { /* none */ }
        out(`hooks (${sc})    ${ok ? (stale ? `installed, but ${stale} point at a per-version path: run "botwarren-companion claude install-hooks --yes"` : 'installed') : 'not installed'}  ${existsSync(p) ? p : '(no settings file)'}`);
      }
      const reg = registeredChannel();
      out(`channel         ${reg ? (isVersionedPath([reg.command, ...reg.args].join(' ')) ? 'registered with a per-version path: run "botwarren-companion claude register-channel --yes"' : 'registered') : 'not registered (claude register-channel)'}`);
      out(`hook events     ${HOOK_EVENTS.join(', ')}`);
      out();
      out('Live checks to run once on this machine (not run automatically):');
      out('  1. Start Claude Code with the channel flag; ask it to run a command that needs permission. The terminal dialog AND your phone should both show it.');
      out('  2. Hold test: set holdSeconds (install-hooks --hold 30), trigger a permission prompt WITHOUT the channel; if the terminal dialog is blocked while the');
      out('     hook waits, set holdSeconds back to 0 (the default).');
      l?.close();
      return 0;
    }
    default: process.stderr.write('usage: claude install-hooks | uninstall-hooks | register-channel | doctor\n'); return 2;
  }
}

/** `alerts`: what phone alerts are doing and the computer-side switches (each phone also has its own switch on its page) */
async function alerts(dir: string, a: string[]): Promise<number> {
  const store = new Store(dir); const c = store.config(); const al: AlertsConfig = c.alerts;
  const save = (): void => { c.alerts = al; store.saveConfig(c); };
  const sub = a[0];
  if (sub === 'on' || sub === 'off') { al.enabled = sub === 'on'; save(); store.audit(`alerts_master_${sub}`); out(`phone alerts from this computer: ${sub}. (${sub === 'on' ? 'a phone also needs its own Alerts switch on' : 'no phone gets an alert while this is off'})`); return 0; }
  if (sub === 'idle' && (a[1] === 'on' || a[1] === 'off')) { al.idle = a[1] === 'on'; save(); out(`alerts when an agent finishes a turn: ${a[1]}`); return 0; }
  if (sub === 'quiet') {
    if (a[1] === 'off') { al.quiet.on = false; save(); out('quiet hours: off'); return 0; }
    const m = /^(\d\d:\d\d)-(\d\d:\d\d)$/.exec(a[1] ?? '');
    if (!m || parseClock(m[1]!) === null || parseClock(m[2]!) === null) { process.stderr.write('usage: alerts quiet HH:MM-HH:MM (this computer\'s clock, e.g. 22:00-07:00) | alerts quiet off\n'); return 2; }
    al.quiet = { on: true, start: m[1]!, end: m[2]! }; save(); out(`quiet hours: ${m[1]} to ${m[2]} (this computer's clock). Alerts held back then are sent afterwards only if something is still waiting.`); return 0;
  }
  if (sub !== undefined) { process.stderr.write('usage: alerts [on|off] | alerts idle on|off | alerts quiet HH:MM-HH:MM|off\n'); return 2; }
  const phones = store.devices().filter((d) => d.push);
  const dl = await link(dir);
  if (dl) { const st = (await dl.request('status')).status as { version?: string } | undefined; dl.close(); const mm = versionMismatchMessage({ running: st?.version, installed: VERSION, unit: serviceUnit() }); if (mm) out(mm); }
  out(`phone alerts from this computer: ${al.enabled ? 'on' : 'OFF'}${c.paused ? '   (paused: nothing is sent while remote answers are paused)' : ''}`);
  out(`phones with alerts on: ${phones.length ? phones.map((d) => d.name).join(', ') : 'none (turn Alerts on in the phone page: gear icon)'}`);
  out(`an alert says only "An agent is waiting for you": no tool, command, project or session name.`);
  out(`sent after a request has waited ${al.delaySeconds}s; one per waiting episode; at most one every ${al.minGapSeconds}s and ${al.maxPerHour} an hour`);
  out(`finished turns (agent waits for its next instruction): ${al.idle ? 'alert' : 'no alert'}   quiet hours: ${al.quiet.on ? `${al.quiet.start} to ${al.quiet.end}` : 'off'}`);
  return 0;
}

async function uninstall(dir: string, a: string[], ctx: Ctx): Promise<number> {
  const l = await link(dir);
  if (l) { await l.request('revoke_all', { reason: 'removed' }); await l.request('shutdown'); l.close(); out('devices revoked, daemon stopped.'); }
  else out('daemon was not running: paired devices are not told. Revoke them in the phone page too.');
  for (const sc of ['user'] as const) { const p = settingsPath(sc, process.cwd()); try { const cur = readSettings(p); if (hasOurHooks(cur)) { writeSettings(p, withoutHooks(cur)); out(`removed the hooks from ${p}`); } } catch { /* none */ } }
  if (has(a, '--purge')) {
    if (has(a, '--yes') || (ctx.tty && (await ctx.ask(`Delete ${dir} including this computer's keys? [y/N] `)).trim().toLowerCase().startsWith('y'))) { rmSync(dir, { recursive: true, force: true }); out('deleted.'); }
    else if (!ctx.tty) out(`Not deleted: no terminal is attached to ask. Re-run with --yes to delete ${dir} including this computer's keys.`);
  } else out(`kept ${dir} (keys, audit log). Use --purge to delete it.`);
  return 0;
}

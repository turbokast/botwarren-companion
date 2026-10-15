/**
 * The interactive commands of botwarren-companion. Licence: Apache-2.0.
 */
import { existsSync, rmSync } from 'node:fs';
import qrcode from 'qrcode-generator';
import { startDaemon } from './daemon.ts';
import { connectDaemon, type DaemonLink } from './ipc.ts';
import { homeDir } from './paths.ts';
import { CompanionHost } from './host.ts';
import { EnrollmentSchema, Store } from './store.ts';
import { relayAllowed } from './policy.ts';
import { Ticket, unb64u } from './protocol/index.ts';
import { HOOK_EVENTS, hasOurHooks, readSettings, settingsPath, simpleDiff, withHooks, withoutHooks, writeSettings } from './claude/settings.ts';
import { CHANNEL_NAME } from './claude/channel.ts';

export const VERSION = '0.1.0';

export interface Ctx { script: string; node: string; ask: (q: string) => Promise<string> }

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
    case 'daemon': return daemon();
    case 'init': return init(dir, has(argv, '--json'));
    case 'enroll': return enroll(dir);
    case 'pair': return pair(dir);
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
  enroll                 save the enrolment (JSON on stdin; written by your ship agent)
  pair                   show a code and QR to pair a phone (confirm the phone here)
  status                 relay, devices, sessions
  devices                list paired devices;  devices revoke <name>
  pause | resume         stop or resume answering from devices
  confirm                answer "confirm on this computer" requests
  log [n]                the local audit log
  claude install-hooks [--scope user|project|local] [--yes] [--hold SECONDS]
  claude uninstall-hooks [--scope ...]
  claude register-channel
  claude doctor
  uninstall [--purge] [--yes]   revoke all devices, stop the daemon, remove the hooks`);
  return 0;
}

async function daemon(): Promise<number> {
  const d = await startDaemon({ log: (l) => out(l) });
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

async function enroll(dir: string): Promise<number> {
  const store = new Store(dir);
  const host = new CompanionHost({ store, confirmer: async () => false });
  await host.init();
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  let e;
  try { e = EnrollmentSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { process.stderr.write('enrolment is not valid\n'); return 1; }
  let ticket;
  try { ticket = Ticket.parse(JSON.parse(new TextDecoder().decode(unb64u(e.ticket.j)))); } catch { process.stderr.write('ticket is not valid\n'); return 1; }
  if (ticket.host !== host.hostId) { process.stderr.write('this ticket is for another computer\n'); return 1; }
  if (ticket.exp <= Date.now()) { process.stderr.write('this ticket has expired\n'); return 1; }
  if (!relayAllowed(e.relayUrl, store.config().allowRelayHosts)) { process.stderr.write('that relay address is not allowed by this computer\'s settings\n'); return 1; }
  store.writeJson('enrollment.json', e);
  store.audit('enrolled', { acct: ticket.acct.slice(0, 6) });
  out('enrolled. (re)start the daemon to connect.');
  return 0;
}

async function link(dir: string): Promise<DaemonLink | null> { return connectDaemon(dir); }

async function pair(dir: string): Promise<number> {
  const l = await link(dir);
  if (!l) { process.stderr.write('the companion daemon is not running (start it with: botwarren-companion daemon)\n'); return 1; }
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
  if (!l) { out('daemon: not running'); out(`enrolled: ${store.enrollment() ? 'yes' : 'no'}`); out(`devices: ${store.devices().length}`); out(`paused: ${store.config().paused}`); return 0; }
  const r = await l.request('status'); l.close();
  const s = r.status as { relay: string; enrolled: boolean; paused: boolean; devices: { id: string; name: string; lastSeen: number | null }[]; sessions: { label: string; status: string; waiting: boolean; channel: boolean; masked: number }[]; pendingConfirmations: number };
  out('daemon: running'); out(`relay: ${s.relay}   enrolled: ${s.enrolled}   paused: ${s.paused}`);
  out(`devices (${s.devices.length}): ${s.devices.map((d) => d.name).join(', ') || 'none'}`);
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
  const l = await link(dir);
  if (!l) { process.stderr.write('the companion daemon is not running\n'); return 1; }
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

async function claude(dir: string, a: string[], ctx: Ctx): Promise<number> {
  const scope = (flag(a, '--scope') ?? 'user') as 'user' | 'project' | 'local';
  const path = settingsPath(scope, process.cwd());
  switch (a[0]) {
    case 'install-hooks': {
      const store = new Store(dir);
      const hold = Number(flag(a, '--hold') ?? store.config().holdSeconds);
      let cur;
      try { cur = readSettings(path); } catch (e) { process.stderr.write(`cannot read ${path}: ${(e as Error).message}\n`); return 1; }
      const next = withHooks(cur, { node: ctx.node, script: ctx.script, holdSeconds: hold });
      const diff = simpleDiff(JSON.stringify(cur, null, 2), JSON.stringify(next, null, 2));
      if (!diff) { out('hooks are already installed.'); return 0; }
      out(`This will change ${path}:`); out(diff); out();
      out('The hooks only report to your own companion on this computer and fail open: if it is not running, Claude Code behaves as before.');
      if (!has(a, '--yes') && !(await ctx.ask('Install these hooks? [y/N] ')).trim().toLowerCase().startsWith('y')) { out('nothing changed.'); return 1; }
      const backup = writeSettings(path, next);
      if (hold !== store.config().holdSeconds) { const c = store.config(); c.holdSeconds = hold; store.saveConfig(c); }
      store.audit('claude_hooks_installed', { scope });
      out(`done.${backup ? ` backup: ${backup}` : ''}`);
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
      out('It is a Claude Code research preview. Register it once, then start Claude Code with the development flag:');
      out(); out(`  claude mcp add --scope user ${CHANNEL_NAME} -- ${ctx.node} --disable-warning=ExperimentalWarning ${ctx.script} channel`);
      out(`  claude --dangerously-load-development-channels server:${CHANNEL_NAME}`); out();
      out('(On Team and Enterprise plans an organisation owner must enable channels.) Nothing was changed.');
      return 0;
    }
    case 'doctor': {
      const l = await link(dir);
      out(`daemon          ${l ? 'running' : 'NOT running'}`);
      for (const sc of ['user', 'project'] as const) { const p = settingsPath(sc, process.cwd()); let ok = false; try { ok = hasOurHooks(readSettings(p)); } catch { /* none */ } out(`hooks (${sc})    ${ok ? 'installed' : 'not installed'}  ${existsSync(p) ? p : '(no settings file)'}`); }
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

async function uninstall(dir: string, a: string[], ctx: Ctx): Promise<number> {
  const l = await link(dir);
  if (l) { await l.request('revoke_all', { reason: 'removed' }); await l.request('shutdown'); l.close(); out('devices revoked, daemon stopped.'); }
  else out('daemon was not running: paired devices are not told. Revoke them in the phone page too.');
  for (const sc of ['user'] as const) { const p = settingsPath(sc, process.cwd()); try { const cur = readSettings(p); if (hasOurHooks(cur)) { writeSettings(p, withoutHooks(cur)); out(`removed the hooks from ${p}`); } } catch { /* none */ } }
  if (has(a, '--purge')) {
    if (has(a, '--yes') || (await ctx.ask(`Delete ${dir} including this computer's keys? [y/N] `)).trim().toLowerCase().startsWith('y')) { rmSync(dir, { recursive: true, force: true }); out('deleted.'); }
  } else out(`kept ${dir} (keys, audit log). Use --purge to delete it.`);
  return 0;
}

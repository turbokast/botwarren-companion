/**
 * Command line for the adapters: `adapters`, `away`, and `<tool> install-hooks | remove-hooks | doctor` for each hook-family tool.
 * Every change to a tool's own configuration is user-initiated, shows the diff first, needs `--yes` when no terminal is attached, writes a backup, and
 * touches only entries that carry this companion's marker (a tool's own entries, Herdr's among them, are never edited). Licence: Apache-2.0.
 */
import { existsSync } from 'node:fs';
import type { Ctx } from './commands.ts';
import { connectDaemon } from './ipc.ts';
import { installLauncher, launcherPath } from './claude/launcher.ts';
import { readSettings, simpleDiff, writeSettings } from './claude/settings.ts';
import { readFileSync } from 'node:fs';
import { Store } from './store.ts';
import { ALL_MANIFESTS } from './adapters/builtin.ts';
import { codexHooksList, runCli, runCliWithPath, firstVersion } from './adapters/io.ts';
import { MUSE_PLUGIN_ID, musePluginDir, musePluginManifest, musePluginManifestPath } from './adapters/hookfamily/installers/muse.ts';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { familyHooksOf, withFamilyHooks, withoutFamilyHooks, type EventSpec, type HooksFile } from './adapters/hookfamily/hookfile.ts';
import { CODEX_EVENTS_SPEC, codexHooksPath } from './adapters/hookfamily/installers/codex.ts';

export interface Kit {
  out: (s?: string) => void;
  has: (a: string[], name: string) => boolean;
  flag: (a: string[], name: string) => string | undefined;
  confirmed: (a: string[], ctx: Ctx, question: string, what: string) => Promise<boolean>;
  version: string;
}

const isId = (s: string | undefined): s is string => !!s && ALL_MANIFESTS.some((m) => m.id === s);

// ------------------------------------------------------------------ away
/** "2h", "90m", "45" (minutes) -> minutes; null when it is not a duration */
export function parseDuration(s: string): number | null {
  const m = /^(\d{1,4})\s*(m|min|h|hr)?$/i.exec(s.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const mins = /^h/i.test(m[2] ?? '') ? n * 60 : n;
  return mins >= 1 && mins <= 1440 ? mins : null;
}

export async function awayCommand(dir: string, a: string[], _ctx: Ctx, kit: Kit): Promise<number> {
  const { out } = kit;
  const sub = a[0];
  const l = await connectDaemon(dir);
  if (!l) { process.stderr.write('the companion is not running: start it first (botwarren-companion status says how)\n'); return 1; }
  try {
    if (sub === 'on') {
      const f = kit.flag(a, '--for') ?? '2h';
      const mins = parseDuration(f);
      if (mins === null) { process.stderr.write('usage: away on [--for 2h|90m]   (1 minute to 24 hours; default 2 hours)\n'); return 2; }
      const r = await l.request('away', { minutes: mins });
      out(`away: on for ${mins >= 60 && mins % 60 === 0 ? `${mins / 60} h` : `${mins} min`}. While you are away, Codex and Muse wait up to 45 seconds for your phone before their own question shows on this computer.`);
      out('(only tools you set to hold: botwarren-companion adapters hold codex away). Turn it off with: botwarren-companion away off');
      return r.ok ? 0 : 1;
    }
    if (sub === 'off') { await l.request('away', { minutes: 0 }); out('away: off. Nothing waits for the phone any more; every question shows on this computer at once.'); return 0; }
    if (sub === undefined || sub === 'status') {
      const r = await l.request('away');
      out(r.away ? `away: on until ${new Date(Number(r.untilMs)).toLocaleString()}` : 'away: off');
      return 0;
    }
    process.stderr.write('usage: away on [--for 2h|90m] | away off | away status\n');
    return 2;
  } finally { l.close(); }
}

// ------------------------------------------------------------------ adapters
export async function adaptersCommand(dir: string, a: string[], ctx: Ctx, kit: Kit): Promise<number> {
  const { out } = kit;
  const store = new Store(dir);
  const sub = a[0];
  if (sub === 'explain') {
    const m = ALL_MANIFESTS.find((x) => x.id === a[1]);
    if (!m) { process.stderr.write(`usage: adapters explain <${ALL_MANIFESTS.map((x) => x.id).join('|')}>\n`); return 2; }
    out(`${m.id}  (${m.kind}, safety ${m.safety})`);
    out('reads:'); for (const r of m.reads) out(`  - ${r}`);
    out(`can: ${(Object.entries(m.caps) as [string, boolean][]).filter(([, v]) => v).map(([k]) => k).join(', ')}`);
    out(`answers only on versions: ${m.verified.versions.length ? m.verified.versions.join(', ') : 'any (documented contract)'}`);
    out(`local confirmation floor: approve ${m.confirmFloor.approve}, reply ${m.confirmFloor.reply}`);
    return 0;
  }
  if (sub === 'enable' || sub === 'disable') {
    const id = a[1];
    if (!isId(id) || id === 'claude-code') { process.stderr.write(`usage: adapters ${sub} <${ALL_MANIFESTS.filter((x) => x.id !== 'claude-code').map((x) => x.id).join('|')}>\n`); return 2; }
    const c = store.config();
    const cfg = c.adapters as Record<string, { enabled: boolean }>;
    if (!cfg[id]) { process.stderr.write(`${id} has no settings in this version\n`); return 2; }
    if (sub === 'enable') {
      const m = ALL_MANIFESTS.find((x) => x.id === id)!;
      out(`${id} reads:`); for (const r of m.reads) out(`  - ${r}`);
      out('Nothing it reads leaves this computer except the short summary and preview your phone shows, end-to-end encrypted.');
      if (!(await kit.confirmed(a, ctx, `Turn on ${id}?`, `turn on ${id}`))) return 1;
    }
    cfg[id]!.enabled = sub === 'enable';
    store.saveConfig(c); store.audit(`adapter_${sub}d`, { adapter: id });
    out(`${id}: ${sub}d. (a running companion picks it up at its next start: botwarren-companion status)`);
    return 0;
  }
  if (sub === 'opencode') {
    // adapters opencode port <n> | password-env <NAME> | password-env off
    const c = store.config(); const o = c.adapters.opencode;
    if (a[1] === 'port' && /^\d{4,5}$/.test(a[2] ?? '') && Number(a[2]) >= 1024 && Number(a[2]) <= 65535) { o.port = Number(a[2]); store.saveConfig(c); out(`opencode: port ${o.port}`); return 0; }
    if (a[1] === 'password-env' && a[2] === 'off') { delete o.passwordEnv; store.saveConfig(c); out('opencode: no password is used.'); return 0; }
    if (a[1] === 'password-env' && /^[A-Z_][A-Z0-9_]{0,63}$/.test(a[2] ?? '')) { o.passwordEnv = a[2]!; store.saveConfig(c); out(`opencode: the password is read from the environment variable ${a[2]} of the companion's own environment (never from a file) and sent only to a server that identified itself as OpenCode. Start the companion with that variable set.`); return 0; }
    process.stderr.write('usage: adapters opencode port <1024-65535> | adapters opencode password-env <ENV_VAR_NAME>|off\n'); return 2;
  }
  if (sub === 'verify') return verifyCommand(dir, a.slice(1), ctx, kit);
  if (sub === 'preview') {
    if (a[1] !== 'herdr' || (a[2] !== 'on' && a[2] !== 'off')) { process.stderr.write('usage: adapters preview herdr on|off   (show a short masked excerpt of a blocked terminal screen on the phone)\n'); return 2; }
    const c = store.config(); c.adapters.herdr.screenPreview = a[2] === 'on'; store.saveConfig(c); store.audit('adapter_preview', { adapter: 'herdr', on: a[2] === 'on' });
    out(a[2] === 'on' ? 'herdr: a blocked pane\'s screen excerpt (up to 12 lines, secrets masked) will be shown on the phone, labelled "from the terminal screen". Screen text can contain anything the terminal shows.' : 'herdr: no screen text is read or shown; the phone only says the agent is waiting.');
    return 0;
  }
  if (sub === 'hold') {
    const id = a[1]; const mode = a[2];
    if ((id !== 'codex' && id !== 'muse' && id !== 'copilot') || (mode !== 'away' && mode !== 'never')) { process.stderr.write('usage: adapters hold <codex|muse|copilot> away|never [seconds 5-45]\n'); return 2; }
    const c = store.config();
    const t = c.adapters[id];
    t.hold = mode;
    if (a[3] !== undefined) { const s = Number(a[3]); if (!Number.isInteger(s) || s < 5 || s > 45) { process.stderr.write('seconds must be a whole number from 5 to 45\n'); return 2; } t.holdSeconds = s; }
    store.saveConfig(c); store.audit('adapter_hold', { adapter: id, mode, seconds: t.holdSeconds });
    out(mode === 'away'
      ? `${id}: while you are away (botwarren-companion away on), a permission request waits up to ${t.holdSeconds} s for your phone, then ${id}'s own question shows. Until you turn "away" on nothing waits.`
      : `${id}: report only. ${id}'s question always shows at once; your phone is told it is waiting.`);
    return 0;
  }
  // list: static manifests, plus what the running companion knows
  const l = await connectDaemon(dir);
  const live = new Map<string, { present: boolean; version: string | null; enabled: boolean; note: string | null }>();
  if (l) { const r = await l.request('adapters'); l.close(); for (const x of (r.adapters as { id: string; present: boolean; version: string | null; enabled: boolean; note: string | null }[] | undefined) ?? []) live.set(x.id, x); }
  out(`adapters (${l ? 'companion running' : 'companion not running: showing settings only'}):`);
  const cfg = store.config().adapters as Record<string, { enabled?: boolean; hold?: string; holdSeconds?: number }>;
  for (const m of ALL_MANIFESTS) {
    const lv = live.get(m.id); const c = cfg[m.id];
    const enabled = lv?.enabled ?? c?.enabled ?? true;
    const answer = m.caps.approve ? (c?.hold === 'away' ? `answers while away (up to ${c.holdSeconds} s)` : 'answers: set hold away to use') : 'read only: answer on your computer';
    out(`  ${m.id.padEnd(12)} ${enabled ? 'on ' : 'OFF'}  ${lv ? (lv.present ? `found ${lv.version ?? ''}` : 'not found') : ''}  ${m.id === 'claude-code' ? 'channel and hooks' : answer}`.trimEnd());
  }
  out('  details: botwarren-companion adapters explain <id>;  turn one on: adapters enable <id>;  away mode: away on --for 2h');
  return 0;
}

// ------------------------------------------------------------------ hook files
interface FileTool { id: 'codex'; label: string; path: (env: Record<string, string | undefined>) => string; events: readonly EventSpec[]; trustNote: string }
const CODEX: FileTool = {
  id: 'codex', label: 'Codex', path: codexHooksPath, events: CODEX_EVENTS_SPEC,
  trustNote: 'Codex only runs hooks you have reviewed: open Codex and run /hooks to review and trust these, then run "botwarren-companion codex doctor". Until then Codex skips them and nothing is sent.',
};

export async function hookFileCommand(tool: FileTool, dir: string, a: string[], ctx: Ctx, kit: Kit): Promise<number> {
  const { out } = kit;
  const path = tool.path(process.env);
  switch (a[0]) {
    case 'install-hooks': {
      let cur: HooksFile;
      try { cur = existsSync(path) ? (readSettings(path) as HooksFile) : {}; } catch (e) { process.stderr.write(`cannot read ${path}: ${(e as Error).message}\n`); return 1; }
      const launcher = launcherPath(dir);
      const next = withFamilyHooks(cur, { tool: tool.id, node: ctx.node, script: launcher, events: tool.events });
      const diff = simpleDiff(JSON.stringify(cur, null, 2), JSON.stringify(next, null, 2));
      if (!diff) { out('hooks are already installed.'); return 0; }
      const others = Object.entries(cur.hooks ?? {}).reduce((n, [, gs]) => n + gs.reduce((m, g) => m + (g.hooks ?? []).filter((h) => !(typeof h.command === 'string' && h.command.includes('--bw-companion'))).length, 0), 0);
      out(`This will change ${path}:`); out(diff); out();
      out(`The hooks only report to your own companion on this computer and fail open: if it is not running, ${tool.label} behaves as before. ${others ? `The ${others} other hook(s) already in the file, such as Herdr's, are not touched. ` : ''}A backup of the file is written first.`);
      out(tool.trustNote);
      if (!(await kit.confirmed(a, ctx, 'Install these hooks?', 'install these hooks'))) return 1;
      installLauncher(dir, { node: ctx.node, script: ctx.script, version: kit.version });
      const backup = writeSettings(path, next);
      new Store(dir).audit(`${tool.id}_hooks_installed`);
      out(`done.${backup ? ` backup: ${backup}` : ''}`);
      return 0;
    }
    case 'remove-hooks': {
      let cur: HooksFile;
      try { cur = readSettings(path) as HooksFile; } catch { out('no hook file found.'); return 0; }
      if (familyHooksOf(cur, tool.id).length === 0) { out('no companion hooks found.'); return 0; }
      const backup = writeSettings(path, withoutFamilyHooks(cur, tool.id));
      new Store(dir).audit(`${tool.id}_hooks_removed`);
      out(`removed.${backup ? ` backup: ${backup}` : ''}`);
      return 0;
    }
    case 'doctor': {
      const l = await connectDaemon(dir);
      out(`daemon          ${l ? 'running' : 'NOT running'}`);
      let ads: { id: string; doctor?: { label: string; value: string; ok: boolean | null }[] }[] = [];
      if (l) { const r = await l.request('adapters'); ads = (r.adapters as typeof ads | undefined) ?? []; l.close(); }
      for (const d of ads.find((x) => x.id === tool.id)?.doctor ?? []) out(`${d.label.padEnd(15)} ${d.value}`);
      let cur: HooksFile | null = null;
      try { cur = existsSync(path) ? (readSettings(path) as HooksFile) : null; } catch { /* reported below */ }
      const ours = cur ? familyHooksOf(cur, tool.id) : [];
      out(`hook file       ${existsSync(path) ? path : `${path} (does not exist)`}`);
      out(`our hooks       ${ours.length ? `${ours.length} installed (${[...new Set(ours.map((o) => o.event))].join(', ')})` : 'not installed: run "botwarren-companion codex install-hooks"'}`);
      if (ours.length) {
        const listed = await codexHooksList(process.cwd());
        if (!listed) out('trust           could not ask Codex (is `codex` on PATH?). In Codex, run /hooks to see whether they are trusted.');
        else {
          const mine = listed.filter((x) => x.command.includes('--bw-companion') && x.command.includes(' --tool codex '));
          const by: Record<string, number> = {}; for (const x of mine) by[x.trustStatus] = (by[x.trustStatus] ?? 0) + 1;
          const bad = mine.filter((x) => x.trustStatus !== 'trusted' && x.trustStatus !== 'managed').length;
          out(`trust           ${mine.length ? Object.entries(by).map(([k, v]) => `${v} ${k}`).join(', ') : 'Codex does not list them (is the hook file in CODEX_HOME?)'}`);
          if (bad) out('                open Codex and run /hooks to review and trust them (a changed hook must be trusted again). Until then Codex skips them.');
        }
      }
      out(); out('Live check (run once, not run automatically): turn on away mode (botwarren-companion away on), set holding (botwarren-companion adapters hold codex away), ask Codex to run a command that needs approval, and answer it from your phone. Codex\'s own question should not appear while it waits, and should appear after about 30 s if you do not answer.');
      return 0;
    }
    default: process.stderr.write(`usage: ${tool.id} install-hooks [--yes] | remove-hooks | doctor\n`); return 2;
  }
}

// ------------------------------------------------------------------ Muse (a generated plugin, installed with Muse's own commands)
interface MuseInspect { runtime_capabilities?: { status?: string; candidate?: { capability_id?: string } }[] }

async function museCommand(dir: string, a: string[], ctx: Ctx, kit: Kit): Promise<number> {
  const { out } = kit;
  const manifestPath = musePluginManifestPath(dir);
  const pluginDir = musePluginDir(dir);
  const win = process.platform === 'win32';
  switch (a[0]) {
    case 'install-hooks': {
      const launcher = launcherPath(dir);
      const next = musePluginManifest({ node: ctx.node, script: launcher });
      let cur = ''; try { cur = readFileSync(manifestPath, 'utf8'); } catch { /* new */ }
      const diff = simpleDiff(cur, next);
      out(`This will ${cur ? 'update' : 'create'} the plugin "${MUSE_PLUGIN_ID}" in ${pluginDir} (only a manifest: each hook is a command that runs your companion):`);
      out(diff || '(no change to the manifest)'); out();
      const install = `muse plugins install ${pluginDir} --scope user`;
      out(`Then it runs, using Muse's own command:  ${install}`);
      out('and you run this yourself, because trusting a plugin is Muse\'s gate and stays yours:  muse plugins approve ' + MUSE_PLUGIN_ID);
      out('The hooks only report to your own companion on this computer and fail open. Answering from the phone is OFF until you test your Muse version and run: botwarren-companion adapters verify muse <version>.');
      if (!diff && cur) { const l = await runCli('muse', ['plugins', 'inspect', MUSE_PLUGIN_ID, '--json']); if (l.ok) { out('hooks are already installed.'); return 0; } }
      if (!(await kit.confirmed(a, ctx, 'Create and install this plugin?', 'install the plugin'))) return 1;
      installLauncher(dir, { node: ctx.node, script: ctx.script, version: kit.version });
      mkdirSync(dirname(manifestPath), { recursive: true });
      writeFileSync(manifestPath, next);
      new Store(dir).audit('muse_plugin_written');
      if (win) { out('The plugin folder is written. Run this in a terminal where "muse" works:'); out(`  ${install}`); return 0; }
      const r = await runCliWithPath('muse', ['plugins', 'install', '--scope', 'user'], pluginDir);
      if (!r.ok) { out(`Could not run "muse plugins install" (is muse on PATH?). The plugin folder is written: run it yourself:\n  ${install}`); return 1; }
      new Store(dir).audit('muse_plugin_installed');
      out('installed. Now run:  muse plugins approve ' + MUSE_PLUGIN_ID); out('then:  botwarren-companion muse doctor');
      return 0;
    }
    case 'remove-hooks': {
      const r = await runCli('muse', ['plugins', 'remove', MUSE_PLUGIN_ID]);
      if (r.ok) out(`removed the plugin "${MUSE_PLUGIN_ID}" from Muse.`); else out(`Muse did not remove it (not installed, or "muse" is not on PATH). To remove it yourself:  muse plugins remove ${MUSE_PLUGIN_ID}`);
      try { rmSync(pluginDir, { recursive: true, force: true }); out(`deleted ${pluginDir}`); } catch { /* none */ }
      new Store(dir).audit('muse_plugin_removed');
      return 0;
    }
    case 'doctor': {
      const l = await connectDaemon(dir);
      out(`daemon          ${l ? 'running' : 'NOT running'}`);
      let ads: { id: string; doctor?: { label: string; value: string }[] }[] = [];
      if (l) { const r = await l.request('adapters'); ads = (r.adapters as typeof ads | undefined) ?? []; l.close(); }
      for (const d of ads.find((x) => x.id === 'muse')?.doctor ?? []) out(`${d.label.padEnd(15)} ${d.value}`);
      const v = await runCli('muse', ['--version']);
      out(`muse            ${v.ok ? (firstVersion(v.stdout) ?? 'unknown version') : 'not found on PATH'}`);
      const insp = await runCli('muse', ['plugins', 'inspect', MUSE_PLUGIN_ID, '--json']);
      if (!insp.ok) out(`plugin          not installed: run "botwarren-companion muse install-hooks"`);
      else {
        let j: MuseInspect | null = null; try { j = JSON.parse(insp.stdout) as MuseInspect; } catch { /* shown below */ }
        const states = (j?.runtime_capabilities ?? []).map((c) => c.status ?? 'unknown');
        const by: Record<string, number> = {}; for (const s2 of states) by[s2] = (by[s2] ?? 0) + 1;
        out(`plugin          installed; hooks: ${states.length ? Object.entries(by).map(([k, n]) => `${n} ${k}`).join(', ') : 'none listed'}`);
        if (states.some((s2) => s2 !== 'trusted_enabled')) out(`                run:  muse plugins approve ${MUSE_PLUGIN_ID}   (a changed hook must be approved again)`);
      }
      out(); out('Live check, once, on YOUR Muse version (it was not possible to run one in isolation, so no version is pre-verified):');
      out('  1. botwarren-companion adapters hold muse away;  botwarren-companion away on --for 30m');
      out('  2. in a throwaway folder ask Muse to do something that needs approval; the phone should show it, then answer it from the phone.');
      out('  3. check that Muse\'s own question did NOT appear while it waited, that deny shows your reason, and that an unanswered request shows Muse\'s own question after about 30 s.');
      out('  4. if all that held:  botwarren-companion adapters verify muse <your muse version>');
      return 0;
    }
    default: process.stderr.write('usage: muse install-hooks [--yes] | remove-hooks | doctor\n'); return 2;
  }
}

/** `adapters verify <tool> <version> [--yes]`: records that the person ran the live checklist on that version */
export async function verifyCommand(dir: string, a: string[], ctx: Ctx, kit: Kit): Promise<number> {
  const id = a[0]; const version = a[1];
  if ((id !== 'muse' && id !== 'codex' && id !== 'copilot') || !version || !/^\d{1,4}\.\d{1,4}\.(?:\d{1,4}|\*)$/.test(version)) { process.stderr.write('usage: adapters verify <codex|muse|copilot> <version, e.g. 1.4.9>\n'); return 2; }
  kit.out(`You are saying you ran the live check (botwarren-companion ${id} doctor) on ${id} ${version} and it behaved as described.`);
  kit.out('From then on the companion will hold a permission request for your phone on that version, while you are away. Any other version stays read-only.');
  if (!(await kit.confirmed(a, ctx, `Enable answering for ${id} ${version}?`, `enable answering for ${id} ${version}`))) return 1;
  const store = new Store(dir); const c = store.config(); const t = c.adapters[id];
  if (!t.verifiedVersions.includes(version)) t.verifiedVersions = [...t.verifiedVersions, version].slice(-5);
  store.saveConfig(c); store.audit('adapter_verified', { adapter: id, version });
  kit.out(`${id} ${version}: answering is allowed. Turn it on with: botwarren-companion adapters hold ${id} away`);
  return 0;
}

export const toolCommand = async (id: string, dir: string, a: string[], ctx: Ctx, kit: Kit): Promise<number | null> => {
  if (id === 'codex') return hookFileCommand(CODEX, dir, a, ctx, kit);
  if (id === 'muse') return museCommand(dir, a, ctx, kit);
  return null;
};


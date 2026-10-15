/**
 * Adds and removes the companion's Claude Code hooks in a settings.json. Never silent: the CLI shows the diff first, a backup is
 * written next to the file, only entries carrying our marker argument are ever touched, and everything else is preserved as is.
 * Licence: Apache-2.0.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir, platform } from 'node:os';
import { isVersionedPath } from './launcher.ts';

export const MARKER = '--bw-companion';
export const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'Notification', 'Stop', 'PostToolUse', 'SessionEnd'] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

interface Hook { type: string; command?: string; timeout?: number; async?: boolean; [k: string]: unknown }
interface Group { matcher?: string; hooks?: Hook[]; [k: string]: unknown }
type Settings = { hooks?: Record<string, Group[]>; [k: string]: unknown };

/**
 * Quotes one word of a command line. POSIX: safe words stay bare, others go in double quotes with $ ` \ " escaped. Windows: backslashes become forward
 * slashes (node and every shell Claude Code may use accept them, while a backslash inside double quotes means something different in Git Bash,
 * PowerShell and cmd) and a word with a space goes in plain double quotes.
 */
export function quoteWord(s: string, win: boolean = platform() === 'win32'): string {
  const safe = /^[A-Za-z0-9_@%+=:,./-]+$/;
  if (win) { const f = s.replace(/\\/g, '/'); return safe.test(f) ? f : `"${f.replace(/"/g, '')}"`; }
  return safe.test(s) ? s : `"${s.replace(/(["\\$`])/g, '\\$1')}"`;
}

/** the command line for one event: absolute node and the stable launcher (see launcher.ts), so it depends neither on PATH nor on the companion's version */
export function hookCommand(event: string, o: { node: string; script: string; win?: boolean }): string {
  const w = o.win ?? platform() === 'win32';
  return `${quoteWord(o.node, w)} --disable-warning=ExperimentalWarning ${quoteWord(o.script, w)} hook ${event} ${MARKER}`;
}

export function settingsPath(scope: 'user' | 'project' | 'local', cwd: string, env: Record<string, string | undefined> = process.env): string {
  if (scope === 'user') return join(env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? homedir(), '.claude'), 'settings.json');
  return join(cwd, '.claude', scope === 'project' ? 'settings.json' : 'settings.local.json');
}

const isOurs = (h: Hook): boolean => typeof h.command === 'string' && h.command.includes(MARKER);

export function readSettings(path: string): Settings {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, 'utf8');
  if (!raw.trim()) return {};
  const j = JSON.parse(raw) as unknown;
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('settings.json is not a JSON object');
  return j as Settings;
}

/** returns the new settings object without writing anything */
export function withHooks(cur: Settings, o: { node: string; script: string; holdSeconds: number }): Settings {
  const out: Settings = JSON.parse(JSON.stringify(cur)) as Settings;
  out.hooks ??= {};
  for (const ev of HOOK_EVENTS) {
    const groups = (out.hooks[ev] ??= []).map((g) => ({ g, before: g.hooks?.length ?? 0, hooks: (g.hooks ?? []).filter((h) => !isOurs(h)) }))
      .filter((x) => !(x.before > 0 && x.hooks.length === 0)) // a group that held only our hook goes away; a user's own empty group is left alone
      .map((x) => ({ ...x.g, hooks: x.hooks }));
    const hook: Hook = { type: 'command', command: hookCommand(ev, o), timeout: ev === 'PermissionRequest' ? o.holdSeconds + 10 : 10, ...(ev === 'PostToolUse' ? { async: true } : {}) };
    groups.push({ ...(ev === 'PostToolUse' || ev === 'PermissionRequest' ? { matcher: '*' } : {}), hooks: [hook] });
    out.hooks[ev] = groups;
  }
  return out;
}

export function withoutHooks(cur: Settings): Settings {
  const out: Settings = JSON.parse(JSON.stringify(cur)) as Settings;
  if (!out.hooks) return out;
  for (const ev of Object.keys(out.hooks)) {
    const groups = (out.hooks[ev] ?? []).map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurs(h)) })).filter((g) => (g.hooks?.length ?? 0) > 0);
    if (groups.length) out.hooks[ev] = groups; else delete out.hooks[ev];
  }
  if (Object.keys(out.hooks).length === 0) delete out.hooks;
  return out;
}

/** our hook commands that name a per-version path (`.../versions/0.1.1/companion.mjs`): they stop working when the companion updates; `install-hooks` rewrites them */
export function versionedHooks(cur: Settings): string[] {
  const out: string[] = [];
  for (const gs of Object.values(cur.hooks ?? {})) for (const g of gs) for (const h of g.hooks ?? []) if (isOurs(h) && isVersionedPath(h.command ?? '')) out.push(h.command!);
  return out;
}

export function hasOurHooks(cur: Settings): boolean {
  return Object.values(cur.hooks ?? {}).some((gs) => gs.some((g) => (g.hooks ?? []).some(isOurs)));
}

/** line diff good enough to show a person what will change */
export function simpleDiff(before: string, after: string): string {
  const a = before.split('\n'); const b = after.split('\n');
  const setA = new Set(a); const setB = new Set(b);
  return [...a.filter((l) => !setB.has(l)).map((l) => `- ${l}`), ...b.filter((l) => !setA.has(l)).map((l) => `+ ${l}`)].join('\n');
}

export function writeSettings(path: string, s: Settings): string | null {
  mkdirSync(dirname(path), { recursive: true });
  let backup: string | null = null;
  if (existsSync(path)) { backup = `${path}.bw-backup-${Date.now()}`; copyFileSync(path, backup); }
  const tmp = `${path}.bw-tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n');
  renameSync(tmp, path);
  return backup;
}

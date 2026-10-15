/**
 * Adds and removes the companion's Claude Code hooks in a settings.json. Never silent: the CLI shows the diff first, a backup is
 * written next to the file, only entries carrying our marker argument are ever touched, and everything else is preserved as is.
 * Licence: Apache-2.0.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const MARKER = '--bw-companion';
export const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'Notification', 'Stop', 'PostToolUse', 'SessionEnd'] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

interface Hook { type: string; command?: string; timeout?: number; async?: boolean; [k: string]: unknown }
interface Group { matcher?: string; hooks?: Hook[]; [k: string]: unknown }
type Settings = { hooks?: Record<string, Group[]>; [k: string]: unknown };

const q = (s: string): string => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `"${s.replace(/(["\\$`])/g, '\\$1')}"`);

/** the command line for one event: absolute node, absolute script, so it does not depend on PATH */
export function hookCommand(event: string, o: { node: string; script: string }): string {
  return `${q(o.node)} --disable-warning=ExperimentalWarning ${q(o.script)} hook ${event} ${MARKER}`;
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

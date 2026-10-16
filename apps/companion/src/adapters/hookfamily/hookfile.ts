/**
 * Adds and removes this companion's hooks in a tool's hook file when that file is Claude-shaped JSON (`{"hooks": {"Event": [{"matcher", "hooks": [...]}]}}`),
 * which is what Codex reads from `$CODEX_HOME/hooks.json`. Same rules as claude/settings.ts: never silent (the CLI shows the diff and asks), a backup is
 * written first, and ONLY handlers carrying our marker and our `--tool` are ever touched, so a tool's own entries (Herdr's, the user's) are preserved byte
 * for byte in meaning, in their own groups. Licence: Apache-2.0.
 */
import { platform } from 'node:os';
import { MARKER, quoteWord } from '../../claude/settings.ts';

export { MARKER };
export interface HookEntry { type: string; command?: string; timeout?: number; async?: boolean; [k: string]: unknown }
export interface HookGroup { matcher?: string; hooks?: HookEntry[]; [k: string]: unknown }
export type HooksFile = { hooks?: Record<string, HookGroup[]>; [k: string]: unknown };

export interface EventSpec { name: string; timeout: number; async?: boolean; matcher?: string }

/** the command a tool runs for one event: absolute node and the stable launcher, so it depends neither on PATH nor on the companion's version */
export function familyHookCommand(tool: string, event: string, o: { node: string; script: string; win?: boolean }): string {
  const w = o.win ?? platform() === 'win32';
  return `${quoteWord(o.node, w)} --disable-warning=ExperimentalWarning ${quoteWord(o.script, w)} hook ${event} --tool ${tool} ${MARKER}`;
}

export const isFamilyHook = (h: HookEntry, tool: string): boolean => typeof h.command === 'string' && h.command.includes(MARKER) && h.command.includes(` --tool ${tool} `);

/** the new file contents, without writing anything */
export function withFamilyHooks(cur: HooksFile, o: { tool: string; node: string; script: string; events: readonly EventSpec[]; win?: boolean }): HooksFile {
  const out: HooksFile = JSON.parse(JSON.stringify(cur)) as HooksFile;
  out.hooks ??= {};
  for (const ev of o.events) {
    const groups = (out.hooks[ev.name] ??= []).map((g) => ({ g, before: g.hooks?.length ?? 0, hooks: (g.hooks ?? []).filter((h) => !isFamilyHook(h, o.tool)) }))
      .filter((x) => !(x.before > 0 && x.hooks.length === 0)) // a group that held only our hook goes away; somebody else's empty group is left alone
      .map((x) => ({ ...x.g, hooks: x.hooks }));
    const hook: HookEntry = { type: 'command', command: familyHookCommand(o.tool, ev.name, o), timeout: ev.timeout, ...(ev.async ? { async: true } : {}) };
    groups.push({ ...(ev.matcher !== undefined ? { matcher: ev.matcher } : {}), hooks: [hook] });
    out.hooks[ev.name] = groups;
  }
  return out;
}

export function withoutFamilyHooks(cur: HooksFile, tool: string): HooksFile {
  const out: HooksFile = JSON.parse(JSON.stringify(cur)) as HooksFile;
  if (!out.hooks) return out;
  for (const ev of Object.keys(out.hooks)) {
    const groups = (out.hooks[ev] ?? []).map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isFamilyHook(h, tool)) })).filter((g) => (g.hooks?.length ?? 0) > 0);
    if (groups.length) out.hooks[ev] = groups; else delete out.hooks[ev];
  }
  if (Object.keys(out.hooks).length === 0) delete out.hooks;
  return out;
}

export function familyHooksOf(cur: HooksFile, tool: string): { event: string; entry: HookEntry }[] {
  const out: { event: string; entry: HookEntry }[] = [];
  for (const [event, gs] of Object.entries(cur.hooks ?? {})) for (const g of gs) for (const h of g.hooks ?? []) if (isFamilyHook(h, tool)) out.push({ event, entry: h });
  return out;
}

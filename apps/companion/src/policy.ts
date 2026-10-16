/**
 * What the host will do with a device's action. The companion decides, never the client. Licence: Apache-2.0.
 */
import { isAbsolute, resolve, sep } from 'node:path';
import type { Config } from './store.ts';
import { stricter, type ConfirmMode } from './adapters/types.ts';
import { MAX_PROMPT_CHARS, charLength, type Route } from './protocol/index.ts';
import { cleanText } from './textclean.ts';

export type ActionKind = 'approve' | 'deny' | 'reply';

/**
 * Local confirmation policy (decision recorded in docs/PROTOCOL.md section 6):
 *  - deny is always allowed remotely (it can only stop things);
 *  - approve and preset replies are allowed remotely by default for an enrolled owner, and each can be set to always require a local
 *    yes, or to require it only for risky cases (a tool in `requireLocalTools`, or a preset flagged `affirm`);
 *  - any action kind added later defaults to "always" (not reachable in v1: the schema has no such kind).
 */
export function needsLocalConfirmation(
  cfg: Pick<Config, 'confirm' | 'requireLocalTools' | 'presets'>,
  a: { kind: ActionKind; tool?: string | undefined; presetId?: string | undefined; risk?: readonly string[] | undefined; floor?: ConfirmMode | undefined },
): boolean {
  if (a.kind === 'deny') return false;
  const configured = a.kind === 'approve' ? cfg.confirm.approve : cfg.confirm.reply;
  // an adapter can ask for more than the user's setting (Muse: "risky" for approvals), never for less
  const mode = a.floor ? stricter(configured, a.floor) : configured;
  if (mode === 'always') return true;
  if (mode === 'off') return false;
  if (a.kind === 'approve') return (a.tool !== undefined && cfg.requireLocalTools.includes(a.tool)) || (a.risk?.length ?? 0) > 0;
  return cfg.presets.find((p) => p.id === a.presetId)?.affirm === true;
}

/** sliding-window limiter for actions */
export class ActionLimiter {
  private readonly times: number[] = [];
  private readonly perMinute: number;
  private readonly perHour: number;
  constructor(perMinute: number, perHour: number) { this.perMinute = perMinute; this.perHour = perHour; }
  /** would one more action be allowed now? Spends nothing: the caller checks early, and `record`s only once it really acts */
  wouldAllow(now: number): boolean {
    while (this.times.length && now - this.times[0]! > 3_600_000) this.times.shift();
    const lastMin = this.times.filter((t) => now - t <= 60_000).length;
    return lastMin < this.perMinute && this.times.length < this.perHour;
  }
  record(now: number): void { this.times.push(now); }
  allow(now: number): boolean {
    if (!this.wouldAllow(now)) return false;
    this.record(now);
    return true;
  }
}

/** several buckets that all have to have room (the overall action bucket and one per kind); `spend` takes from all of them or none */
export function spendAll(limiters: readonly ActionLimiter[], now: number): boolean {
  if (!limiters.every((l) => l.wouldAllow(now))) return false;
  for (const l of limiters) l.record(now);
  return true;
}

export type TextRefusal = 'empty' | 'size' | 'keystroke_prefix';
/**
 * The text rules for anything a paired device types for an agent (protocol 3): cleaned (terminal escapes, control and bidi characters out), not empty, at most
 * 4,000 characters, and on a keystroke route (typed into a terminal) no line may start with `!` or `/` (a bash or slash command in Claude Code), even after white space.
 */
export function checkControlText(raw: string, route: Route): { ok: true; text: string } | { ok: false; why: TextRefusal } {
  const text = cleanText(raw).trim();
  if (!text) return { ok: false, why: 'empty' };
  if (charLength(text) > MAX_PROMPT_CHARS) return { ok: false, why: 'size' };
  if (route === 'keys' && text.split('\n').some((l) => /^\s*[!/]/.test(l))) return { ok: false, why: 'keystroke_prefix' };
  return { ok: true, text };
}

/** is a folder inside the allowlist (empty list = any)? Compared as resolved absolute paths; a relative entry never matches */
export function projectAllowed(projects: readonly string[], cwd: string): boolean {
  if (projects.length === 0) return true;
  if (!cwd || !isAbsolute(cwd)) return false;
  const c = resolve(cwd);
  return projects.some((p) => { if (!isAbsolute(p)) return false; const r = resolve(p); return c === r || c.startsWith(r.endsWith(sep) ? r : r + sep); });
}

/** the relay a companion may use: https/wss to an allowed host suffix (or plain ws/http to loopback for development) */
export function relayAllowed(url: string, allowHosts: readonly string[]): boolean {
  try {
    const u = new URL(url);
    const loop = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]';
    if (u.username || u.password) return false;
    if (u.protocol === 'wss:' || u.protocol === 'https:') return allowHosts.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
    if ((u.protocol === 'ws:' || u.protocol === 'http:') && loop) return allowHosts.includes(u.hostname) || allowHosts.includes('localhost');
    return false;
  } catch { return false; }
}

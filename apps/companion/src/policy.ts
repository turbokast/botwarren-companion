/**
 * What the host will do with a device's action. The companion decides, never the client. Licence: Apache-2.0.
 */
import type { Config } from './store.ts';

export type ActionKind = 'approve' | 'deny' | 'reply';

/**
 * Local confirmation policy (decision recorded in docs/PROTOCOL.md section 6):
 *  - deny is always allowed remotely (it can only stop things);
 *  - approve and preset replies are allowed remotely by default for an enrolled owner, and each can be set to always require a local
 *    yes, or to require it only for risky cases (a tool in `requireLocalTools`, or a preset flagged `affirm`);
 *  - any action kind added later defaults to "always" (not reachable in v1: the schema has no such kind).
 */
export function needsLocalConfirmation(cfg: Pick<Config, 'confirm' | 'requireLocalTools' | 'presets'>, a: { kind: ActionKind; tool?: string | undefined; presetId?: string | undefined }): boolean {
  if (a.kind === 'deny') return false;
  const mode = a.kind === 'approve' ? cfg.confirm.approve : cfg.confirm.reply;
  if (mode === 'always') return true;
  if (mode === 'off') return false;
  if (a.kind === 'approve') return a.tool !== undefined && cfg.requireLocalTools.includes(a.tool);
  return cfg.presets.find((p) => p.id === a.presetId)?.affirm === true;
}

/** sliding-window limiter for actions */
export class ActionLimiter {
  private readonly times: number[] = [];
  private readonly perMinute: number;
  private readonly perHour: number;
  constructor(perMinute: number, perHour: number) { this.perMinute = perMinute; this.perHour = perHour; }
  allow(now: number): boolean {
    while (this.times.length && now - this.times[0]! > 3_600_000) this.times.shift();
    const lastMin = this.times.filter((t) => now - t <= 60_000).length;
    if (lastMin >= this.perMinute || this.times.length >= this.perHour) return false;
    this.times.push(now);
    return true;
  }
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

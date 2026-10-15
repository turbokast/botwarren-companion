/**
 * When to alert the owner's phones that an agent is waiting. Pure logic (no I/O, no timers), so the rules are testable:
 *
 *   - ONE alert per waiting episode. An episode is one pending request (its random request id); a new request is a new episode.
 *   - SETTLE: nothing is sent until the request has been waiting `delaySeconds` (someone at the keyboard usually answers within seconds).
 *   - QUIET AFTER ANSWER: an episode that is answered, replaced or expired is forgotten at once; an alert that is still held is never sent for it.
 *   - COALESCE: one alert covers every episode waiting at that moment (they are all marked alerted), and the next one waits `minGapSeconds`.
 *   - CAPS: at most `maxPerHour` alerts an hour; quiet hours (this computer's clock) hold alerts back and they are sent only if something is STILL waiting
 *     when the quiet hours end; `paused` (the owner's "pause remote answers") and the master switch send nothing.
 *
 * What an alert says is not decided here (it carries no content at all): see sealAlert() in webpush.ts. Licence: Apache-2.0.
 */

export interface AlertConfig {
  enabled: boolean;
  /** also alert when an agent has finished and waits for the next instruction (off by default: it happens after every turn) */
  idle: boolean;
  delaySeconds: number;
  minGapSeconds: number;
  maxPerHour: number;
  quiet: { on: boolean; start: string; end: string };
}

export interface Episode { rid: string; kind: 'permission' | 'question' | 'idle' }

export type Plan =
  /** send one alert now; `rid` is set when exactly one request is waiting (the tap opens it), else the tap opens the list */
  | { fire: true; rid: string | null; count: number }
  /** nothing to send; look again in `recheckMs` (null: only when something changes) */
  | { fire: false; recheckMs: number | null; why: 'none' | 'off' | 'settling' | 'quiet' | 'gap' | 'cap' };

const HOUR = 3_600_000;
const MAX_RECHECK_MS = 10 * 60_000;

/** minutes since local midnight of `ms` on this computer's clock */
export function localMinutes(ms: number): number { const d = new Date(ms); return d.getHours() * 60 + d.getMinutes(); }

/** "HH:MM" to minutes, or null */
export function parseClock(s: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** true during the quiet window; a window that crosses midnight (22:00 to 07:00) is handled; start = end means never */
export function inQuiet(q: AlertConfig['quiet'], ms: number): boolean {
  if (!q.on) return false;
  const a = parseClock(q.start); const b = parseClock(q.end);
  if (a === null || b === null || a === b) return false;
  const t = localMinutes(ms);
  return a < b ? t >= a && t < b : t >= a || t < b;
}

/** milliseconds until the quiet window ends (at most a day), used to schedule the next look */
export function quietEndsInMs(q: AlertConfig['quiet'], ms: number): number {
  const b = parseClock(q.end);
  if (b === null) return 60_000;
  const t = localMinutes(ms);
  const mins = ((b - t + 1440) % 1440) || 1440;
  return mins * 60_000 - (ms % 60_000);
}

export class AlertPlanner {
  private readonly seen = new Map<string, { since: number; alerted: boolean }>();
  private sent: number[] = [];
  private lastAt = -Infinity;
  private readonly cfg: () => AlertConfig;

  constructor(cfg: () => AlertConfig) { this.cfg = cfg; }

  /** forget everything (the relay connection restarted, devices changed): the next look starts the episodes from now */
  reset(): void { this.seen.clear(); }

  /**
   * `waiting`: every request that is waiting for the person right now, from the session table. Call on every change and when `recheckMs` is up.
   * Calling again after `fire: true` is correct only once `markSent()` has recorded the delivery.
   */
  plan(waiting: readonly Episode[], now: number, paused: boolean): Plan {
    const cfg = this.cfg();
    const live = new Map(waiting.filter((e) => cfg.idle || e.kind !== 'idle').map((e) => [e.rid, e]));
    for (const rid of [...this.seen.keys()]) if (!live.has(rid)) this.seen.delete(rid); // answered, replaced or expired: quiet
    for (const rid of live.keys()) if (!this.seen.has(rid)) this.seen.set(rid, { since: now, alerted: false });
    if (live.size === 0) return { fire: false, recheckMs: null, why: 'none' };
    if (!cfg.enabled || paused) return { fire: false, recheckMs: null, why: 'off' };
    const fresh = [...this.seen.entries()].filter(([, v]) => !v.alerted);
    if (fresh.length === 0) return { fire: false, recheckMs: null, why: 'none' };
    const settleLeft = Math.min(...fresh.map(([, v]) => v.since + cfg.delaySeconds * 1000 - now));
    if (settleLeft > 0) return { fire: false, recheckMs: Math.min(settleLeft, MAX_RECHECK_MS), why: 'settling' };
    if (inQuiet(cfg.quiet, now)) return { fire: false, recheckMs: Math.min(quietEndsInMs(cfg.quiet, now), MAX_RECHECK_MS), why: 'quiet' };
    const gapLeft = this.lastAt + cfg.minGapSeconds * 1000 - now;
    if (gapLeft > 0) return { fire: false, recheckMs: Math.min(gapLeft, MAX_RECHECK_MS), why: 'gap' };
    this.sent = this.sent.filter((t) => now - t < HOUR);
    if (this.sent.length >= cfg.maxPerHour) return { fire: false, recheckMs: Math.min(Math.max(this.sent[0]! + HOUR - now, 1000), MAX_RECHECK_MS), why: 'cap' };
    return { fire: true, rid: live.size === 1 ? [...live.keys()][0]! : null, count: live.size };
  }

  /** the alert was handed to the relay: every episode waiting now is covered, and the gap and hourly count start */
  markSent(now: number): void {
    for (const v of this.seen.values()) v.alerted = true;
    this.lastAt = now;
    this.sent.push(now);
  }
}

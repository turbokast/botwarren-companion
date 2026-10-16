/** An AdapterContext that records everything an adapter reports, for adapter-level tests that run without a host. */
import type { AdapterContext, NativeRef, PendingReport, SessionReport, TailKind } from '../../src/adapters/types.ts';

export interface Recording {
  ctx: AdapterContext;
  sessions: SessionReport[];
  pendings: PendingReport[];
  tails: { key: string; items: { k: TailKind; text: string; ts: number }[] }[];
  followups: { key: string; what: string }[];
  resolved: { n: NativeRef; how: string }[];
  cleared: { key: string; why: string }[];
  audits: { kind: string; fields: Record<string, unknown> }[];
}

export function recordingContext(o: { now?: () => number } = {}): Recording {
  const r: Recording = { sessions: [], pendings: [], tails: [], followups: [], resolved: [], cleared: [], audits: [], ctx: undefined as never };
  const known = new Set<string>();
  r.ctx = {
    now: o.now ?? (() => Date.now()),
    facts: () => ({ away: false, paused: false, relayOnline: true, devices: 1 }),
    config: () => ({ enabled: true, hold: 'never', holdSeconds: 30 }),
    audit: (kind, fields = {}) => { r.audits.push({ kind, fields }); },
    report: {
      session: (s) => { r.sessions.push(s); const fresh = !known.has(s.key); known.add(s.key); return fresh ? 'created' : 'existing'; },
      pending: async (p) => { r.pendings.push(p); },
      cleared: (key, why) => { r.cleared.push({ key, why }); return true; },
      recent: () => undefined,
      resolved: (n, how) => { r.resolved.push({ n, how }); },
      changed: () => undefined,
      tail: (key, items) => { r.tails.push({ key, items }); },
      followup: (key, what) => { r.followups.push({ key, what }); },
    },
  };
  return r;
}

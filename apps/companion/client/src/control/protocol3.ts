/**
 * The protocol 3 transport: turns the remote-control screens' calls (ControlApi, see adapter.ts) into the sealed commands of docs/PROTOCOL3.md
 * and the computer's answers into what the screens show. It is the only file that knows protocol 3 message names.
 *
 *   state.host.ctl / state.sessions[].ctl  -> scope, kill switch, launch table, what each session can do, the bind
 *   watch / tail / history                 -> the live tail (a newest-lines window, earlier lines on demand)
 *   prompt, answer, start, interrupt       -> commands with a random cid, a 60 s expiry, the bind that was shown; the computer's cresult decides the words
 *   su_*                                   -> client/src/stepup.ts (WebAuthn): an unlock window for messages, a fresh assertion bound to the command for start
 *
 * Nothing is queued: a command that cannot be sent fails visibly ("offline"), and the page keeps the person's text. Text is cleaned with the same
 * `cleanText` the computer uses before it is sealed or digested, so a step-up assertion is bound to exactly what is sent.
 */
import {
  CResultData, HistData, TailData, charLength, commandExpiry, newCid, watchReplaceKey, MAX_PROMPT_CHARS,
  type CtlWhy, type Refusal, type Route, type StartMode, type TailEntry,
} from '../../../src/protocol/index.ts';
import { cleanText } from '../../../src/textclean.ts';
import type { Link } from '../link.ts';
import { idbGet, idbPut } from '../idb.ts';
import { platformAuthenticatorAvailable, registerCredential, stepUpForCommand, stepupSupported, unlock, type StepUpTransport } from '../stepup.ts';
import type { ControlTransport } from './adapter.ts';
import type { AuditEvent, LaunchEntry, NoPrompt, SendOutcome, StartOptions, StepUpAction, StepUpResult, StopStage, Tail, TailLine } from './types.ts';

const MODE_LABEL: Record<StartMode, string> = { default: 'Ask me', acceptEdits: 'Accept edits', plan: 'Plan only' };
const WHY: Record<CtlWhy, NoPrompt> = { control_off: 'off', scope: 'scope', bypass: 'bypass', unsupported: 'harness', harness: 'harness', project: 'harness', ended: 'ended', paused: 'paused' };
const ROUTE_WORDS: Record<Route, string | undefined> = {
  api: 'through its own interface', channel: 'through the Claude channel', hook: 'through its hook', keys: 'typed into its terminal: check what you sent', none: undefined,
};
const TAIL_KIND: Record<TailEntry['k'], TailLine['kind']> = { assistant: 'assistant', user: 'user', tool: 'tool', tool_out: 'output', note: 'note' };
const REFUSED: Partial<Record<Refusal, SendOutcome>> = {
  proto: 'unsupported', schema: 'failed', control_off: 'control_off', paused: 'paused', scope: 'scope', expired: 'expired', stale: 'stale', size: 'too_long', empty: 'failed',
  keystroke_prefix: 'keystroke_prefix', bypass: 'bypass', rate: 'rate_limited', unknown_session: 'gone', ended: 'gone', unsupported: 'unsupported', harness: 'harness', project: 'project',
  launch_unknown: 'unsupported', mode_not_allowed: 'mode_not_allowed', stepup_required: 'stepup', stepup_invalid: 'stepup', local_declined: 'declined', busy: 'busy', no_question: 'stale',
};
const KEEP = 300;
const AUDIT_KEY = 'ctl-audit';

export function createProtocol3Transport(link: Link): ControlTransport {
  const listeners: (() => void)[] = [];
  const emit = (): void => { for (const l of listeners) l(); };
  const stepT: StepUpTransport = { send: (k, d) => link.sendKind(k, d), next: (k, ms) => link.nextKind(k, ms) };
  let unlockedUntil = 0;
  let platform = false;
  void platformAuthenticatorAvailable().then((ok) => { platform = ok; emit(); });
  const grants = new Map<string, string>();
  const grantKey = (kind: string, target: string, text: string): string => `${kind}\0${target}\0${text}`;

  // ------------------------------------------------------------------ live tail
  const store = new Map<string, Map<number, TailEntry>>();
  const meta = new Map<string, { tools: boolean; updatedAt: number; total: number }>();
  const absorb = (sid: string, entries: readonly TailEntry[]): void => {
    let m = store.get(sid); if (!m) { m = new Map(); store.set(sid, m); }
    for (const e of entries) m.set(e.seq, e);
    if (m.size > KEEP) for (const k of [...m.keys()].sort((a, b) => a - b).slice(0, m.size - KEEP)) m.delete(k);
  };
  const asked = new Set<string>();
  link.onKind('tail', (d) => {
    const p = TailData.safeParse(d);
    if (!p.success) return;
    const t = p.data;
    const known = store.get(t.sid);
    const maxKnown = known && known.size ? Math.max(...known.keys()) : 0;
    absorb(t.sid, t.entries);
    meta.set(t.sid, { tools: t.tools, updatedAt: Date.now(), total: t.total });
    // a gap between what this page has and the new window: pull the lines in between once
    if (maxKnown > 0 && t.first > maxKnown + 1 && !asked.has(`${t.sid}:${t.first}`)) {
      asked.add(`${t.sid}:${t.first}`);
      void link.sendKind('history', { sid: t.sid, q: newCid().slice(0, 12), before: t.first, limit: 50 });
    }
    emit();
  });
  link.onKind('hist', (d) => { const p = HistData.safeParse(d); if (!p.success) return; absorb(p.data.sid, p.data.entries); emit(); });

  const leases = new Map<string, ReturnType<typeof setInterval>>();
  const lease = (sid: string): void => { void link.sendKind('watch', { sid, on: true }, watchReplaceKey(sid)); };
  let wasUp = false;
  link.onChange(() => {
    const up = link.conn === 'online' && link.hostOnline !== false;
    if (up && !wasUp) for (const sid of leases.keys()) lease(sid); // the computer (re)started: it forgets leases
    wasUp = up;
  });

  // ------------------------------------------------------------------ commands
  const waiters = new Map<string, (r: CResultData) => void>();
  link.onKind('cresult', (d) => { const p = CResultData.safeParse(d); if (p.success) waiters.get(p.data.cid)?.(p.data); });
  /** sends one command and waits for the computer's verdict; `needs_local` extends the wait (the person is at the computer) */
  async function command(kind: 'prompt' | 'interrupt' | 'start' | 'answer', data: Record<string, unknown> & { cid: string }): Promise<CResultData | 'offline' | 'timeout'> {
    const cid = data.cid;
    return new Promise((done) => {
      let t = setTimeout(() => fin('timeout'), 20_000);
      const fin = (r: CResultData | 'timeout' | 'offline'): void => { clearTimeout(t); waiters.delete(cid); done(r); };
      waiters.set(cid, (r) => { if (r.outcome === 'needs_local') { clearTimeout(t); t = setTimeout(() => fin(r), 70_000); return; } fin(r); });
      void link.sendKind(kind, data).then((ok) => { if (!ok) fin('offline'); }, () => fin('offline'));
    });
  }
  const outcomeOf = (r: CResultData | 'offline' | 'timeout'): SendOutcome => {
    if (r === 'offline') return 'offline';
    if (r === 'timeout') return 'timeout';
    switch (r.outcome) {
      case 'applied': return 'applied';
      case 'sent': return 'sent';
      case 'failed': return 'failed';
      case 'needs_local': return 'needs_local';
      case 'needs_stepup': unlockedUntil = 0; return 'stepup';
      case 'refused': return (r.why && REFUSED[r.why]) || 'failed';
    }
  };

  // ------------------------------------------------------------------ this device's own record
  let events: AuditEvent[] | null = null;
  const loadEvents = async (): Promise<AuditEvent[]> => events ??= ((await idbGet<AuditEvent[]>(AUDIT_KEY).catch(() => undefined)) ?? []);
  async function record(e: Omit<AuditEvent, 'ts' | 'device'>): Promise<void> {
    const all = await loadEvents();
    all.unshift({ ts: Date.now(), device: link.name, ...e });
    all.length = Math.min(all.length, 100);
    await idbPut(AUDIT_KEY, all).catch(() => undefined);
  }

  const sessionOf = (sid: string) => link.state?.sessions.find((s) => s.sid === sid);

  return {
    host() {
      const c = link.state?.host.ctl;
      if (!c) return null;
      const launch: LaunchEntry[] = c.launch.map((l) => ({ id: l.id, project: l.label, harness: l.harness, models: [], efforts: [], modes: l.modes.map((m) => ({ id: m, label: MODE_LABEL[m] })) }));
      return { scope: c.scope, control: c.mode, launch };
    },
    extras(sid) {
      const x = sessionOf(sid)?.ctl;
      if (!x) return null;
      const harness = sessionOf(sid)?.agent;
      return {
        prompt: x.can.prompt ? { ok: true } : { ok: false, why: WHY[x.why ?? 'unsupported'] },
        stop: x.can.interrupt ? (harness === 'claude-code' ? 'soft' : 'now') : 'none',
        ...(x.can.interrupt ? {} : { stopWhy: 'this agent cannot be stopped from outside.' }),
        tail: x.can.tail,
        ...(ROUTE_WORDS[x.route] ? { route: ROUTE_WORDS[x.route] as string } : {}),
      };
    },
    tail(sid) {
      const m = store.get(sid); const mt = meta.get(sid);
      if (!m || !mt) return null;
      const entries = [...m.values()].sort((a, b) => a.seq - b.seq);
      const cut = entries.reduce((n, e) => n + (e.cut ?? 0), 0);
      return { lines: entries.map((e) => ({ kind: TAIL_KIND[e.k], text: e.text, ts: e.ts })), ...(cut ? { cut } : {}), updatedAt: mt.updatedAt, outputShown: mt.tools, revealOnComputer: true } satisfies Tail;
    },
    watch(sid) {
      if (!sessionOf(sid)?.ctl?.can.tail) return () => undefined;
      lease(sid);
      leases.set(sid, setInterval(() => lease(sid), 4 * 60_000));
      return () => { const t = leases.get(sid); if (t) clearInterval(t); leases.delete(sid); void link.sendKind('watch', { sid, on: false }, watchReplaceKey(sid)); };
    },
    async prompt(sid, text, asAnswer) {
      const s = sessionOf(sid);
      if (!s?.ctl) return 'unsupported';
      const clean = cleanText(text);
      if (charLength(clean) > MAX_PROMPT_CHARS) return 'too_long';
      const key = grantKey(asAnswer ? 'answer' : 'prompt', sid, clean);
      const cid = grants.get(key) ?? newCid(); grants.delete(key);
      const base = { cid, sid, bind: s.ctl.bind, text: clean, x: commandExpiry() };
      const kind = asAnswer ? 'answer' : 'prompt';
      // a free-text answer is bound to the pending request that was shown (its own bind), a prompt to the session's bind
      if (asAnswer && !s.pending) return 'stale';
      const data = asAnswer ? { ...base, rid: s.pending?.rid ?? '', bind: s.pending?.bind ?? base.bind } : base;
      const r = outcomeOf(await command(kind, data));
      await record({ kind: 'prompt', target: s.label, outcome: r, chars: charLength(clean) });
      return r;
    },
    async interrupt(sid, onStage) {
      const s = sessionOf(sid);
      if (!s?.ctl) { onStage('unsupported'); return 'unsupported'; }
      onStage('stopping');
      const r = await command('interrupt', { cid: newCid(), sid, bind: s.ctl.bind, x: commandExpiry() });
      let fin: StopStage;
      if (r === 'offline') fin = 'offline';
      else if (r === 'timeout' || r.outcome === 'refused' || r.outcome === 'failed') fin = 'failed';
      else if (s.agent !== 'claude-code') fin = 'stopped_now';
      else {
        // a soft stop takes effect at the next tool call: it is only called stopped when the session is no longer working
        fin = 'unconfirmed';
        for (let i = 0; i < 180; i++) { if (sessionOf(sid)?.status !== 'working') { fin = 'stopped'; break; } await new Promise((ok) => setTimeout(ok, 500)); }
      }
      await record({ kind: 'interrupt', target: s.label, outcome: fin });
      return fin;
    },
    async start(id, o: StartOptions) {
      const mode = (o.mode ?? 'default') as StartMode;
      const clean = o.text ? cleanText(o.text) : undefined;
      if (clean !== undefined && charLength(clean) > MAX_PROMPT_CHARS) return 'too_long';
      const key = grantKey('start', `${id}:${mode}`, clean ?? '');
      const cid = grants.get(key) ?? newCid(); grants.delete(key);
      const r = await command('start', { cid, launchId: id, mode, ...(clean !== undefined ? { text: clean } : {}), x: commandExpiry() });
      const out = outcomeOf(r);
      const fin: SendOutcome = out === 'sent' || out === 'applied' ? 'started' : out;
      await record({ kind: 'start', target: o.project, outcome: fin, ...(clean !== undefined ? { chars: charLength(clean) } : {}) });
      return fin;
    },
    audit: async () => [...(await loadEvents())],
    stepUp: {
      unlockedUntil: () => unlockedUntil,
      supported: () => link.state?.host.ctl?.stepup === 'webauthn' && stepupSupported(),
      async confirm(a: StepUpAction): Promise<StepUpResult> {
        if (!(link.state?.host.ctl?.stepup === 'webauthn' && stepupSupported())) return 'unsupported';
        try {
          if (a.fresh) {
            if (!a.bind) return 'failed';
            const clean = a.text !== undefined ? cleanText(a.text) : '';
            const r = await stepUpForCommand(stepT, { kind: a.bind.kind, target: a.bind.target, text: clean });
            if (r.ok) { grants.set(grantKey(a.bind.kind, a.bind.target, clean), r.cid); return 'ok'; }
            return r.why === 'user_verification' ? 'cancelled' : 'failed';
          }
          const r = await unlock(stepT);
          if (r.ok) { unlockedUntil = r.until ?? Date.now() + 15 * 60_000; await record({ kind: 'unlock', outcome: 'fingerprint verified' }); return 'ok'; }
          return r.why === 'user_verification' ? 'cancelled' : 'failed';
        } catch { return 'failed'; }
      },
      canRegister: () => link.state?.host.ctl?.stepup === 'local' && platform,
      async register() { try { return await registerCredential(stepT, link.name); } catch { return { ok: false, why: 'declined' }; } },
    },
    onChange: (fn) => { listeners.push(fn); },
  };
}

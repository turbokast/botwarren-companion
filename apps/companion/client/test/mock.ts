/**
 * A scripted ControlApi for the Playwright specs (never bundled into the shipped client: only e2e/remote-control builds it). It records every call so a
 * spec can assert exactly what the screens asked for, and lets the spec change the computer's state while the page is open.
 */
import type { SessionState } from '../../src/protocol/index.ts';
import type { AuditEvent, CSession, ControlApi, ControlHost, SendOutcome, StartOptions, StepUpAction, StepUpResult, StopStage, Tail } from '../src/control/types.ts';

type Outcome = Awaited<ReturnType<ControlApi['answer']>>;

export const rid = (n: number): string => `req-${String(n).padStart(4, '0')}`;

export interface SessSpec extends Partial<Omit<CSession, 'state'>> { sid: string; label: string; pending?: SessionState['pending']; recent?: SessionState['recent'] }

export function sess(o: SessSpec): CSession {
  const status = o.status ?? (o.pending ? 'needs_you' : 'idle');
  const { pending, recent, ...rest } = o;
  const state: SessionState = {
    sid: o.sid, agent: (o.harness ?? 'claude-code') as SessionState['agent'], mode: o.mode ?? 'normal', label: o.label,
    status: status === 'needs_you' ? 'waiting' : status, since: o.since ?? Date.now() - 120_000, recent: recent ?? [], ...(pending ? { pending } : {}),
  };
  return { harness: 'claude-code', status, since: Date.now() - 120_000, mode: 'normal', prompt: { ok: true }, stop: 'soft', tail: true, ...rest, state } as CSession;
}

export const permission = (n: number, tool: string, summary: string, preview: string, extra: Partial<NonNullable<SessionState['pending']>> = {}): NonNullable<SessionState['pending']> => ({
  rid: rid(n), kind: 'permission', tool, summary, preview, expires: Date.now() + 600_000, bind: 'a'.repeat(64), can: { approve: true, reply: true }, ...extra,
});

export class MockApi implements ControlApi {
  hostState: ControlHost = { name: 'work-desktop', conn: 'online', online: true, ready: true, scope: 'control', control: 'on', paused: false, supported: true, launch: [] };
  sess: CSession[] = [];
  tails = new Map<string, Tail>();
  auditEvents: AuditEvent[] = [];
  presetList = [{ id: 'continue', label: 'Continue' }, { id: 'yes', label: 'Yes, go ahead' }, { id: 'no', label: 'No, do not do that' }];
  private listeners: (() => void)[] = [];
  // scripted behaviour
  promptResult: SendOutcome | (() => Promise<SendOutcome>) = 'sent';
  stopStages: StopStage[] = ['stopping', 'stopped'];
  stopDelay = 50;
  answerResult: Outcome = 'applied';
  startResult: SendOutcome = 'started';
  stepUpResult: StepUpResult = 'ok';
  stepUpIsSupported = true;
  unlocked = 0;
  // recorded
  calls: { prompt: { sid: string; text: string; asAnswer: boolean }[]; stop: string[]; start: { id: string; o: StartOptions }[]; answer: { sid: string; a: string; opt?: string | undefined }[]; stepUp: StepUpAction[]; output: { sid: string; on: boolean }[]; watch: string[]; unwatch: string[] } =
    { prompt: [], stop: [], start: [], answer: [], stepUp: [], output: [], watch: [], unwatch: [] };

  host(): ControlHost { return this.hostState; }
  sessions(): CSession[] { return this.sess; }
  presets(): { id: string; label: string }[] { return this.presetList; }
  onChange(fn: () => void): void { this.listeners.push(fn); }
  emit(): void { for (const l of this.listeners) l(); }
  tail(sid: string): Tail | null { return this.tails.get(sid) ?? null; }
  watch(sid: string): () => void { this.calls.watch.push(sid); return () => { this.calls.unwatch.push(sid); }; }
  setOutput(sid: string, on: boolean): void {
    this.calls.output.push({ sid, on });
    const t = this.tails.get(sid);
    if (t) this.tails.set(sid, { ...t, outputShown: on, lines: on ? t.lines : t.lines });
  }
  async answer(s: CSession, a: 'approve' | 'deny' | 'reply', opt?: string): Promise<Outcome> { this.calls.answer.push({ sid: s.sid, a, opt }); return this.answerResult; }
  async prompt(s: CSession, text: string, asAnswer: boolean): Promise<SendOutcome> {
    this.calls.prompt.push({ sid: s.sid, text, asAnswer });
    return typeof this.promptResult === 'function' ? this.promptResult() : this.promptResult;
  }
  async stop(s: CSession, onStage: (st: StopStage) => void): Promise<StopStage> {
    this.calls.stop.push(s.sid);
    let last: StopStage = 'stopping';
    for (const st of this.stopStages) { await new Promise((r) => setTimeout(r, this.stopDelay)); last = st; onStage(st); }
    return last;
  }
  async start(id: string, o: StartOptions): Promise<SendOutcome> { this.calls.start.push({ id, o }); return this.startResult; }
  async audit(): Promise<AuditEvent[]> { return this.auditEvents; }
  stepUp = {
    unlockedUntil: (): number => this.unlocked,
    supported: (): boolean => this.stepUpIsSupported,
    confirm: async (a: StepUpAction): Promise<StepUpResult> => { this.calls.stepUp.push(a); if (this.stepUpResult === 'ok' && !a.fresh) this.unlocked = Date.now() + 15 * 60_000; return this.stepUpResult; },
  };
  deviceName(): string { return 'Phone'; }

  // helpers for specs
  setSessions(list: CSession[]): void { this.sess = list; this.emit(); }
  setTail(sid: string, t: Partial<Tail> & Pick<Tail, 'lines'>): void { this.tails.set(sid, { updatedAt: Date.now(), outputShown: false, ...t }); this.emit(); }
  patchHost(p: Partial<ControlHost>): void { this.hostState = { ...this.hostState, ...p }; this.emit(); }
}

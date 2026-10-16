/**
 * A scripted fake coding-agent harness that implements the whole ControlAdapter interface (protocol 3, WP3): sessions that work and go idle, a permission
 * request, a question, a live tail, a prompt that starts a turn, an interrupt that stops one, a free-text answer and a start. Everything it was handed is
 * recorded EXACTLY as delivered (`received`), so tests can assert what reached the "tool" and that nothing else did.
 * It reports follow-ups the way an honest adapter does: only when the tool itself shows the effect (`followupMs: null` = never, which is "sent" not "applied").
 */
import { randomBytes } from 'node:crypto';
import {
  NO_CONTROL, type AdapterContext, type AdapterManifest, type Answer, type ControlAdapter, type ControlCaps, type ControlDelivery, type ControlPrompt, type ControlText,
  type DeliverResult, type DetectResult, type DoctorLine, type LaunchSpec, type NativeRef, type Revalidation, type TailKind,
} from '../../../src/adapters/types.ts';
import type { AgentKind } from '../../../src/protocol/index.ts';

export interface FakeSession { key: string; cwd: string; mode: 'normal' | 'bypass' | 'unknown'; busy: boolean; turn: number; pendingNative: NativeRef | null }

export interface HarnessOptions {
  id?: string;
  kind?: AgentKind;
  control?: Partial<ControlCaps>;
  /** after a delivered command, report the tool's follow-up this many ms later; null = never */
  followupMs?: number | null;
  /** how long a turn lasts before the session goes idle again (null: it stays working until interrupted or `finishTurn`) */
  turnMs?: number | null;
}

export class FakeHarness implements ControlAdapter {
  readonly manifest: AdapterManifest;
  ctx!: AdapterContext;
  readonly sessions = new Map<string, FakeSession>();
  /** what the host delivered, exactly */
  readonly received = {
    prompts: [] as { key: string; text: string; framed: string; from: string }[],
    interrupts: [] as { key: string; from: string }[],
    answers: [] as { native: string; text: string; from: string }[],
    starts: [] as { launch: LaunchSpec; first: { text: string; framed: string } | null; from: string }[],
    permissions: [] as { native: string; answer: Answer }[],
  };
  followupMs: number | null;
  turnMs: number | null;
  /** the next control call answers this instead of acting */
  nextResult: ControlDelivery | null = null;
  private seq = 0;

  constructor(o: HarnessOptions = {}) {
    this.followupMs = o.followupMs === undefined ? 10 : o.followupMs;
    this.turnMs = o.turnMs === undefined ? null : o.turnMs;
    this.manifest = {
      id: o.id ?? 'fake-harness', kind: o.kind ?? 'other', safety: 'A',
      caps: { detect: true, readPending: true, readRecent: true, approve: true, deny: true, presetReply: true, optionAnswer: true },
      reads: ['scripted fixtures only: this harness is a test double and reads nothing from the machine'],
      verified: { versions: [] }, confirmFloor: { approve: 'off', reply: 'off' }, observesOutcome: true,
      control: { ...NO_CONTROL, prompt: true, interrupt: true, answer: true, start: true, tail: true, route: 'api', ...(o.control ?? {}) },
    };
  }

  // ------------------------------------------------------------------ Adapter
  async detect(): Promise<DetectResult> { return { present: true, version: 'fake' }; }
  async start(ctx: AdapterContext): Promise<void> { this.ctx = ctx; }
  async stop(): Promise<void> { /* nothing to stop */ }
  async doctor(): Promise<DoctorLine[]> { return []; }
  release(): void { /* nothing held */ }
  async revalidate(n: NativeRef): Promise<Revalidation> {
    for (const s of this.sessions.values()) if (s.pendingNative?.id === n.id) return 'live';
    return 'gone';
  }
  async deliver(n: NativeRef, a: Answer): Promise<DeliverResult> {
    const s = [...this.sessions.values()].find((x) => x.pendingNative?.id === n.id);
    if (!s) return 'gone';
    this.received.permissions.push({ native: n.id, answer: a });
    s.pendingNative = null;
    this.setWorking(s, true);
    setTimeout(() => this.ctx.report.resolved(n, a.t === 'permission' && a.behavior === 'allow' ? 'allowed' : 'denied'), 5);
    return 'delivered';
  }

  // ------------------------------------------------------------------ ControlAdapter
  private take(): ControlDelivery | null { const r = this.nextResult; this.nextResult = null; return r; }

  async sendPrompt(key: string, p: ControlPrompt, who: { device: string }): Promise<ControlDelivery> {
    if (!this.manifest.control.prompt) return 'unsupported';
    const forced = this.take(); if (forced) return forced;
    const s = this.sessions.get(key);
    if (!s) return 'gone';
    this.received.prompts.push({ key, text: p.text, framed: p.framed, from: who.device });
    this.emit(key, [{ k: 'user', text: p.text, ts: this.ctx.now() }]);
    this.beginTurn(s);
    if (this.followupMs !== null) setTimeout(() => this.ctx.report.followup(key, 'prompt'), this.followupMs);
    return 'delivered';
  }

  async interrupt(key: string, who: { device: string }): Promise<ControlDelivery> {
    if (!this.manifest.control.interrupt) return 'unsupported';
    const forced = this.take(); if (forced) return forced;
    const s = this.sessions.get(key);
    if (!s) return 'gone';
    this.received.interrupts.push({ key, from: who.device });
    this.setWorking(s, false);
    this.emit(key, [{ k: 'note', text: 'interrupted', ts: this.ctx.now() }]);
    if (this.followupMs !== null) setTimeout(() => this.ctx.report.followup(key, 'interrupt'), this.followupMs);
    return 'delivered';
  }

  async answerText(n: NativeRef, text: ControlText, who: { device: string }): Promise<ControlDelivery> {
    if (!this.manifest.control.answer) return 'unsupported';
    const forced = this.take(); if (forced) return forced;
    const s = [...this.sessions.values()].find((x) => x.pendingNative?.id === n.id);
    if (!s) return 'gone';
    this.received.answers.push({ native: n.id, text, from: who.device });
    s.pendingNative = null;
    this.ctx.report.cleared(s.key, 'answered_local', n.id);
    this.beginTurn(s);
    if (this.followupMs !== null) setTimeout(() => this.ctx.report.followup(s.key, 'answer'), this.followupMs);
    return 'delivered';
  }

  async startSession(launch: LaunchSpec, first: ControlPrompt | null, who: { device: string }): Promise<{ result: ControlDelivery; sessionKey?: string }> {
    if (!this.manifest.control.start) return { result: 'unsupported' };
    const forced = this.take(); if (forced) return { result: forced };
    this.received.starts.push({ launch, first: first ? { text: first.text, framed: first.framed } : null, from: who.device });
    const key = `fake-new-${++this.seq}`;
    setTimeout(() => { this.spawn(key, { cwd: launch.root }); if (first) { this.emit(key, [{ k: 'user', text: first.text, ts: this.ctx.now() }]); this.beginTurn(this.sessions.get(key)!); } }, 10);
    return { result: 'delivered', sessionKey: key };
  }

  // ------------------------------------------------------------------ the script (what a test drives)
  /** a session appears and is idle */
  spawn(key = `fake-${++this.seq}`, o: { cwd?: string; mode?: 'normal' | 'bypass' | 'unknown' } = {}): FakeSession {
    const s: FakeSession = { key, cwd: o.cwd ?? '/work/dragon-game', mode: o.mode ?? 'normal', busy: false, turn: 0, pendingNative: null };
    this.sessions.set(key, s);
    this.ctx.report.session({ key, agent: this.manifest.kind, cwd: s.cwd, status: 'idle', mode: s.mode });
    this.ctx.report.changed(true);
    return s;
  }
  private setWorking(s: FakeSession, working: boolean): void {
    s.busy = working;
    this.ctx.report.session({ key: s.key, agent: this.manifest.kind, cwd: s.cwd, status: working ? 'working' : 'idle', mode: s.mode });
    this.ctx.report.changed(true);
  }
  private beginTurn(s: FakeSession): void {
    s.turn += 1;
    this.setWorking(s, true);
    if (this.turnMs !== null) setTimeout(() => { if (s.busy) { this.say(s.key, `turn ${s.turn} finished`); this.setWorking(s, false); } }, this.turnMs);
  }
  /** the session ends */
  end(key: string): void { this.ctx.report.session({ key, agent: this.manifest.kind, status: 'ended' }); this.ctx.report.changed(true); }
  /** the agent starts working without being asked */
  work(key: string): void { this.setWorking(this.sessions.get(key)!, true); }
  finishTurn(key: string): void { this.setWorking(this.sessions.get(key)!, false); }
  say(key: string, text: string): void { this.emit(key, [{ k: 'assistant', text, ts: this.ctx.now() }]); }
  /** a harness that does not declare tail reports none */
  private emit(key: string, items: { k: TailKind; text: string; ts: number }[]): void { if (this.manifest.control.tail) this.ctx.report.tail(key, items); }
  tool(key: string, summary: string, output?: string): void {
    this.emit(key, [{ k: 'tool', text: summary, ts: this.ctx.now() }, ...(output !== undefined ? [{ k: 'tool_out' as TailKind, text: output, ts: this.ctx.now() }] : [])]);
  }
  rawTail(key: string, items: { k: TailKind; text: string; ts?: number }[]): void { this.emit(key, items.map((i) => ({ ...i, ts: i.ts ?? this.ctx.now() }))); }
  /** a permission request the host can approve or deny */
  async askPermission(key: string, o: { tool?: string; preview?: string } = {}): Promise<NativeRef> {
    const s = this.sessions.get(key)!;
    const native: NativeRef = { adapter: this.manifest.id, kind: 'invocation', id: randomBytes(4).toString('hex'), fingerprint: 'fp' };
    s.pendingNative = native;
    await this.ctx.report.pending({ sessionKey: key, kind: 'permission', tool: o.tool ?? 'Bash', summary: 'Run a command', preview: o.preview ?? 'ls -la', ttlMs: 600_000, native, can: { approve: true, reply: false }, risk: [], source: 'structured' });
    this.ctx.report.changed(true);
    return native;
  }
  /** a question that takes a free-text answer (and optionally offers options) */
  async askQuestion(key: string, question = 'Which branch should I use?', options?: { id: string; label: string }[]): Promise<NativeRef> {
    const s = this.sessions.get(key)!;
    const native: NativeRef = { adapter: this.manifest.id, kind: 'request_id', id: randomBytes(4).toString('hex'), fingerprint: 'fq' };
    s.pendingNative = native;
    await this.ctx.report.pending({ sessionKey: key, kind: 'question', summary: question, preview: question, ttlMs: 600_000, native, can: { approve: false, reply: !!options }, risk: [], source: 'structured', ...(options ? { options, optionText: Object.fromEntries(options.map((o) => [o.id, o.label])) as never } : {}) });
    this.ctx.report.changed(true);
    return native;
  }
}

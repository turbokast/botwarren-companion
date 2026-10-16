/**
 * A stand-in adapter for tests of the host's side of the adapter contract: it records exactly what the host delivers to it, and reports whatever
 * sessions and requests the test tells it to. It also stands for "a tool" in the contract suite.
 */
import { randomBytes } from 'node:crypto';
import { NO_CONTROL, type Adapter, type AdapterContext, type AdapterManifest, type Answer, type DeliverResult, type NativeRef, type PendingReport, type Revalidation } from '../src/adapters/types.ts';
import type { AgentKind } from '../src/protocol/index.ts';

export class FakeAdapter implements Adapter {
  manifest: AdapterManifest;
  ctx!: AdapterContext;
  /** every answer the host delivered, in order */
  delivered: { n: NativeRef; a: Answer; device: string }[] = [];
  released: NativeRef[] = [];
  /** what revalidate says (the test flips it to simulate "the native object changed") */
  state: Revalidation = 'live';
  deliverResult: DeliverResult = 'delivered';
  /** after an allow is delivered, report the tool's follow-up this many ms later (null: never) */
  resolveAfterMs: number | null = null;
  constructor(o: { id?: string; kind?: AgentKind; observesOutcome?: boolean; floor?: { approve: 'off' | 'risky' | 'always'; reply: 'off' | 'risky' | 'always' } } = {}) {
    this.manifest = {
      id: o.id ?? 'fake', kind: o.kind ?? 'codex', safety: 'B',
      caps: { detect: true, readPending: true, readRecent: true, approve: true, deny: true, presetReply: true, optionAnswer: true },
      reads: ['test fixtures'], verified: { versions: [] }, confirmFloor: o.floor ?? { approve: 'off', reply: 'off' }, observesOutcome: o.observesOutcome ?? true, control: NO_CONTROL,
    };
  }
  async detect() { return { present: true, version: '0.0.0-test' }; }
  async start(ctx: AdapterContext): Promise<void> { this.ctx = ctx; }
  async stop(): Promise<void> { /* nothing */ }
  async revalidate(): Promise<Revalidation> { return this.state; }
  async deliver(n: NativeRef, a: Answer, who: { device: string }): Promise<DeliverResult> {
    if (this.deliverResult === 'delivered') {
      this.delivered.push({ n, a, device: who.device });
      if (a.t === 'permission' && a.behavior === 'allow' && this.resolveAfterMs !== null) setTimeout(() => this.ctx.report.resolved(n, 'allowed'), this.resolveAfterMs);
    }
    return this.deliverResult;
  }
  release(n: NativeRef): void { this.released.push(n); }
  async doctor() { return []; }

  ref(id = randomBytes(4).toString('hex')): NativeRef { return { adapter: this.manifest.id, kind: 'invocation', id, fingerprint: `fp-${id}` }; }

  session(key = 'fake-1', o: { cwd?: string; mode?: 'normal' | 'bypass' | 'unknown'; agent?: AgentKind } = {}): void {
    this.ctx.report.session({ key, agent: o.agent ?? this.manifest.kind, cwd: o.cwd ?? '/work/dragon-game', status: 'working', ...(o.mode ? { mode: o.mode } : {}) });
  }

  async pending(p: Partial<PendingReport> & { sessionKey?: string } = {}): Promise<NativeRef | null> {
    const native = p.native === undefined ? this.ref() : p.native;
    await this.ctx.report.pending({
      sessionKey: p.sessionKey ?? 'fake-1', kind: p.kind ?? 'permission', tool: p.tool ?? 'Bash', summary: p.summary ?? 'Run a command', preview: p.preview ?? 'ls -la', ttlMs: p.ttlMs ?? 600_000,
      native, can: p.can ?? { approve: true, reply: false }, risk: p.risk ?? [], source: p.source ?? 'structured',
      ...(p.denyWithPreset ? { denyWithPreset: true } : {}), ...(p.options ? { options: p.options } : {}), ...(p.optionText ? { optionText: p.optionText } : {}),
    });
    this.ctx.report.changed(true);
    return native;
  }
}

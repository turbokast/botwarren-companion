/**
 * The adapter hub: the host's registry of adapters. It builds each adapter's context (the narrow `report` surface into the session table), routes the
 * hook command's calls to the hook adapters, and carries an already-authorised answer to the adapter that owns the request. It decides nothing.
 * Licence: Apache-2.0.
 */
import type { CompanionHost } from '../host.ts';
import type { PendingInternal } from '../sessions.ts';
import { isControlAdapter, type Adapter, type AdapterConfig, type AdapterContext, type Answer, type ControlAdapter, type DeliverResult, type HookAdapter, type HookCall, type NativeRef, type Revalidation } from './types.ts';

export const isHookAdapter = (a: Adapter): a is HookAdapter => typeof (a as Partial<HookAdapter>).onHook === 'function';

type How = 'allowed' | 'denied' | 'unknown';

export class AdapterHub {
  private readonly host: CompanionHost;
  private readonly adapters = new Map<string, Adapter>();
  private readonly waiters = new Map<string, (h: How) => void>();
  private started = false;

  constructor(host: CompanionHost) { this.host = host; host.sessions.onRelease = (p) => this.release(p); }

  register(a: Adapter): void {
    this.adapters.set(a.manifest.id, a);
    if (this.started) void a.start(this.contextFor(a)).catch(() => this.host.store.audit('adapter_start_failed', { adapter: a.manifest.id }));
  }
  get(id: string): Adapter | undefined { return this.adapters.get(id); }
  list(): Adapter[] { return [...this.adapters.values()]; }
  /** the adapter that can act on this adapter id's sessions (protocol 3), only if it implements the control interface AND declares some control capability */
  controlOf(id: string | undefined): ControlAdapter | undefined {
    const a = id ? this.adapters.get(id) : undefined;
    if (!a || !isControlAdapter(a)) return undefined;
    const c = a.manifest.control;
    return c.prompt || c.interrupt || c.answer || c.start ? a : undefined;
  }
  /** the first enabled control adapter of a harness that can start sessions (a launch entry names a harness, not an adapter) */
  starterFor(kind: string): ControlAdapter | undefined {
    for (const a of this.adapters.values()) if (a.manifest.kind === kind && isControlAdapter(a) && a.manifest.control.start && this.configOf(a.manifest.id).enabled !== false) return a;
    return undefined;
  }

  async start(): Promise<void> {
    this.started = true;
    for (const a of this.adapters.values()) {
      try { await a.start(this.contextFor(a)); } catch { this.host.store.audit('adapter_start_failed', { adapter: a.manifest.id }); }
    }
  }
  async stop(): Promise<void> { for (const a of this.adapters.values()) { try { await a.stop(); } catch { /* keep stopping the others */ } } this.started = false; }

  /** the daemon passes the hook command's call here; an unknown or disabled tool gets no answer (the tool shows its own prompt) */
  async hook(tool: string, call: HookCall): Promise<Record<string, unknown> | null> {
    const a = this.adapters.get(tool);
    if (!a || !isHookAdapter(a)) return null;
    if (this.configOf(a.manifest.id).enabled === false) return null;
    return a.onHook(call);
  }

  // ------------------------------------------------------------------ routes
  private release(p: PendingInternal): void {
    if (!p.route) return;
    this.adapters.get(p.route.adapter)?.release(p.route.native);
  }
  async revalidate(n: NativeRef): Promise<Revalidation> {
    const a = this.adapters.get(n.adapter);
    if (!a) return 'gone';
    try { return await a.revalidate(n); } catch { return 'gone'; }
  }
  async deliver(n: NativeRef, ans: Answer, who: { device: string }): Promise<DeliverResult> {
    const a = this.adapters.get(n.adapter);
    if (!a) return 'gone';
    try { return await a.deliver(n, ans, who); } catch { return 'failed'; }
  }

  /** registered BEFORE delivering, so a follow-up that arrives at once is not missed; resolves `timeout` after `ms` */
  expectResolved(nativeId: string, ms: number): { done: Promise<How | 'timeout'>; cancel: () => void } {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = new Promise<How | 'timeout'>((ok) => {
      this.waiters.set(nativeId, (h) => ok(h));
      timer = setTimeout(() => ok('timeout'), ms);
      timer.unref?.();
    });
    const cancel = (): void => { if (timer) clearTimeout(timer); this.waiters.delete(nativeId); };
    return { done: done.finally(cancel), cancel };
  }

  // ------------------------------------------------------------------ context
  configOf(id: string): AdapterConfig {
    const all = this.host.store.config().adapters as Record<string, unknown>;
    const c = all[id];
    if (c && typeof c === 'object') return { enabled: true, hold: 'never', holdSeconds: 30, ...(c as Record<string, unknown>) } as AdapterConfig;
    return { enabled: true, hold: 'never', holdSeconds: 30 };
  }

  contextFor(a: Adapter): AdapterContext {
    const host = this.host; const t = host.sessions; const id = a.manifest.id;
    return {
      now: () => host.nowMs(),
      facts: () => ({ away: host.isAway(), paused: host.config.paused, relayOnline: host.relayState === 'online', devices: host.listDevices().length }),
      config: () => this.configOf(id),
      audit: (kind, fields = {}) => host.store.audit(`${id}_${kind}`, fields),
      report: {
        session: (r) => {
          let s = t.byKeyOrAlias(r.key) ?? (r.correlate ?? []).map((c) => t.byKeyOrAlias(c)).find((x) => x !== undefined);
          if (s && r.passive) {
            for (const c of [r.key, ...(r.correlate ?? [])]) if (c !== s.key && !s.aliases.includes(c)) s.aliases.push(c);
            if (r.mode === 'bypass') s.mode = 'bypass'; // an observer may only tighten: a session it knows runs without prompts has nothing to approve
            return 'existing';
          }
          const fresh = !s;
          s ??= t.upsert(r.key, r.cwd ?? '', r.agent);
          s.owner ??= id; // control commands for this session go to the adapter that created it
          if (r.cwd) t.upsert(s.key, r.cwd, s.agent);
          if (r.label) s.label = r.label;
          s.lastEventAt = host.nowMs();
          for (const c of [r.key, ...(r.correlate ?? [])]) if (c !== s.key && !s.aliases.includes(c)) s.aliases.push(c);
          if (r.mode) s.mode = r.mode;
          if (r.status === 'ended') t.end(s); else if (!(r.status === 'idle' && s.pending)) t.setStatus(s, r.status);
          return fresh ? 'created' : 'existing';
        },
        pending: async (p) => {
          const s = t.byKeyOrAlias(p.sessionKey);
          if (!s) return;
          // text read off a screen never replaces a request a tool reported itself (the structured one wins; the screen only corroborates)
          if (p.source === 'screen' && s.pending && s.pending.pub.source !== 'screen') return;
          if (p.onlyIfNone && s.pending) return;
          await t.setPending(s, {
            kind: p.kind, ...(p.tool ? { tool: p.tool } : {}), summary: p.summary, preview: p.preview, ...(p.options ? { options: p.options } : {}), ttlMs: p.ttlMs,
            route: p.native, can: p.can, ...(p.optionText ? { optionText: p.optionText } : {}), risk: p.risk, source: p.source, ...(p.denyWithPreset ? { denyWithPreset: true } : {}),
          });
          if (p.kind === 'idle') t.setStatus(s, 'idle'); // an idle request is a state of the agent, not something it is stuck on
        },
        cleared: (key, why, onlyNative, onlySource) => {
          const s = t.byKeyOrAlias(key);
          if (!s || !s.pending) return false;
          if (onlyNative !== undefined && s.pending.route?.native.id !== onlyNative) return false;
          if (onlySource !== undefined && (s.pending.pub.source ?? 'structured') !== onlySource) return false;
          t.clearPending(s, why);
          if (s.status === 'waiting') t.setStatus(s, why === 'ended' ? 'ended' : 'working');
          return true;
        },
        recent: (key, texts) => { const s = t.byKeyOrAlias(key); if (s) t.setRecent(s, texts); },
        resolved: (n, how) => { const w = this.waiters.get(n.id); if (w) w(how); },
        changed: (urgent = false) => host.schedulePush(urgent ? 0 : 150),
        tail: (key, items) => { const s = t.byKeyOrAlias(key); if (s && s.owner === id && a.manifest.control.tail) host.ingestTail(s, items); }, // an adapter that does not declare tail cannot feed one
        followup: (key, what) => { const s = t.byKeyOrAlias(key); if (s && s.owner === id) host.noteFollowup(s, what); },
      },
    };
  }
}

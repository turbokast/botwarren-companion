/**
 * The hook family: tools whose permission prompt is a synchronous `PermissionRequest` hook that can answer allow or deny (Codex, Muse, Copilot CLI).
 * One class serves all of them; a small descriptor (hookfamily/tools/*.ts) says how each tool's input is read and its decision written.
 *
 * Holding. The tool runs the hook BEFORE it shows its own dialog and shows the dialog only after the hook returns (observed for Codex in spike S-C1:
 * the dialog appeared after an 8 s hook ended). So a held hook delays the local dialog by the hold time. The adapter therefore holds ONLY while the
 * person said they are away (`botwarren-companion away on`), only up to 45 s, only for a verified tool version, and then returns no decision so the
 * tool shows its normal dialog. Otherwise it reports the request and returns at once (read-only card: "answer on your computer").
 *
 * What it never does: send anything but allow-once or deny (+ a host preset as the reason); read the tool's output (a PostToolUse's `tool_response` is
 * ignored); read any file. Licence: Apache-2.0.
 */
import { createHash, randomBytes } from 'node:crypto';
import { clip } from '../../mask.ts';
import { versionProbe } from '../io.ts';
import { safeDeviceName, versionVerified, type Adapter, type AdapterContext, type AdapterManifest, type Answer, type DeliverResult, type DetectResult, type DoctorLine, type HookAdapter, type HookCall, type NativeRef, type Revalidation } from '../types.ts';
import type { HookTool, ParsedHook } from './types.ts';

export const MAX_HOLD_SECONDS = 45;
const REPORT_TTL_MS = 10 * 60_000;
const IDLE_TTL_MS = 30 * 60_000;

interface Held { resolve: (v: { behavior: 'allow' | 'deny'; message?: string } | null) => void; fp: string; session: string }

/** JSON with sorted keys, so the same input always hashes the same */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}

export class HookFamilyAdapter implements Adapter, HookAdapter {
  readonly manifest: AdapterManifest;
  private ctx: AdapterContext | null = null;
  private readonly tool: HookTool;
  private readonly held = new Map<string, Held>();
  /** the last allow delivered per session, waiting for the tool's PostToolUse to prove it ran */
  private readonly delivered = new Map<string, { native: NativeRef; fp: string }>();
  private readonly probe: () => Promise<string | null>;
  private extraDoctor: () => Promise<DoctorLine[]>;

  constructor(tool: HookTool, o: { versionProbe?: () => Promise<string | null>; doctor?: () => Promise<DoctorLine[]> } = {}) {
    this.tool = tool; this.manifest = tool.manifest;
    this.probe = o.versionProbe ?? versionProbe(tool.bin);
    this.extraDoctor = o.doctor ?? (async () => []);
  }

  // ------------------------------------------------------------------ adapter interface
  async detect(): Promise<DetectResult> {
    const version = await this.probe();
    return version ? { present: true, version, note: versionVerified(version, this.manifest.verified.versions) ? 'verified version: can answer while you are away' : 'untested version: shown, cannot be answered from the phone' } : { present: false, note: `${this.tool.bin} was not found on PATH` };
  }
  async start(ctx: AdapterContext): Promise<void> { this.ctx = ctx; }
  async stop(): Promise<void> { for (const h of this.held.values()) h.resolve(null); this.held.clear(); }

  async doctor(): Promise<DoctorLine[]> {
    const d = await this.detect();
    const cfg = this.ctx?.config();
    return [
      { label: `${this.tool.id} version`, value: d.version ? `${d.version}${versionVerified(d.version, [...this.manifest.verified.versions, ...(this.ctx?.config().verifiedVersions ?? [])]) ? ' (verified)' : ' (not verified: read-only)'}` : 'not found', ok: d.version ? versionVerified(d.version, [...this.manifest.verified.versions, ...(this.ctx?.config().verifiedVersions ?? [])]) : null },
      { label: `${this.tool.id} holding`, value: cfg ? (cfg.hold === 'away' ? `while away, up to ${Math.min(MAX_HOLD_SECONDS, cfg.holdSeconds)} s` : 'never (report only)') : 'unknown', ok: null },
      ...(await this.extraDoctor()),
    ];
  }

  async revalidate(n: NativeRef): Promise<Revalidation> {
    const h = this.held.get(n.id);
    if (!h) return 'gone';
    return h.fp === n.fingerprint ? 'live' : 'changed';
  }

  release(n: NativeRef): void {
    const h = this.held.get(n.id);
    if (h) { this.held.delete(n.id); h.resolve(null); }
  }

  async deliver(n: NativeRef, a: Answer, who: { device: string }): Promise<DeliverResult> {
    const h = this.held.get(n.id);
    if (!h) return 'gone';
    if (h.fp !== n.fingerprint) return 'changed';
    if (a.t !== 'permission' || (a.behavior === 'allow' && this.tool.approveEffective === false)) return 'unsupported';
    this.held.delete(n.id);
    if (a.behavior === 'allow') this.delivered.set(h.session, { native: n, fp: h.fp });
    // the reason an agent reads: fixed words, the phone's plain-character name, and (for "deny and say") one of the host's own presets
    h.resolve({ behavior: a.behavior, ...(a.behavior === 'deny' ? { message: `Denied from "${safeDeviceName(who.device)}" via Botwarren Companion${a.message ? `: ${a.message}` : ''}` } : {}) });
    return 'delivered';
  }

  // ------------------------------------------------------------------ hooks
  fingerprint(p: ParsedHook): string {
    return createHash('sha256').update([p.sessionId, p.turnId ?? '', p.tool ?? '', canonical(this.tool.fingerprintInput(p))].join('\u0000')).digest('hex');
  }

  async onHook(h: HookCall): Promise<Record<string, unknown> | null> {
    const ctx = this.ctx;
    if (!ctx) return null;
    const p = this.tool.parse(h.event, h.input);
    if (!p || !p.sessionId) return null;
    const key = `${this.tool.id}:${p.sessionId}`;
    const mode = this.tool.bypass(p) ? 'bypass' : 'normal';
    const base = { key, agent: this.tool.kind, cwd: p.cwd, mode } as const;
    switch (p.kind) {
      case 'start': ctx.report.session({ ...base, status: 'idle' }); break;
      case 'end': ctx.report.cleared(key, 'ended'); ctx.report.session({ ...base, status: 'ended' }); break;
      case 'prompt': ctx.report.cleared(key, 'prompt'); ctx.report.session({ ...base, status: 'working' }); break;
      case 'interrupt': ctx.report.cleared(key, 'prompt'); ctx.report.session({ ...base, status: 'idle' }); break;
      case 'notification': {
        // a tool's own "this really needs a human" signal (Muse sends it only after its deadline with the request still pending): a read-only card,
        // and never in place of a request this adapter is holding
        if (p.notificationType === 'permission_prompt' || p.notificationType === 'question_prompt') {
          ctx.report.session({ ...base, status: 'waiting' });
          await ctx.report.pending({ sessionKey: key, kind: p.notificationType === 'question_prompt' ? 'question' : 'permission', summary: clip((p.text ?? '').trim() || 'Waiting for you', 200), preview: '', ttlMs: REPORT_TTL_MS, native: null, can: { approve: false, reply: false }, risk: [], source: 'structured', onlyIfNone: true });
        } else ctx.report.session({ ...base, status: 'working' });
        break;
      }
      case 'post': {
        ctx.report.cleared(key, 'tool_ran');
        ctx.report.session({ ...base, status: 'working' });
        const d = this.delivered.get(key);
        if (d && d.fp === this.fingerprint(p)) { this.delivered.delete(key); ctx.report.resolved(d.native, 'allowed'); }
        break;
      }
      case 'idle': {
        ctx.report.cleared(key, 'stop');
        ctx.report.session({ ...base, status: 'idle' });
        const last = clip((p.text ?? '').trim(), 600);
        if (last) ctx.report.recent(key, [{ text: last, ts: ctx.now() }]);
        await ctx.report.pending({ sessionKey: key, kind: 'idle', summary: 'Waiting for your next instruction', preview: last, ttlMs: IDLE_TTL_MS, native: null, can: { approve: false, reply: false }, risk: [], source: 'structured' });
        break;
      }
      case 'permission': return this.onPermission(ctx, h, p, key, base);
    }
    ctx.report.changed();
    return null;
  }

  private async onPermission(ctx: AdapterContext, h: HookCall, p: ParsedHook, key: string, base: { key: string; agent: HookTool['kind']; cwd: string; mode: 'bypass' | 'normal' }): Promise<Record<string, unknown> | null> {
    ctx.report.session({ ...base, status: 'waiting' });
    const v = this.tool.view(p);
    const cfg = ctx.config(); const f = ctx.facts();
    const verified = versionVerified(await this.probe().catch(() => null), [...this.manifest.verified.versions, ...(cfg.verifiedVersions ?? [])]);
    const hold = verified && (this.tool.holdable ? this.tool.holdable(p) : true) && base.mode !== 'bypass' && cfg.hold === 'away' && f.away && f.devices > 0 && !f.paused && f.relayOnline;
    const common = { sessionKey: key, kind: 'permission' as const, tool: p.tool ?? 'tool', summary: v.summary, preview: v.preview, risk: v.risk, source: 'structured' as const };
    if (!hold) {
      // report only: the card says "answer on your computer", the tool shows its own dialog at once
      await ctx.report.pending({ ...common, ttlMs: REPORT_TTL_MS, native: null, can: { approve: false, reply: false } });
      ctx.report.changed(true);
      return null;
    }
    const holdMs = Math.min(MAX_HOLD_SECONDS, Math.max(5, cfg.holdSeconds)) * 1000;
    const id = randomBytes(6).toString('hex');
    const fp = this.fingerprint(p);
    const native: NativeRef = { adapter: this.manifest.id, kind: 'invocation', id, fingerprint: fp };
    const denyOnly = this.tool.approveEffective === false;
    let resolveHook: ((x: { behavior: 'allow' | 'deny'; message?: string } | null) => void) | null = null;
    const waiter = new Promise<{ behavior: 'allow' | 'deny'; message?: string } | null>((ok) => { resolveHook = ok; });
    this.held.set(id, { resolve: (x) => resolveHook?.(x), fp, session: key });
    await ctx.report.pending({ ...common, ttlMs: holdMs + 5000, native, can: denyOnly ? { approve: false, reply: false, deny: true } : { approve: true, reply: false }, denyWithPreset: true });
    ctx.report.changed(true);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; resolveHook?.(null); }, holdMs);
    h.onCancel(() => resolveHook?.(null));
    const decision = await waiter;
    clearTimeout(timer);
    this.held.delete(id);
    if (!decision) {
      // nobody answered in time (or the request was withdrawn): no decision, so the tool shows its own dialog; the card stays as a read-only "waiting" until the tool moves on
      if (ctx.report.cleared(key, 'expired', id) && timedOut) await ctx.report.pending({ ...common, ttlMs: REPORT_TTL_MS, native: null, can: { approve: false, reply: false } });
      ctx.report.changed(true);
      return null;
    }
    return this.tool.decision(decision);
  }
}

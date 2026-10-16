/**
 * Remote control: the host's decision pipeline for the protocol 3 kinds (see PROTOCOL3.md in the Companion's docs folder).
 * The companion decides, never the client and never an adapter: device scope, the master switch, expiry, `cid` de-duplication, rate buckets, the session
 * bind, the text rules, step-up (WebAuthn, verified here) or local confirmation, and only then one delivery by the adapter that owns the session.
 * Also owns the live tail (watch, coalesced pushes, history) and the step-up state. Audit lines carry kinds, outcomes and a hash, never content.
 * Licence: Apache-2.0.
 */
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import {
  COMMAND_SKEW_MS, COMMAND_TTL_MS, CID_DEDUPE_MS, Cid, HISTORY_MAX_LIMIT, MAX_WATCHED_SESSIONS, PromptData, InterruptData, StartData, AnswerData, STEPUP_CHALLENGE_TTL_MS, STEPUP_GRANT_TTL_MS,
  SuAssertData, SuBeginData, SuRegBeginData, SuRegData, TAIL_MIN_GAP_MS, WATCH_LEASE_MS, WatchData, HistoryData, b64u, commandDigest, scopeAtLeast, stepupChallenge, unb64u,
  type CResultData, type CommandKind, type CtlWhy, type HistData, type HostCtl, type Refusal, type Scope, type SessionCtl, type SuChallengeData, type SuRegChallengeData, type SuResultData, type SuRegResultData, type TailData, type TailKind,
  watchReplaceKey, charLength,
} from './protocol/index.ts';
import { verifyAssertion, verifyRegistration, relyingPartyOf, COSE_ALGS, type Relying } from './stepup.ts';
import { ActionLimiter, checkControlText, projectAllowed, spendAll } from './policy.ts';
import { sessionBind, type Sess, type SessionTable } from './sessions.ts';
import { sanitizeTail } from './tail.ts';
import { asControlText } from './adapters/preset.ts';
import { safeDeviceName, type ControlAdapter, type ControlCaps, type ControlDelivery, type ControlPrompt } from './adapters/types.ts';
import type { AdapterHub } from './adapters/hub.ts';
import type { Config, DeviceRecord, Store } from './store.ts';
import type { LocalConfirmRequest } from './host.ts';

export interface ControlDeps {
  store: Store;
  now(): number;
  sessions: SessionTable;
  hub: AdapterHub;
  /** the host's overall action bucket (6 a minute, shared with approve/deny/reply) */
  overall(): ActionLimiter;
  send(dev: DeviceRecord, kind: string, data: unknown, ttlMs: number, replace?: string): Promise<boolean>;
  /** asks the person at the computer; resolves false on no or after 60 s */
  confirm(r: LocalConfirmRequest): Promise<boolean>;
  saveDevices(): void;
  devices(): readonly DeviceRecord[];
  secrets(): string[];
  /** largest JSON the relay will carry in one frame, in bytes */
  innerBudget(): number;
  /** how long to wait for the tool's own follow-up before saying `sent` (ms) */
  followupWaitMs: number;
  /** tests shorten the 1 s gap between two tail pushes of one session */
  tailGapMs?: number;
  env: Record<string, string | undefined>;
}

type Reply = Omit<CResultData, 'cid' | 'kind'>;
interface Challenge { ch: string; for: 'unlock' | 'cmd'; cid?: string; kind?: CommandKind; digest?: string; exp: number }
interface RegChallenge { ch: string; exp: number }
interface Grant { digest: string; kind: CommandKind; exp: number }
interface Watch { lease: number; lastSeq: number; lastAt: number; /** send the window even if nothing is new (a toggle changed what it says) */ force: boolean }

const MAX_CIDS = 500;
const refuse = (why: Refusal, note?: string): Reply => ({ outcome: 'refused', why, ...(note ? { note } : {}) });
const sha16 = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16);

export class ControlGate {
  private readonly d: ControlDeps;
  private readonly inflight = new Set<string>();
  private readonly challenges = new Map<string, Challenge>();
  private readonly regChallenges = new Map<string, RegChallenge>();
  private readonly regBusy = new Set<string>();
  private readonly grants = new Map<string, Grant>();
  private readonly unlocks = new Map<string, number>();
  private readonly watchers = new Map<string, Map<string, Watch>>();
  private readonly waiters = new Map<string, () => void>();
  private readonly buckets = new Map<string, { key: string; l: ActionLimiter }>();
  private readonly smallRates = new Map<string, number[]>();
  private lastFullPrune = 0;
  private tailTokens = 3;
  private pump: ReturnType<typeof setTimeout> | null = null;
  private pumpDue = 0;
  private tailTokensAt = 0;

  constructor(d: ControlDeps) { this.d = d; }

  // ------------------------------------------------------------------ small helpers
  private cfg(): Config { return this.d.store.config(); }
  private bucket(name: string, perMinute: number, perHour: number): ActionLimiter {
    const key = `${perMinute}/${perHour}`;
    let b = this.buckets.get(name);
    if (!b || b.key !== key) { b = { key, l: new ActionLimiter(perMinute, perHour) }; this.buckets.set(name, b); }
    return b.l;
  }
  /** at most `max` events per `windowMs` for `key`; records this one when it is allowed */
  private rate(key: string, max: number, windowMs: number): boolean {
    const t = this.d.now();
    const l = (this.smallRates.get(key) ?? []).filter((x) => t - x < windowMs);
    if (l.length >= max) { this.smallRates.set(key, l); return false; }
    l.push(t); this.smallRates.set(key, l);
    return true;
  }
  private relying(): Relying | null {
    const enr = this.d.store.enrollment();
    return relyingPartyOf(enr?.relayUrl || this.cfg().relayUrl);
  }
  private deviceName(dev: DeviceRecord): string { return safeDeviceName(dev.name); }

  forgetDevice(id: string): void {
    this.challenges.delete(id); this.regChallenges.delete(id); this.unlocks.delete(id);
    for (const k of [...this.grants.keys()]) if (k.startsWith(`${id}:`)) this.grants.delete(k);
    this.watchers.delete(id);
  }

  stop(): void {
    if (this.pump) clearTimeout(this.pump);
    this.pump = null;
    this.watchers.clear();
  }

  // ------------------------------------------------------------------ what a device is told (state fields)
  hostCtl(dev: DeviceRecord): HostCtl {
    const cfg = this.cfg(); const scope = dev.scope ?? 'answer';
    return {
      mode: cfg.control.mode, scope, stepup: dev.cred ? 'webauthn' : 'local', confirm: dev.confirmEvery === true, unlockMinutes: cfg.control.unlockMinutes,
      launch: scope === 'control' ? cfg.control.launch.map((l) => ({ id: l.id, label: l.label, harness: l.harness, modes: l.modes })) : [],
    };
  }

  /** the adapter's manifest capabilities, narrowed by what this session can take right now (an adapter may only narrow, never widen) */
  private capsOf(ad: ControlAdapter | undefined, s: Sess): ControlCaps | undefined {
    if (!ad) return undefined;
    const base = ad.manifest.control;
    let per: ReturnType<NonNullable<ControlAdapter['sessionCaps']>> = null;
    try { per = ad.sessionCaps?.(s.key) ?? null; } catch { per = null; }
    if (!per) return base;
    return { ...base, prompt: base.prompt && per.prompt !== false, interrupt: base.interrupt && per.interrupt !== false, answer: base.answer && per.answer !== false, tail: base.tail && per.tail !== false };
  }

  private whyNot(dev: DeviceRecord, s: Sess): CtlWhy | null {
    const cfg = this.cfg();
    if (cfg.paused) return 'paused';
    if (cfg.control.mode !== 'on') return 'control_off';
    if (!scopeAtLeast(dev.scope, 'control')) return 'scope';
    if (s.status === 'ended') return 'ended';
    if (cfg.control.harnesses.length && !cfg.control.harnesses.includes(s.agent)) return 'harness';
    if (!projectAllowed(cfg.control.projects, s.cwd)) return 'project';
    if (s.mode === 'bypass' && !cfg.control.allowBypass) return 'bypass';
    if (!this.capsOf(this.d.hub.controlOf(s.owner), s)?.prompt) return 'unsupported';
    return null;
  }

  sessionCtl(dev: DeviceRecord, s: Sess): SessionCtl {
    const cfg = this.cfg();
    const ad = this.d.hub.controlOf(s.owner);
    const caps = this.capsOf(ad, s);
    const why = this.whyNot(dev, s);
    const p = s.pending;
    return {
      bind: sessionBind(s), route: caps?.route ?? 'none',
      can: {
        prompt: why === null,
        interrupt: !!caps?.interrupt && !cfg.paused && scopeAtLeast(dev.scope, 'answer') && s.status !== 'ended',
        tail: !!caps?.tail && cfg.control.mode !== 'off' && !cfg.paused,
        text: why === null && !!caps?.answer && !!p && p.pub.kind === 'question' && !!p.route && p.route.adapter === s.owner,
      },
      ...(why ? { why } : {}), tools: s.toolOutput,
    };
  }

  // ------------------------------------------------------------------ entry
  /** every protocol 3 kind from a device lands here */
  async onFrame(dev: DeviceRecord, kind: string, data: unknown): Promise<void> {
    if ((dev.proto ?? 1) < 3) { this.d.store.audit('control_rejected', { device: dev.id.slice(0, 8), why: 'proto', c: kind.slice(0, 16) }); return; }
    switch (kind) {
      case 'prompt': case 'interrupt': case 'start': case 'answer': return this.onCommand(dev, kind, data);
      case 'watch': return this.onWatch(dev, data);
      case 'history': return this.onHistory(dev, data);
      case 'su_begin': return this.onSuBegin(dev, data);
      case 'su_assert': return this.onSuAssert(dev, data);
      case 'su_regbegin': return this.onSuRegBegin(dev, data);
      case 'su_reg': return this.onSuReg(dev, data);
      default: this.d.store.audit('control_rejected', { device: dev.id.slice(0, 8), why: 'unknown_kind' });
    }
  }

  // ------------------------------------------------------------------ commands
  private audit(dev: DeviceRecord, kind: CommandKind, r: Reply, text?: string): void {
    this.d.store.audit('control', { device: dev.id.slice(0, 8), c: kind, outcome: r.outcome, why: r.why ?? null, ...(text !== undefined ? { len: charLength(text), sha: sha16(text) } : {}) });
    if (this.cfg().control.fullLog) this.d.store.auditFull({ device: dev.id.slice(0, 8), c: kind, outcome: r.outcome, why: r.why ?? null, ...(text !== undefined ? { text } : {}) });
  }

  private async onCommand(dev: DeviceRecord, kind: CommandKind, raw: unknown): Promise<void> {
    const schema = { prompt: PromptData, interrupt: InterruptData, start: StartData, answer: AnswerData }[kind];
    const parsed = schema.safeParse(raw);
    const loose = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const cidOk = Cid.safeParse(loose.cid);
    const reply = async (r: Reply, o: { text?: string; remember?: string } = {}): Promise<void> => {
      if (!cidOk.success) return;
      this.audit(dev, kind, r, o.text);
      if (o.remember) this.remember(o.remember, { kind, ...r });
      await this.d.send(dev, 'cresult', { cid: cidOk.data, kind, ...r }, 5 * 60_000).catch(() => undefined);
    };
    if (!parsed.success) {
      this.d.store.audit('control_rejected', { device: dev.id.slice(0, 8), why: 'schema', c: kind });
      const tooBig = typeof loose.text === 'string' && loose.text.length > 16_000;
      return reply(refuse(tooBig ? 'size' : 'schema'));
    }
    const d = parsed.data as PromptData & InterruptData & StartData & AnswerData;
    const t = this.d.now();
    const key = `${dev.id.slice(0, 16)}:${d.cid}`;

    // 3. a command id seen before gets the stored answer again; nothing is done twice
    const prior = this.d.store.state().cids[key];
    if (prior && t - prior.t < CID_DEDUPE_MS) {
      try { const o = JSON.parse(prior.o) as Reply; this.audit(dev, kind, { ...o, why: o.why }); await this.d.send(dev, 'cresult', { cid: d.cid, kind, ...o, dup: true }, 5 * 60_000).catch(() => undefined); } catch { /* unreadable: ignore */ }
      return;
    }
    if (this.inflight.has(key)) return reply({ outcome: 'refused', why: 'busy', note: 'this command is already being handled', dup: true });
    this.inflight.add(key);
    try { await this.pipeline(dev, kind, d, key, t, reply); } catch (e) {
      // a bug must not leave the device waiting: say that it failed (nothing was delivered unless the adapter call itself had returned)
      this.d.store.audit('control_error', { device: dev.id.slice(0, 8), c: kind, err: String((e as Error)?.message ?? e).slice(0, 80) });
      await reply({ outcome: 'failed', note: 'internal error on the computer' });
    } finally { this.inflight.delete(key); }
  }

  private remember(key: string, r: Record<string, unknown>): void {
    const st = this.d.store.state(); const t = this.d.now();
    const { kind: _k, ...rest } = r;
    st.cids[key] = { t, o: JSON.stringify(rest) };
    for (const [k, v] of Object.entries(st.cids)) if (t - v.t >= CID_DEDUPE_MS) delete st.cids[k];
    const keys = Object.keys(st.cids);
    if (keys.length > MAX_CIDS) for (const k of keys.sort((a, b) => st.cids[a]!.t - st.cids[b]!.t).slice(0, keys.length - MAX_CIDS)) delete st.cids[k];
    this.d.store.saveState(st);
  }

  private async pipeline(dev: DeviceRecord, kind: CommandKind, d: PromptData & InterruptData & StartData & AnswerData, key: string, t: number, reply: (r: Reply, o?: { text?: string; remember?: string }) => Promise<void>): Promise<void> {
    const cfg = this.cfg();
    // 4 to 6: the local pause, the master switch (interrupt, like deny, still works when control is off), scope
    if (cfg.paused) return reply(refuse('paused'));
    if (kind !== 'interrupt' && cfg.control.mode !== 'on') return reply(refuse('control_off', cfg.control.mode === 'readonly' ? 'read-only on the computer' : undefined));
    if (!scopeAtLeast(dev.scope, kind === 'interrupt' ? 'answer' : 'control')) return reply(refuse('scope'));
    // 7: expiry (the device sets x = now + 60 s)
    if (t > d.x) return reply(refuse('expired'));
    if (d.x - t > COMMAND_TTL_MS + COMMAND_SKEW_MS) return reply(refuse('schema', 'expiry too far ahead'));
    // 8: rate, checked without spending
    const limits = kind === 'interrupt' ? [this.bucket('interrupt', 20, 300)]
      : [this.d.overall(), kind === 'start' ? this.bucket('start', cfg.control.startsPerMinute, cfg.control.startsPerHour) : this.bucket('prompt', cfg.control.promptsPerMinute, cfg.control.promptsPerHour)];
    if (!limits.every((l) => l.wouldAllow(t))) return reply(refuse('rate'));

    // 9: the target
    let s: Sess | undefined; let ad: ControlAdapter | undefined; let launch: Config['control']['launch'][number] | undefined; let routeKind: SessionCtl['route'] = 'none';
    let target = '';
    let pending0: Sess['pending'];
    if (kind === 'start') {
      launch = cfg.control.launch.find((l) => l.id === d.launchId);
      if (!launch) return reply(refuse('launch_unknown'));
      if (!launch.modes.includes(d.mode)) return reply(refuse('mode_not_allowed'));
      if (cfg.control.harnesses.length && !cfg.control.harnesses.includes(launch.harness)) return reply(refuse('harness'));
      if (!projectAllowed(cfg.control.projects, launch.root)) return reply(refuse('project'));
      ad = this.d.hub.starterFor(launch.harness);
      if (!ad) return reply(refuse('unsupported'));
      routeKind = ad.manifest.control.route;
      target = `${d.launchId}:${d.mode}`;
    } else {
      s = this.d.sessions.bySid(d.sid);
      if (!s) return reply(refuse('unknown_session'));
      if (s.status === 'ended') return reply(refuse('ended'));
      ad = this.d.hub.controlOf(s.owner);
      const caps = this.capsOf(ad, s);
      if (kind !== 'interrupt') {
        if (cfg.control.harnesses.length && !cfg.control.harnesses.includes(s.agent)) return reply(refuse('harness'));
        if (!projectAllowed(cfg.control.projects, s.cwd)) return reply(refuse('project'));
        if (s.mode === 'bypass' && !cfg.control.allowBypass) return reply(refuse('bypass'));
      }
      if (!ad || !caps || (kind === 'prompt' && !caps.prompt) || (kind === 'interrupt' && !caps.interrupt) || (kind === 'answer' && !caps.answer)) return reply(refuse('unsupported'));
      routeKind = caps.route;
      target = s.sid;
      if (kind === 'answer') {
        const p = s.pending;
        pending0 = p;
        if (!p || p.pub.kind !== 'question') return reply(refuse('no_question'));
        if (p.pub.rid !== d.rid || p.pub.bind !== d.bind) return reply(refuse('stale'));
        if (!p.route || p.route.adapter !== s.owner) return reply(refuse('unsupported'));
      }
      // 10: bound to what the person saw (a stale interrupt is still allowed: stopping is always safe)
      if (kind === 'prompt' && d.bind !== sessionBind(s)) return reply(refuse('stale'));
    }

    // 11: the text
    let text = '';
    const rawText = kind === 'interrupt' ? undefined : d.text;
    if (rawText !== undefined || kind === 'prompt' || kind === 'answer') {
      const c = checkControlText(rawText ?? '', routeKind);
      if (!c.ok) return reply(refuse(c.why));
      text = c.text;
    }

    // 12 and 13: step-up, or the owner at the computer
    let grantKey: string | null = null;
    if (kind !== 'interrupt') {
      const digest = await commandDigest(kind, target, rawText ?? '');
      if (dev.cred) {
        const g = this.grants.get(`${dev.id}:${d.cid}`);
        if (g && g.exp > t) {
          if (g.digest !== digest || g.kind !== kind) return reply(refuse('stepup_invalid'));
          grantKey = `${dev.id}:${d.cid}`;
        } else if (kind !== 'start' && (this.unlocks.get(dev.id) ?? 0) > t) { /* inside the unlock window */ } else return reply({ outcome: 'needs_stepup' });
      }
      const local = !dev.cred || dev.confirmEvery === true;
      if (local) {
        await reply({ outcome: 'needs_local' });
        const label = launch ? launch.label : s!.label;
        const preview = kind === 'start' ? `mode: ${d.mode}\n${text || '(no first prompt)'}` : text;
        const ok = await this.d.confirm({ kind, agent: launch ? launch.harness : s!.agent, label, preview, device: dev.name });
        if (!ok) return reply(refuse('local_declined'), { text, remember: key });
      }
    }

    // 14: nothing may have moved while the owner read it or the step-up ran, so everything that could is checked again, synchronously, right before the buckets
    // are spent and the adapter is called (there is no await between this check and the call)
    const moved = ((): Refusal | null => {
      const c = this.cfg();
      if (c.paused) return 'paused';
      if (kind !== 'interrupt' && c.control.mode !== 'on') return 'control_off';
      if (s) {
        const s2 = this.d.sessions.bySid(s.sid);
        if (!s2 || s2.status === 'ended') return 'ended';
        if (kind !== 'interrupt' && s2.mode === 'bypass' && !c.control.allowBypass) return 'bypass';
        if (kind === 'prompt' && d.bind !== sessionBind(s2)) return 'stale';
        if (kind === 'answer' && (s2.pending !== pending0 || s2.pending?.pub.rid !== d.rid || s2.pending?.pub.bind !== d.bind)) return 'stale';
      }
      return null;
    })();
    if (moved) return reply(refuse(moved));
    if (!spendAll(limits, this.d.now())) return reply(refuse('rate'));
    if (grantKey) this.grants.delete(grantKey);
    const who = { device: this.deviceName(dev) };
    const framed = (txt: string): ControlPrompt => ({ text: asControlText(txt), framed: asControlText(`[Botwarren Companion: message from the owner's paired device "${who.device}"]\n\n${txt}`), from: who.device });
    const a = ad!;
    let result: ControlDelivery; let startedKey: string | undefined;
    let follow: { done: Promise<boolean>; cancel: () => void } | null = null;
    if (kind !== 'start') follow = this.expectFollowup(s!.sid, kind, this.d.followupWaitMs);
    try {
      if (kind === 'prompt') result = await a.sendPrompt(s!.key, framed(text), who);
      else if (kind === 'interrupt') result = await a.interrupt(s!.key, who);
      else if (kind === 'answer') result = await a.answerText(s!.pending!.route!.native, asControlText(text), who);
      else { const r = await a.startSession({ id: launch!.id, label: launch!.label, harness: launch!.harness, root: launch!.root, mode: d.mode }, text ? framed(text) : null, who); result = r.result; startedKey = r.sessionKey; }
    } catch { result = 'failed'; }
    if (result !== 'delivered') {
      follow?.cancel();
      const r: Reply = result === 'busy' ? refuse('busy') : result === 'unsupported' ? refuse('unsupported') : result === 'gone' ? refuse('unknown_session') : { outcome: 'failed', note: 'the agent could not take it' };
      return reply(r, { text, ...(r.outcome === 'failed' ? { remember: key } : {}) });
    }
    if (s) this.noteSent(s, kind, dev, text);
    let applied = false; let newSid: string | undefined;
    if (kind === 'start') {
      if (startedKey) {
        const until = this.d.now() + this.d.followupWaitMs;
        for (;;) { const ns = this.d.sessions.byKeyOrAlias(startedKey); if (ns) { applied = true; newSid = ns.sid; break; } if (this.d.now() >= until) break; await new Promise((r) => setTimeout(r, 25)); }
      }
    } else applied = await follow!.done;
    this.afterCommand();
    return reply({ outcome: applied ? 'applied' : 'sent', ...(newSid ? { sid: newSid } : {}) }, { text, remember: key });
  }

  private afterCommand(): void { this.onChanged?.(); }
  /** the host sets this to schedule a state push */
  onChanged: (() => void) | null = null;

  private noteSent(s: Sess, kind: CommandKind, dev: DeviceRecord, text: string): void {
    const what = kind === 'prompt' ? `prompt sent from "${this.deviceName(dev)}" (${charLength(text)} characters)` : kind === 'answer' ? `answer sent from "${this.deviceName(dev)}"` : `stop requested from "${this.deviceName(dev)}"`;
    s.tail.add('note', what, this.d.now());
    this.scheduleTail(s);
  }

  // ------------------------------------------------------------------ follow-ups (the tool's own proof)
  private expectFollowup(sid: string, what: string, ms: number): { done: Promise<boolean>; cancel: () => void } {
    const k = `${sid}:${what}`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = new Promise<boolean>((ok) => {
      this.waiters.set(k, () => ok(true));
      timer = setTimeout(() => ok(false), ms);
      timer.unref?.();
    }).finally(() => { if (timer) clearTimeout(timer); this.waiters.delete(k); });
    return { done, cancel: () => { if (timer) clearTimeout(timer); this.waiters.delete(k); } };
  }
  noteFollowup(s: Sess, what: 'prompt' | 'interrupt' | 'answer'): void { this.waiters.get(`${s.sid}:${what}`)?.(); }

  // ------------------------------------------------------------------ tail
  /** lines an adapter reported: cleaned, masked, cut, kept in the session's ring (tool output only when the owner turned it on) */
  ingestTail(s: Sess, items: { k: TailKind; text: string; ts: number }[]): void {
    const roots = [{ path: s.cwd, as: '.' }, { path: this.d.env.HOME ?? homedir(), as: '~' }];
    const secrets = this.d.secrets();
    let added = 0;
    for (const it of items.slice(0, 200)) {
      if (it.k === 'tool_out' && !s.toolOutput) continue;
      const c = sanitizeTail(it.k, it.text, { secrets, roots });
      if (!c) continue;
      s.masked += c.masked;
      s.tail.add(it.k, c.text, Number.isFinite(it.ts) ? Math.trunc(it.ts) : this.d.now(), c.cut);
      added++;
    }
    if (added) this.scheduleTail(s);
  }

  /** the owner turns tool output on or off for a session at the computer; off removes what was kept */
  setToolOutput(s: Sess, on: boolean): void {
    if (s.toolOutput === on) return;
    s.toolOutput = on;
    if (!on) s.tail.purge('tool_out');
    this.d.store.audit(on ? 'tool_output_on' : 'tool_output_off');
    this.scheduleTail(s, true);
    this.onChanged?.();
  }

  private canTail(dev: DeviceRecord, s: Sess): boolean {
    const cfg = this.cfg();
    return !cfg.paused && cfg.control.mode !== 'off' && scopeAtLeast(dev.scope, 'observe') && !!this.capsOf(this.d.hub.controlOf(s.owner), s)?.tail;
  }

  private tailBudget(): number { return Math.max(1500, Math.min(24_000, this.d.innerBudget() - 500)); }

  private async onWatch(dev: DeviceRecord, raw: unknown): Promise<void> {
    const w = WatchData.safeParse(raw);
    const bad = (why: string): void => this.d.store.audit('watch_refused', { device: dev.id.slice(0, 8), why });
    if (!w.success) return bad('schema');
    if (!this.rate(`watch:${dev.id}`, 30, 60_000)) return bad('rate');
    const m = this.watchers.get(dev.id) ?? new Map<string, Watch>();
    this.watchers.set(dev.id, m);
    if (!w.data.on) { m.delete(w.data.sid); return; }
    const s = this.d.sessions.bySid(w.data.sid);
    if (!s) return bad('unknown_session');
    if (!this.canTail(dev, s)) return bad('not_allowed');
    const t = this.d.now();
    const existing = m.get(s.sid);
    if (existing) { existing.lease = t + WATCH_LEASE_MS; return; } // a renewal
    while (m.size >= MAX_WATCHED_SESSIONS) { const oldest = m.keys().next().value as string; m.delete(oldest); }
    m.set(s.sid, { lease: t + WATCH_LEASE_MS, lastSeq: -1, lastAt: 0, force: true });
    this.armPump(0);
  }

  private scheduleTail(s: Sess, force = false): void {
    if (force) for (const m of this.watchers.values()) { const w = m.get(s.sid); if (w) w.force = true; }
    this.armPump(0);
  }

  private gap(): number { return this.d.tailGapMs ?? TAIL_MIN_GAP_MS; }

  /** one timer serves every watcher (see `pumpTail`): wake after `wait` ms unless an earlier wake is already set */
  private armPump(wait: number): void {
    const due = this.d.now() + wait;
    if (this.pump) { if (this.pumpDue <= due) return; clearTimeout(this.pump); }
    this.pumpDue = due;
    this.pump = setTimeout(() => { this.pump = null; void this.pumpTail(); }, wait);
    this.pump.unref?.();
  }

  /**
   * The relay lets one connection send 2 frames a second (burst 20), and states, results and tails share it, so tail frames share a host-wide bucket: one a
   * second on average (burst 3) across every watching device and session. Each wake sends to the watcher that has waited longest (so no session starves
   * another) while a token and the per-session gap allow; what is sent is always the newest window, so waiting loses nothing.
   */
  private async pumpTail(): Promise<void> {
    const gap = this.gap();
    for (;;) {
      const t = this.d.now();
      const due: { dev: DeviceRecord; s: Sess; w: Watch; at: number }[] = [];
      let nextWake = Infinity;
      for (const dev of this.d.devices()) {
        const m = this.watchers.get(dev.id);
        if (!m) continue;
        for (const [sid, w] of m) {
          const s = this.d.sessions.bySid(sid);
          if (!s || w.lease <= t) { m.delete(sid); continue; }
          if (!w.force && w.lastSeq >= s.tail.last) continue;
          const ready = w.lastAt + gap;
          if (ready > t) { nextWake = Math.min(nextWake, ready - t); continue; }
          due.push({ dev, s, w, at: w.lastAt });
        }
      }
      if (due.length === 0) { if (nextWake !== Infinity) this.armPump(nextWake); return; }
      this.refillTail();
      if (this.tailTokens < 1) { this.armPump(Math.max(1, Math.ceil((1 - this.tailTokens) * gap))); return; }
      this.tailTokens -= 1;
      due.sort((x, y) => x.at - y.at);
      const pick = due[0]!;
      pick.w.force = false; pick.w.lastSeq = pick.s.tail.last; pick.w.lastAt = t;
      const entries = pick.s.tail.window(this.tailBudget());
      const data: TailData = { sid: pick.s.sid, first: entries[0]?.seq ?? 0, last: pick.s.tail.last, total: pick.s.tail.size, entries, tools: pick.s.toolOutput };
      await this.d.send(pick.dev, 'tail', data, 60_000, watchReplaceKey(pick.s.sid)).catch(() => undefined);
    }
  }

  private refillTail(): void {
    const t = this.d.now();
    this.tailTokens = Math.min(3, this.tailTokens + (t - this.tailTokensAt) / this.gap());
    this.tailTokensAt = t;
  }

  private async onHistory(dev: DeviceRecord, raw: unknown): Promise<void> {
    const h = HistoryData.safeParse(raw);
    const bad = (why: string): void => this.d.store.audit('history_refused', { device: dev.id.slice(0, 8), why });
    if (!h.success) return bad('schema');
    if (!this.rate(`hist:${dev.id}`, 30, 60_000)) return bad('rate');
    const s = this.d.sessions.bySid(h.data.sid);
    if (!s) return bad('unknown_session');
    if (!this.canTail(dev, s)) return bad('not_allowed');
    const p = s.tail.page(h.data.before, Math.min(h.data.limit ?? HISTORY_MAX_LIMIT, HISTORY_MAX_LIMIT), this.tailBudget());
    const data: HistData = { sid: s.sid, q: h.data.q, entries: p.entries, more: p.more, tools: s.toolOutput };
    await this.d.send(dev, 'hist', data, 2 * 60_000).catch(() => undefined);
  }

  // ------------------------------------------------------------------ step-up
  private async suFail(dev: DeviceRecord, forWhat: 'unlock' | 'cmd', why: SuResultData['why'], cid?: string): Promise<void> {
    this.d.store.audit('stepup', { device: dev.id.slice(0, 8), ok: false, why: why ?? null, for: forWhat });
    await this.d.send(dev, 'su_result', { for: forWhat, ...(cid ? { cid } : {}), ok: false, ...(why ? { why } : {}) } satisfies SuResultData, 2 * 60_000).catch(() => undefined);
  }

  private async onSuBegin(dev: DeviceRecord, raw: unknown): Promise<void> {
    const b = SuBeginData.safeParse(raw);
    if (!b.success) return this.suFail(dev, 'unlock', 'malformed');
    const forWhat = b.data.for; const t = this.d.now();
    if (!this.rate(`su:${dev.id}`, 20, 60_000)) return this.suFail(dev, forWhat, 'rate', b.data.cid);
    if (this.cfg().control.mode !== 'on') return this.suFail(dev, forWhat, 'control_off', b.data.cid);
    if (!scopeAtLeast(dev.scope, 'control')) return this.suFail(dev, forWhat, 'scope', b.data.cid);
    const rp = this.relying();
    if (!dev.cred || !rp) return this.suFail(dev, forWhat, 'no_credential', b.data.cid);
    const nonce = randomBytes(32);
    const ch = b64u(await stepupChallenge(forWhat, nonce, b.data.digest ?? ''));
    this.challenges.set(dev.id, { ch, for: forWhat, ...(b.data.cid ? { cid: b.data.cid } : {}), ...(b.data.kind ? { kind: b.data.kind } : {}), ...(b.data.digest ? { digest: b.data.digest } : {}), exp: t + STEPUP_CHALLENGE_TTL_MS });
    await this.d.send(dev, 'su_challenge', { ch, for: forWhat, ...(b.data.cid ? { cid: b.data.cid } : {}), exp: t + STEPUP_CHALLENGE_TTL_MS, rp: rp.rpId, origin: rp.origins[0]!, cred: dev.cred.id } satisfies SuChallengeData, 2 * 60_000).catch(() => undefined);
  }

  private async onSuAssert(dev: DeviceRecord, raw: unknown): Promise<void> {
    const a = SuAssertData.safeParse(raw);
    const c = this.challenges.get(dev.id);
    this.challenges.delete(dev.id); // single use, whatever happens next
    if (!a.success) return this.suFail(dev, c?.for ?? 'unlock', 'malformed', c?.cid);
    if (!c) return this.suFail(dev, 'unlock', 'no_challenge');
    const t = this.d.now();
    if (t > c.exp) return this.suFail(dev, c.for, 'expired', c.cid);
    if (a.data.ch !== c.ch) return this.suFail(dev, c.for, 'challenge', c.cid);
    const rp = this.relying();
    if (!dev.cred || !rp) return this.suFail(dev, c.for, 'no_credential', c.cid);
    const v = verifyAssertion({ expectedChallenge: c.ch, rp, cred: dev.cred, response: { id: a.data.id, ad: a.data.ad, cd: a.data.cd, sig: a.data.sig } });
    if (!v.ok) return this.suFail(dev, c.for, v.why, c.cid);
    dev.cred = { ...dev.cred, signCount: v.signCount };
    this.d.saveDevices();
    let until: number | undefined;
    if (c.for === 'unlock') { until = t + this.cfg().control.unlockMinutes * 60_000; this.unlocks.set(dev.id, until); }
    else if (c.cid && c.digest && c.kind) this.grants.set(`${dev.id}:${c.cid}`, { digest: c.digest, kind: c.kind, exp: t + STEPUP_GRANT_TTL_MS });
    this.d.store.audit('stepup', { device: dev.id.slice(0, 8), ok: true, for: c.for });
    await this.d.send(dev, 'su_result', { for: c.for, ...(c.cid ? { cid: c.cid } : {}), ok: true, ...(until ? { until } : {}) } satisfies SuResultData, 2 * 60_000).catch(() => undefined);
  }

  private async regFail(dev: DeviceRecord, why: SuRegResultData['why']): Promise<void> {
    this.d.store.audit('stepup_register', { device: dev.id.slice(0, 8), ok: false, why: why ?? null });
    await this.d.send(dev, 'su_regresult', { ok: false, ...(why ? { why } : {}) } satisfies SuRegResultData, 2 * 60_000).catch(() => undefined);
  }

  private async onSuRegBegin(dev: DeviceRecord, raw: unknown): Promise<void> {
    if (!SuRegBeginData.safeParse(raw).success) return this.regFail(dev, 'malformed');
    if (!this.rate(`sureg:${dev.id}`, 6, 3_600_000)) return this.regFail(dev, 'rate');
    const rp = this.relying();
    if (!rp) return this.regFail(dev, 'malformed');
    if (this.regBusy.has(dev.id)) return;
    this.regBusy.add(dev.id);
    try {
      // the owner at the computer says yes: a credential is only ever added with a local confirmation
      const ok = await this.d.confirm({ kind: 'stepup_add', agent: '', label: '', preview: '', device: dev.name });
      if (!ok) return await this.regFail(dev, 'declined');
      const nonce = randomBytes(32); const t = this.d.now();
      const ch = b64u(await stepupChallenge('reg', nonce));
      this.regChallenges.set(dev.id, { ch, exp: t + STEPUP_CHALLENGE_TTL_MS });
      await this.d.send(dev, 'su_regchallenge', { ch, exp: t + STEPUP_CHALLENGE_TTL_MS, rp: rp.rpId, origin: rp.origins[0]!, user: dev.id.slice(0, 43), algs: [...COSE_ALGS] } satisfies SuRegChallengeData, 2 * 60_000).catch(() => undefined);
    } finally { this.regBusy.delete(dev.id); }
  }

  private async onSuReg(dev: DeviceRecord, raw: unknown): Promise<void> {
    const r = SuRegData.safeParse(raw);
    const c = this.regChallenges.get(dev.id);
    this.regChallenges.delete(dev.id);
    if (!r.success) return this.regFail(dev, 'malformed');
    if (!c) return this.regFail(dev, 'no_challenge');
    if (this.d.now() > c.exp) return this.regFail(dev, 'expired');
    if (r.data.ch !== c.ch) return this.regFail(dev, 'challenge');
    const rp = this.relying();
    if (!rp) return this.regFail(dev, 'malformed');
    const v = verifyRegistration({ expectedChallenge: c.ch, rp, id: r.data.id, ao: r.data.ao, cd: r.data.cd });
    if (!v.ok) return this.regFail(dev, v.why);
    dev.cred = { ...v.cred, addedAt: this.d.now() };
    this.d.saveDevices();
    this.unlocks.delete(dev.id);
    this.d.store.audit('stepup_register', { device: dev.id.slice(0, 8), ok: true, alg: v.cred.alg });
    await this.d.send(dev, 'su_regresult', { ok: true } satisfies SuRegResultData, 2 * 60_000).catch(() => undefined);
    this.onChanged?.();
  }

  // ------------------------------------------------------------------ housekeeping
  housekeeping(): void {
    const t = this.d.now();
    for (const [k, c] of this.challenges) if (c.exp < t) this.challenges.delete(k);
    for (const [k, c] of this.regChallenges) if (c.exp < t) this.regChallenges.delete(k);
    for (const [k, g] of this.grants) if (g.exp < t) this.grants.delete(k);
    for (const [k, u] of this.unlocks) if (u < t) this.unlocks.delete(k);
    for (const [devId, m] of this.watchers) {
      for (const [sid, w] of m) if (w.lease <= t || !this.d.sessions.bySid(sid)) m.delete(sid);
      if (m.size === 0) this.watchers.delete(devId);
    }
    if (t - this.lastFullPrune > 6 * 3_600_000) { this.lastFullPrune = t; this.d.store.pruneFullLog(t); }
  }
}

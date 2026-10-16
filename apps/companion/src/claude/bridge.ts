/**
 * Claude Code adapter: turns hook events and channel events into session state, and carries answers back (the first implementation of the adapter
 * interface in src/adapters/types.ts; the behaviour is that of companion 0.1.x).
 * Integration points and their confidence: docs/CLIENT_SECURITY.md part 2. Licence: Apache-2.0.
 */
import { basename } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { CompanionHost } from '../host.ts';
import { readRecentAssistant, safeTranscript, type Sess } from '../sessions.ts';
import { clip } from '../mask.ts';
import type { Option } from '../protocol/index.ts';
import { safeDeviceName, type Adapter, type AdapterContext, type AdapterManifest, type Answer, type ControlAdapter, type ControlCaps, type ControlDelivery, type ControlPrompt, type ControlText, type DeliverResult, type DetectResult, type DoctorLine, type HookAdapter, type HookCall, type LaunchSpec, type NativeRef, type Revalidation } from '../adapters/types.ts';
import { readNew, type Cursor } from './transcript.ts';

export type { HookCall };
export type ChannelSender = (ev: Record<string, unknown>) => boolean;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** a short readable description of a tool call, from the fields the tools are known to have; unknown tools fall back to compact JSON */
export function describeTool(tool: string, input: Record<string, unknown>): { summary: string; preview: string } {
  const compact = (): string => { try { return JSON.stringify(input); } catch { return ''; } };
  switch (tool) {
    case 'Bash': return { summary: clip(str(input.description) || 'Run a command', 200), preview: str(input.command) };
    case 'Write': return { summary: 'Write a file', preview: str(input.file_path) };
    case 'Edit': case 'MultiEdit': return { summary: 'Edit a file', preview: str(input.file_path) };
    case 'WebFetch': return { summary: 'Fetch a web page', preview: str(input.url) };
    case 'WebSearch': return { summary: 'Search the web', preview: str(input.query) };
    default: return { summary: `Use the ${tool} tool`, preview: compact() };
  }
}

function questionOptions(input: Record<string, unknown>): { question: string; options: Option[]; text: Record<string, string> } | null {
  const qs = Array.isArray(input.questions) ? input.questions : [];
  const q = obj(qs[0]);
  const opts = Array.isArray(q.options) ? q.options : [];
  if (!str(q.question) || opts.length === 0) return null;
  const options: Option[] = []; const text: Record<string, string> = {};
  opts.slice(0, 8).forEach((o, i) => {
    const label = clip(str(obj(o).label), 80);
    if (!label) return;
    const id = `o${i + 1}`;
    options.push({ id, label }); text[id] = `Option ${i + 1}: ${label}`;
  });
  return options.length ? { question: str(q.question), options, text } : null;
}

export const CLAUDE_ADAPTER_ID = 'claude-code';

export const CLAUDE_MANIFEST: AdapterManifest = {
  id: CLAUDE_ADAPTER_ID, kind: 'claude-code', safety: 'A',
  caps: { detect: true, readPending: true, readRecent: true, approve: true, deny: true, presetReply: true, optionAnswer: true },
  reads: [
    'the hook events Claude Code sends to this companion (tool name and input of a permission request, notifications, stop)',
    'the permission relay of the MCP channel you registered (the request Claude Code shows in its own dialog)',
    'the last assistant messages of the session transcript (only under Claude Code\'s own projects folder)',
    'remote control (protocol 3, only for a device you gave the control scope): the transcript\'s assistant text, one-line tool-call summaries and your prompts for the live tail (tool output only when you turn it on for that session); with the opt-in control hook also the name and input of each tool call and AskUserQuestion questions',
  ],
  // not version-gated: the hook and channel contracts are documented by Claude Code (an empty list means "no gate")
  verified: { versions: [] },
  confirmFloor: { approve: 'off', reply: 'off' },
  // the channel answers synchronously (delivery is the outcome); the held hook's allow is reported as delivered too, as in 0.1.x
  observesOutcome: false,
  // protocol 3 (WP9, lab-verified on Claude Code 2.1.300; docs/PROTOCOL3.md section 9). Free text reaches the session through the MCP channel (a session
  // that has the channel connected; per session, see `sessionCaps`). Interrupt is SOFT: a flag the opt-in PreToolUse control hook consumes, so the agent stops
  // at its next tool call and cannot be cut mid-generation. `answer`: free text for a held AskUserQuestion (opt-in control hook plus hold time). No `start`.
  control: { prompt: true, interrupt: true, softInterrupt: true, answer: true, start: false, tail: true, route: 'channel' },
};

interface Held { resolve: (v: { behavior: 'allow' | 'deny'; message?: string } | null) => void }
/** an AskUserQuestion whose PreToolUse hook is held while a paired device answers */
interface HeldQuestion { sess: Sess; question: string; labels: Record<string, string>; input: Record<string, unknown>; resolve: (answer: { text: string; device: string } | null) => void }
const IDLE_PREFIX = 'idle-';

/** a stop request is good for this long (it is consumed at the next tool call; a turn that ends first withdraws it) */
export const STOP_TTL_MS = 5 * 60_000;
/** after a stop was issued, further tool calls of the same turn (parallel calls, or an agent that did not stop) are refused for this long */
const STOP_LATCH_MS = 20_000;
/** how long a prompt we delivered stays "unconfirmed" (the transcript or a hook must show it began a turn) */
const SENT_TTL_MS = 5 * 60_000;
const POLL_MS = 2000;

/** per-session control state (in memory only; a restart forgets it, which is safe: a stop flag that is lost simply never fires) */
interface Ctl {
  /** a PreToolUse hook call was seen for this session: the opt-in control hook is installed and running, so a stop can be consumed */
  preToolSeen: boolean;
  stop: { device: string; at: number } | null;
  latchUntil: number;
  latchDevice: string;
  /** prompts delivered through the channel, not yet seen in the transcript */
  sent: { nonce: string; at: number }[];
  cursor: Cursor | null;
  /** an AskUserQuestion was answered by hook: the tool's own PostToolUse proves it was taken */
  answered: boolean;
}

export interface BridgeOptions {
  /** tests: replaces the "may a hook be held" check (hold time configured, a paired device, relay online, not paused) */
  canHold?: () => boolean;
}

/** how a message of ours reaches the agent (and the hook input of the turn it starts) */
const OUR_CHANNEL_TAG = /<channel\s+source="botwarren-companion"/;
const nonceOf = (): string => randomBytes(4).toString('hex');
/** the channel wraps text in `<channel ...>` tags: text that looks like a tag must not be able to close or forge one */
const defang = (t: string): string => t.replace(/<(\/?)channel/gi, '\u2039$1channel');

export class ClaudeBridge implements ControlAdapter, HookAdapter {
  readonly manifest = CLAUDE_MANIFEST;
  private readonly host: CompanionHost;
  private readonly opts: BridgeOptions;
  private ctx: AdapterContext | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  /** held PermissionRequest hooks by their native id */
  private readonly held = new Map<string, Held>();
  /** held AskUserQuestion PreToolUse hooks by their native id */
  private readonly questions = new Map<string, HeldQuestion>();
  private readonly ctl = new WeakMap<Sess, Ctl>();
  constructor(host: CompanionHost, opts: BridgeOptions = {}) { this.host = host; this.opts = opts; }

  private stateOf(s: Sess): Ctl {
    let c = this.ctl.get(s);
    if (!c) { c = { preToolSeen: false, stop: null, latchUntil: 0, latchDevice: '', sent: [], cursor: null, answered: false }; this.ctl.set(s, c); }
    return c;
  }
  private now(): number { return this.host.nowMs(); }

  // ------------------------------------------------------------------ adapter interface
  async detect(): Promise<DetectResult> { return { present: true, note: 'known from its hooks and channel' }; }
  async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
    // the transcript is read as the turn goes on (hook events also trigger a read); one light timer covers every working session
    if (!this.poll) { this.poll = setInterval(() => { for (const s of [...this.host.sessions.sessions.values()]) { const c = this.ctl.get(s); if (s.transcript && (s.status === 'working' || (c && c.sent.length))) this.pumpTranscript(s); } }, POLL_MS); this.poll.unref?.(); }
  }
  async stop(): Promise<void> {
    if (this.poll) { clearInterval(this.poll); this.poll = null; }
    for (const h of this.held.values()) h.resolve(null); this.held.clear();
    for (const q of this.questions.values()) q.resolve(null); this.questions.clear();
  }
  async doctor(): Promise<DoctorLine[]> {
    const seen = [...this.host.sessions.sessions.values()].filter((s) => this.ctl.get(s)?.preToolSeen).length;
    return [
      { label: 'claude-code', value: 'hooks and channel (see "claude doctor")', ok: null },
      { label: 'claude-code control', value: `${seen} session(s) with the control hook running (opt-in: "claude install-hooks --control"); free text needs the channel connected`, ok: null },
    ];
  }

  async revalidate(n: NativeRef): Promise<Revalidation> {
    const s = this.host.sessions.byNative(n);
    if (!s) return 'gone';
    if (n.kind === 'invocation') return this.held.has(n.id) || this.questions.has(n.id) ? 'live' : 'gone';
    return s.channel ? 'live' : 'gone';
  }

  release(n: NativeRef): void {
    const h = this.held.get(n.id);
    if (h) { this.held.delete(n.id); h.resolve(null); }
    const q = this.questions.get(n.id);
    if (q) { this.questions.delete(n.id); q.resolve(null); }
  }

  async deliver(n: NativeRef, a: Answer, who: { device: string }): Promise<DeliverResult> {
    const s = this.host.sessions.byNative(n);
    if (n.kind === 'invocation') {
      const q = this.questions.get(n.id);
      if (q) {
        // an option of the held AskUserQuestion: the answer is that option's own label (a preset or anything else is not an answer to it)
        if (a.t !== 'option') return 'unsupported';
        const label = q.labels[a.optionId];
        if (!label) return 'unsupported';
        this.questions.delete(n.id);
        q.resolve({ text: label, device: who.device });
        return 'delivered';
      }
      const h = this.held.get(n.id);
      if (!h) return 'gone';
      if (a.t !== 'permission') return 'unsupported';
      this.held.delete(n.id);
      h.resolve({ behavior: a.behavior, ...(a.behavior === 'deny' ? { message: `Denied from "${safeDeviceName(who.device)}" via Botwarren Companion` } : {}) });
      return 'delivered';
    }
    if (!s?.channel) return 'gone';
    if (n.id.startsWith(IDLE_PREFIX)) {
      if (a.t === 'permission') return 'unsupported';
      const safeName = safeDeviceName(who.device);
      const meta = { via: 'botwarren_companion', device: safeName.replace(/ /g, '_'), ...(a.t === 'preset' ? { preset: a.presetId.replace(/[^A-Za-z0-9_]/g, '_') } : { choice: 'agent_option' }) };
      return s.channel.send({ ev: 'message', content: a.text, meta }) ? 'delivered' : 'failed';
    }
    if (a.t !== 'permission' || a.message) return 'unsupported';
    return s.channel.send({ ev: 'permission', request_id: n.id, behavior: a.behavior }) ? 'delivered' : 'failed';
  }

  /** link a channel-only session to the hook session of the same Claude process, or the other way round */
  private link(s: Sess, ancestors: number[], cwd: string): void {
    if (s.channel) return;
    const t = this.host.sessions;
    const channels = [...t.sessions.values()].filter((o) => o !== s && o.channel && o.key.startsWith('ch:'));
    // 1) the channel server's parent process is one of this hook's ancestors (same Claude process); 2) failing that, a single channel in the same folder
    const byPid = channels.find((o) => o.channelParent !== undefined && ancestors.includes(o.channelParent));
    const sameDir = channels.filter((o) => o.cwd === cwd);
    const other = byPid ?? (sameDir.length === 1 ? sameDir[0] : undefined);
    if (!other) return;
    s.channel = other.channel; other.channel = null;
    if (other.channelParent !== undefined) s.channelParent = other.channelParent;
    if (other.pending) { s.pending = other.pending; delete other.pending; }
    t.sessions.delete(other.sid);
  }

  // ------------------------------------------------------------------ hooks
  async onHook(h: HookCall): Promise<Record<string, unknown> | null> {
    const key = str(h.input.session_id);
    if (!key) return null;
    const cwd = str(h.input.cwd);
    const t = this.host.sessions;
    const s = t.upsert(key, cwd);
    s.owner ??= CLAUDE_ADAPTER_ID;
    this.link(s, h.ancestors, cwd);
    // `--dangerously-skip-permissions` sessions say so: there is nothing to approve (an observer such as Ninox may also have marked it; that is never loosened here)
    const pm = str(h.input.permission_mode);
    if (pm === 'bypassPermissions') s.mode = 'bypass'; else if (pm && s.mode === undefined) s.mode = 'normal';
    const tp = str(h.input.transcript_path);
    if (tp && safeTranscript(tp)) s.transcript = tp;
    switch (h.event) {
      case 'SessionStart': t.setStatus(s, 'idle'); this.endTurn(s); break;
      case 'SessionEnd': t.end(s); this.endTurn(s); break;
      case 'UserPromptSubmit': {
        t.clearPending(s, 'prompt'); t.setStatus(s, 'working');
        // Claude Code hands a queued channel message to the agent at a tool boundary of the CURRENT turn (lab-verified, 2.1.300) and fires this hook for it:
        // that is the owner's earlier message arriving, not a new instruction, so a stop asked for after it must survive. Anything else (typed at the terminal) is a new turn.
        if (!OUR_CHANNEL_TAG.test(str(h.input.prompt))) this.endTurn(s);
        this.confirmFromText(s, str(h.input.prompt)); this.pumpTranscript(s); break;
      }
      case 'PreToolUse': { const out = await this.onPreToolUse(s, h); this.host.schedulePush(); return out; }
      case 'PostToolUse': {
        if (s.pending?.pub.kind === 'permission') { t.clearPending(s, 'tool_ran'); }
        t.setStatus(s, 'working');
        const c = this.ctl.get(s);
        if (c?.answered && str(h.input.tool_name) === 'AskUserQuestion') { c.answered = false; this.ctx?.report.followup(s.key, 'answer'); }
        this.pumpTranscript(s);
        break;
      }
      case 'Stop': await this.onStop(s); this.endTurn(s); this.pumpTranscript(s); break;
      case 'Notification': await this.onNotification(s, h.input); break;
      case 'PermissionRequest': { const out = await this.onPermissionRequest(s, h); this.host.schedulePush(); return out; }
      default: return null;
    }
    this.host.schedulePush();
    return null;
  }

  private ref(kind: NativeRef['kind'], id: string, fingerprint = ''): NativeRef { return { adapter: CLAUDE_ADAPTER_ID, kind, id, fingerprint }; }

  private async onStop(s: Sess): Promise<void> {
    const t = this.host.sessions;
    if (s.transcript) t.setRecent(s, readRecentAssistant(s.transcript));
    t.clearPending(s, 'stop');
    t.setStatus(s, 'idle');
    const last = s.recent.at(-1)?.text ?? '';
    await t.setPending(s, { kind: 'idle', summary: 'Waiting for your next instruction', preview: last, ttlMs: 30 * 60_000, route: s.channel ? this.ref('request_id', `${IDLE_PREFIX}${s.sid}`) : null, can: { approve: false, reply: !!s.channel } });
    t.setStatus(s, 'idle');
  }

  private async onNotification(s: Sess, input: Record<string, unknown>): Promise<void> {
    const type = str(input.notification_type);
    if (s.pending) return;
    if (type === 'permission_prompt' || type === 'elicitation_dialog' || type === 'elicitation_url_dialog') {
      await this.host.sessions.setPending(s, { kind: 'permission', summary: clip(str(input.message) || 'Waiting for your answer', 200), preview: '', ttlMs: 10 * 60_000, route: null, can: { approve: false, reply: false } });
    }
  }

  private async onPermissionRequest(s: Sess, h: HookCall): Promise<Record<string, unknown> | null> {
    const tool = str(h.input.tool_name) || 'tool';
    const input = obj(h.input.tool_input);
    const cfg = this.host.store.config();
    // with a channel registered the channel's own permission relay is the source (the terminal dialog and the phone are live together)
    if (s.channel) return null;
    const q = tool === 'AskUserQuestion' ? questionOptions(input) : null;
    const d = describeTool(tool, input);
    const hold = cfg.holdSeconds > 0 && this.host.listDevices().length > 0 && !cfg.paused && this.host.relayState === 'online';
    const holdId = randomBytes(6).toString('hex');
    let resolveHook: ((v: { behavior: 'allow' | 'deny'; message?: string } | null) => void) | null = null;
    const waiter = new Promise<{ behavior: 'allow' | 'deny'; message?: string } | null>((ok) => { resolveHook = ok; });
    const answerable = hold && !q;
    if (answerable) this.held.set(holdId, { resolve: (v) => resolveHook?.(v) });
    const fingerprint = createHash('sha256').update([str(h.input.session_id), tool, JSON.stringify(input)].join('\u0000')).digest('hex');
    await this.host.sessions.setPending(s, {
      kind: q ? 'question' : 'permission', tool, summary: q ? q.question : d.summary, preview: q ? '' : d.preview, ...(q ? { options: q.options } : {}), ttlMs: Math.max(60, cfg.holdSeconds || 600) * 1000,
      route: answerable ? this.ref('invocation', holdId, fingerprint) : null, can: { approve: answerable, reply: false },
    });
    if (!answerable) return null;
    this.host.schedulePush(0);
    const timer = setTimeout(() => resolveHook?.(null), cfg.holdSeconds * 1000);
    h.onCancel(() => resolveHook?.(null));
    const decision = await waiter;
    clearTimeout(timer);
    this.held.delete(holdId);
    if (!decision) { if (s.pending?.route?.native.id === holdId) { this.host.sessions.clearPending(s, 'expired'); this.host.sessions.setStatus(s, 'working'); } return null; }
    return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: decision.behavior, ...(decision.message ? { message: decision.message } : {}) } } };
  }

  // ------------------------------------------------------------------ control (protocol 3, WP9)
  /** what THIS session can take right now (narrower than the manifest): see `ControlAdapter.sessionCaps` */
  sessionCaps(key: string): Partial<Pick<ControlCaps, 'prompt' | 'interrupt' | 'answer' | 'tail'>> | null {
    const s = this.host.sessions.byKeyOrAlias(key);
    if (!s) return null;
    const c = this.ctl.get(s);
    const p = s.pending?.route;
    return {
      prompt: !!s.channel,
      interrupt: !!c?.preToolSeen && s.status !== 'ended',
      answer: !!p && p.native.kind === 'invocation' && this.questions.has(p.native.id),
      tail: !!s.transcript,
    };
  }

  /**
   * Free text for the session, through the MCP channel: it arrives in the agent's context as `<channel source="botwarren-companion" via="botwarren_companion"
   * device="..." kind="prompt" msg="...">` with the host's provenance line first. Claude Code queues channel events and delivers them on the next turn
   * (channels-reference); a busy session therefore takes it after its current step, an idle one starts a turn. Delivery is only "the channel took it":
   * `applied` is claimed when the transcript (or a hook) shows the message, see `confirmFromText`.
   */
  async sendPrompt(sessionKey: string, p: ControlPrompt, who: { device: string }): Promise<ControlDelivery> {
    const s = this.host.sessions.byKeyOrAlias(sessionKey);
    if (!s) return 'gone';
    if (!s.channel) return 'unsupported'; // not started with the channel (claude --dangerously-load-development-channels server:botwarren-companion)
    const c = this.stateOf(s);
    const nonce = nonceOf();
    const meta = { via: 'botwarren_companion', device: safeDeviceName(who.device).replace(/ /g, '_'), kind: 'prompt', msg: nonce };
    if (!s.channel.send({ ev: 'message', content: defang(p.framed), meta })) return 'failed';
    const t = this.now();
    c.sent = [...c.sent.filter((x) => t - x.at < SENT_TTL_MS), { nonce, at: t }].slice(-8);
    // a new instruction begins a new turn: a stop that was asked for the previous one must not hit it
    c.stop = null; c.latchUntil = 0;
    this.pumpTranscript(s);
    return 'delivered';
  }

  /**
   * A SOFT stop: arms a flag that the next PreToolUse hook call of this session consumes (it answers `continue:false` and denies that call, with a clear
   * reason). It cannot cut a text-only generation or a tool already running: the agent stops at its next tool call. Needs the opt-in control hook
   * (`claude install-hooks --control`): without a PreToolUse call seen for the session this says `unsupported`, because a flag nobody consumes would be a lie.
   */
  async interrupt(sessionKey: string, who: { device: string }): Promise<ControlDelivery> {
    const s = this.host.sessions.byKeyOrAlias(sessionKey);
    if (!s) return 'gone';
    const c = this.stateOf(s);
    if (!c.preToolSeen) return 'unsupported';
    if (s.status !== 'working' && s.status !== 'waiting') return 'busy'; // nothing is running: an armed flag would hit the next, unrelated turn
    c.stop = { device: safeDeviceName(who.device), at: this.now() };
    return 'delivered';
  }

  /** whether a stop is armed and not yet consumed (tests and `doctor`) */
  stopArmed(sessionKey: string): boolean {
    const s = this.host.sessions.byKeyOrAlias(sessionKey);
    const c = s && this.ctl.get(s);
    return !!c?.stop && this.now() - c.stop.at < STOP_TTL_MS;
  }

  /** free text as the answer to the held AskUserQuestion `n` names: it becomes that question's answer (the tool's "Other") */
  async answerText(n: NativeRef, text: ControlText, who: { device: string }): Promise<ControlDelivery> {
    const q = n.adapter === CLAUDE_ADAPTER_ID && n.kind === 'invocation' ? this.questions.get(n.id) : undefined;
    if (!q) return 'gone';
    this.questions.delete(n.id);
    q.resolve({ text, device: who.device });
    return 'delivered';
  }

  async startSession(_launch: LaunchSpec, _text: ControlPrompt | null, _who: { device: string }): Promise<{ result: ControlDelivery }> { return { result: 'unsupported' }; }

  private endTurn(s: Sess): void {
    const c = this.ctl.get(s);
    if (c) { c.stop = null; c.latchUntil = 0; }
  }

  private stopOutput(device: string): Record<string, unknown> {
    const reason = `Stopped from paired device "${device}" via Botwarren Companion: the owner asked this session to stop at the next tool call. Do not run this tool call or start others; wait for the owner's next instruction.`;
    return { continue: false, stopReason: reason, hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
  }

  private async onPreToolUse(s: Sess, h: HookCall): Promise<Record<string, unknown> | null> {
    const t = this.host.sessions;
    const c = this.stateOf(s);
    c.preToolSeen = true;
    this.pumpTranscript(s);
    const now = this.now();
    if (c.stop && now - c.stop.at >= STOP_TTL_MS) c.stop = null;
    const stopped = (device: string): Record<string, unknown> => {
      // `continue:false` ends the turn WITHOUT a Stop hook (lab-verified, 2.1.300): the session is idle from here, or the phone would show "working" forever
      void this.onStop(s).then(() => this.host.schedulePush()); // idle, with the "waiting for your next instruction" card (and its preset replies)
      return this.stopOutput(device);
    };
    if (c.stop) {
      const device = c.stop.device;
      c.stop = null; c.latchUntil = now + STOP_LATCH_MS; c.latchDevice = device;
      this.ctx?.report.tail(s.key, [{ k: 'note', text: `stopped at the next tool call (${str(h.input.tool_name) || 'tool'} was not run)`, ts: now }]);
      this.ctx?.report.followup(s.key, 'interrupt');
      return stopped(device);
    }
    if (now < c.latchUntil) return stopped(c.latchDevice);
    // the agent is running a tool, so it is working (this is also how a turn that a channel message started shows: it may have no UserPromptSubmit)
    if (s.pending?.pub.kind === 'idle') t.clearPending(s, 'prompt');
    if (s.status !== 'waiting') t.setStatus(s, 'working');
    if (str(h.input.tool_name) === 'AskUserQuestion') return this.onAskQuestion(s, c, h);
    return null;
  }

  /**
   * AskUserQuestion: Claude Code does not relay it through the channel, but a PreToolUse hook may answer it (`permissionDecision:allow` plus `updatedInput`
   * with `answers`, hooks reference). Only while a hold is allowed (hold time configured, a paired device online) and only for ONE single-select question,
   * which is the case a phone can answer completely. Not answered in time: the hook returns nothing and Claude Code shows its own question at the terminal.
   */
  private async onAskQuestion(s: Sess, c: Ctl, h: HookCall): Promise<Record<string, unknown> | null> {
    const input = obj(h.input.tool_input);
    const qs = Array.isArray(input.questions) ? input.questions : [];
    const first = obj(qs[0]);
    const question = str(first.question);
    const opts = Array.isArray(first.options) ? first.options : [];
    const cfg = this.host.store.config();
    if (qs.length !== 1 || first.multiSelect === true || !question || opts.length === 0 || !this.canHold()) return null;
    const labels: Record<string, string> = {}; const options: Option[] = []; const optionText: Record<string, string> = {};
    opts.slice(0, 8).forEach((o, i) => { const label = str(obj(o).label); if (!label) return; const id = `o${i + 1}`; labels[id] = label; options.push({ id, label: clip(label, 80) }); optionText[id] = `Option ${i + 1}: ${clip(label, 80)}`; });
    if (options.length === 0) return null;
    const holdId = randomBytes(6).toString('hex');
    let resolveHook: ((v: { text: string; device: string } | null) => void) | null = null;
    const waiter = new Promise<{ text: string; device: string } | null>((ok) => { resolveHook = ok; });
    this.questions.set(holdId, { sess: s, question, labels, input, resolve: (v) => resolveHook?.(v) });
    const fingerprint = createHash('sha256').update([str(h.input.session_id), 'AskUserQuestion', JSON.stringify(input)].join('\u0000')).digest('hex');
    await this.host.sessions.setPending(s, { kind: 'question', tool: 'AskUserQuestion', summary: question, preview: '', options, optionText, ttlMs: Math.max(5, cfg.holdSeconds) * 1000, route: this.ref('invocation', holdId, fingerprint), can: { approve: false, reply: true } });
    this.host.schedulePush(0);
    const timer = setTimeout(() => resolveHook?.(null), Math.max(5, cfg.holdSeconds) * 1000);
    h.onCancel(() => resolveHook?.(null));
    const answer = await waiter;
    clearTimeout(timer);
    this.questions.delete(holdId);
    if (s.pending?.route?.native.id === holdId) this.host.sessions.clearPending(s, answer ? 'answered' : 'expired');
    this.host.sessions.setStatus(s, 'working');
    this.host.schedulePush();
    if (!answer) return null;
    c.answered = true;
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: `Answered from paired device "${safeDeviceName(answer.device)}" via Botwarren Companion`, updatedInput: { ...input, answers: { [question]: answer.text } } } };
  }

  private canHold(): boolean {
    if (this.opts.canHold) return this.opts.canHold();
    const cfg = this.host.store.config();
    return cfg.holdSeconds > 0 && this.host.listDevices().length > 0 && !cfg.paused && this.host.relayState === 'online';
  }

  // ------------------------------------------------------------------ transcript tail and proof that a prompt began a turn
  /** reads what the transcript gained since the last read, reports it as tail lines, and looks for the nonce of a prompt we delivered */
  pumpTranscript(s: Sess): void {
    if (!s.transcript) return;
    const c = this.stateOf(s);
    const r = readNew(c.cursor, s.transcript, { toolOutput: s.toolOutput });
    if (!r) return;
    c.cursor = r.cursor;
    if (r.items.length) this.ctx?.report.tail(s.key, r.items.map((i) => ({ k: i.k, text: i.text, ts: i.ts || this.now() })));
    if (c.sent.length && r.raw) for (const x of [...c.sent]) if (r.raw.includes(`msg="${x.nonce}"`) || r.raw.includes(x.nonce)) this.confirmPrompt(s, c, x.nonce);
  }

  private confirmFromText(s: Sess, text: string): void {
    const c = this.ctl.get(s);
    if (!c?.sent.length || !text) return;
    for (const x of [...c.sent]) if (text.includes(x.nonce)) this.confirmPrompt(s, c, x.nonce);
  }

  /** the tool's own record shows our message: it reached the agent (the "applied" in the phone's result) */
  private confirmPrompt(s: Sess, c: Ctl, nonce: string): void {
    c.sent = c.sent.filter((x) => x.nonce !== nonce);
    if (s.pending?.pub.kind === 'idle') this.host.sessions.clearPending(s, 'prompt');
    if (s.status === 'idle') this.host.sessions.setStatus(s, 'working');
    this.ctx?.report.followup(s.key, 'prompt');
    this.host.schedulePush();
  }

  // ------------------------------------------------------------------ channel
  channelHello(pid: number, parentPid: number | undefined, cwd: string, send: ChannelSender): Sess {
    const t = this.host.sessions;
    // a hook session of the same Claude process may already exist
    let s: Sess | undefined;
    for (const x of t.sessions.values()) if (!x.channel && !x.key.startsWith('ch:') && x.agent === 'claude-code' && x.cwd === cwd) s = x;
    s ??= t.upsert(`ch:${pid}`, cwd || '/');
    s.owner ??= CLAUDE_ADAPTER_ID;
    s.channel = { send, pid };
    if (parentPid !== undefined) s.channelParent = parentPid;
    if (!s.label || s.label === 'project') s.label = clip(basename(cwd) || 'project', 60);
    this.host.schedulePush();
    return s;
  }

  channelBye(s: Sess): void {
    s.channel = null;
    const p = s.pending;
    if (p?.route?.adapter === CLAUDE_ADAPTER_ID && p.route.native.kind === 'request_id') { this.host.sessions.clearPending(s, 'ended'); this.host.sessions.setStatus(s, 'idle'); }
    if (s.key.startsWith('ch:')) this.host.sessions.sessions.delete(s.sid);
    this.host.schedulePush();
  }

  async channelPermissionRequest(s: Sess, r: { request_id: string; tool_name: string; description: string; input_preview: string }): Promise<void> {
    await this.host.sessions.setPending(s, {
      kind: 'permission', tool: r.tool_name, summary: r.description || `Use the ${r.tool_name} tool`, preview: r.input_preview, ttlMs: 10 * 60_000,
      route: this.ref('request_id', r.request_id), can: { approve: true, reply: false },
    });
    this.host.schedulePush(0);
  }
}

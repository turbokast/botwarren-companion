/**
 * The host's table of agent sessions and what each one is waiting for. Fed by the adapters (Claude Code's hooks and channel, the hook-family tools,
 * the local-service readers). Produces the `state` message for paired devices. Licence: Apache-2.0.
 */
import { closeSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { basename, join, sep } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { bindOf, PROTO1_AGENT_KINDS, type AgentKind, type Option, type Pending, type RiskTag, type SessionState, type StateData } from './protocol/index.ts';
import type { NativeRef } from './adapters/types.ts';
import { clip, maskSecrets } from './mask.ts';
import { cleanText } from './textclean.ts';
import { TailBuffer } from './tail.ts';
import { MAX_PREVIEW_CHARS_LONG, MAX_RECENT, MAX_RECENT_CHARS_LONG, MAX_SUMMARY_CHARS_LONG } from './protocol/messages.ts';

export type PendingCore = Omit<Pending, 'can'>;

/** how an answer reaches the agent: the adapter that owns the request and its native handle (null: nothing can be delivered, the answer is given on the computer) */
export interface Route { adapter: string; native: NativeRef }

export interface PendingInternal {
  pub: PendingCore;
  route: Route | null;
  /** answers possible for this request, shown on the device */
  can: { approve: boolean; reply: boolean; deny?: boolean };
  /** present when the answer for a "question" kind is delivered as text; the host brands these (the adapter named options the tool itself offered) */
  optionText?: Record<string, string>;
  tool?: string;
  /** a reply on this permission request means "deny, and tell the agent this preset" */
  denyWithPreset?: boolean;
}

export interface Sess {
  sid: string;
  agent: AgentKind;
  /** the tool's session id (Claude: session id, or ch:<pid> for a channel-only session; other tools are prefixed with their id) */
  key: string;
  cwd: string;
  label: string;
  status: SessionState['status'];
  /** `bypass`: the agent runs without approval prompts, so there is nothing to approve */
  mode?: 'normal' | 'bypass' | 'unknown';
  since: number;
  pending?: PendingInternal;
  recent: { role: 'assistant'; text: string; ts: number; cut?: number }[];
  channel: { send: (ev: Record<string, unknown>) => boolean; pid: number } | null;
  /** the Claude process that spawned the channel server (matched against a hook's ancestors) */
  channelParent?: number;
  transcript?: string;
  /** other ids this session is known by (see SessionReport.correlate) */
  aliases: string[];
  lastEventAt: number;
  masked: number;
  /** protocol 3: the adapter that reported this session (control commands go to it); absent for a session only observers know */
  owner?: string;
  /** protocol 3: counts revivals (a session that ended and came back is a different thing to command) and turns (each time the agent starts working); both feed `sessionBind` */
  epoch: number;
  turn: number;
  /** protocol 3: the owner turned tool output on for this session at the computer (default off) */
  toolOutput: boolean;
  tail: TailBuffer;
}

/** what a control command must echo: changes when the agent moves (new turn, new status, new pending request) or the session is revived */
export function sessionBind(s: Pick<Sess, 'sid' | 'epoch' | 'turn' | 'status' | 'pending'>): string {
  return createHash('sha256').update(['botwarren-session-bind-v1', s.sid, s.epoch, s.turn, s.status, s.pending?.pub.rid ?? ''].join('\0')).digest('hex');
}

/** keeps the start of `s` (at most `max` characters, whole characters only) and says how many characters were cut from the end */
export function cutEnd(s: string, max: number): { text: string; cut: number } {
  if (s.length <= max) return { text: s, cut: 0 }; // (UTF-16 length is an upper bound of the character count)
  const a = Array.from(s);
  return a.length <= max ? { text: s, cut: 0 } : { text: a.slice(0, max).join(''), cut: a.length - max };
}

const sidOf = (): string => randomBytes(6).toString('hex');

export class SessionTable {
  readonly sessions = new Map<string, Sess>();
  private readonly now: () => number;
  private readonly secrets: () => string[];
  private readonly denyPresets: () => string[];
  /** told when a pending request is withdrawn so the adapter that owns it can let go (a held hook is released with no decision) */
  onRelease: (p: PendingInternal) => void = () => undefined;
  constructor(now: () => number, secrets: () => string[] = () => [], denyPresets: () => string[] = () => []) { this.now = now; this.secrets = secrets; this.denyPresets = denyPresets; }

  byKey(key: string): Sess | undefined { for (const s of this.sessions.values()) if (s.key === key) return s; return undefined; }
  bySid(sid: string): Sess | undefined { return this.sessions.get(sid); }
  byChannelPid(pid: number): Sess | undefined { for (const s of this.sessions.values()) if (s.channel?.pid === pid) return s; return undefined; }
  /** the session another adapter (or the same tool) knows by this key or alias */
  byKeyOrAlias(key: string): Sess | undefined { for (const s of this.sessions.values()) if (s.key === key || s.aliases.includes(key)) return s; return undefined; }
  /** the session whose pending request has this native handle */
  byNative(n: { adapter: string; id: string }): Sess | undefined { for (const s of this.sessions.values()) if (s.pending?.route?.adapter === n.adapter && s.pending.route.native.id === n.id) return s; return undefined; }

  upsert(key: string, cwd: string, agent: AgentKind = 'claude-code'): Sess {
    let s = this.byKey(key);
    if (!s) {
      s = { sid: sidOf(), agent, key, cwd, label: clip(basename(cwd) || 'project', 60), status: 'idle', since: this.now(), recent: [], channel: null, aliases: [], lastEventAt: this.now(), masked: 0, epoch: 0, turn: 0, toolOutput: false, tail: new TailBuffer() };
      this.sessions.set(s.sid, s);
    }
    if (cwd && s.cwd !== cwd) { s.cwd = cwd; s.label = clip(basename(cwd) || 'project', 60); }
    s.lastEventAt = this.now();
    return s;
  }

  setStatus(s: Sess, status: Sess['status']): void {
    if (s.status === status) return;
    const was = s.status;
    // a new turn starts each time the agent goes (back) to work; a session that ended and came back is a new epoch
    if (status === 'working') s.turn += 1;
    if (was === 'ended') s.epoch += 1;
    s.status = status; s.since = this.now();
  }

  /** a request the agent is waiting on; the bind covers exactly what the user will see */
  async setPending(s: Sess, p: { kind: Pending['kind']; tool?: string; summary: string; preview: string; options?: Option[]; ttlMs: number; route: NativeRef | null; can: { approve: boolean; reply: boolean; deny?: boolean }; optionText?: Record<string, string>; risk?: readonly RiskTag[]; source?: 'structured' | 'screen'; denyWithPreset?: boolean }): Promise<PendingInternal> {
    const sec = this.secrets();
    const sum = maskSecrets(cleanText(p.summary), sec); const prev = maskSecrets(cleanText(p.preview), sec);
    s.masked += sum.masked + prev.masked;
    const rid = `${randomBytes(2).toString('hex')}-${randomBytes(3).toString('hex')}`;
    // nothing is answerable from a terminal screen, and a session that runs without approval prompts has nothing to approve
    const blocked = p.source === 'screen' || s.mode === 'bypass' || p.route === null;
    const can = blocked ? { approve: false, reply: false } : p.can;
    const denyWith = p.denyWithPreset && !blocked && p.kind === 'permission' && (can.approve || can.deny) ? this.denyPresets().slice(0, 8) : [];
    const risk = [...new Set(p.risk ?? [])].slice(0, 8);
    // the full text up to the long limits (the form each device gets is made in stateview.ts); what was cut here is counted, never silent
    const summary = cutEnd(sum.text, MAX_SUMMARY_CHARS_LONG); const preview = cutEnd(prev.text, MAX_PREVIEW_CHARS_LONG);
    const base = {
      rid, kind: p.kind, ...(p.tool ? { tool: clip(p.tool, 60) } : {}), summary: summary.text, preview: preview.text, ...(p.options && p.options.length ? { options: p.options.slice(0, 8) } : {}),
      ...(p.source ? { source: p.source } : {}), ...(risk.length ? { risk } : {}), ...(denyWith.length ? { denyWith } : {}),
    };
    const bind = await bindOf(base);
    const cut = summary.cut + preview.cut;
    const pub: PendingCore = { ...base, ...(cut ? { cut } : {}), expires: this.now() + p.ttlMs, bind };
    this.clearPending(s, 'replaced');
    // a request that could not be shown in full cannot be approved from a phone
    s.pending = { pub, route: blocked || !p.route ? null : { adapter: p.route.adapter, native: p.route }, can: cut ? { ...can, approve: false } : can, /* a cut request may still be denied */ ...(p.optionText ? { optionText: p.optionText } : {}), ...(p.tool ? { tool: p.tool } : {}), ...(denyWith.length ? { denyWithPreset: true } : {}) };
    this.setStatus(s, 'waiting');
    return s.pending;
  }

  /** drop the pending request; the adapter that owns it is told (a held hook is released with no decision, so the tool falls back to its own prompt) */
  clearPending(s: Sess, _why: string): void {
    const p = s.pending;
    if (!p) return;
    delete s.pending;
    try { this.onRelease(p); } catch { /* an adapter must not be able to break the table */ }
  }

  setRecent(s: Sess, texts: { text: string; ts: number }[]): void {
    const sec = this.secrets();
    s.recent = texts.slice(-MAX_RECENT).map((t) => { const m = maskSecrets(cleanText(t.text), sec); s.masked += m.masked; const c = cutEnd(m.text.trim(), MAX_RECENT_CHARS_LONG); return { role: 'assistant' as const, text: c.text, ts: t.ts, ...(c.cut ? { cut: c.cut } : {}) }; }).filter((t) => t.text);
  }

  end(s: Sess): void { this.clearPending(s, 'ended'); this.setStatus(s, 'ended'); }

  /** forget sessions that ended or went quiet long ago */
  prune(): void {
    const t = this.now();
    for (const [sid, s] of this.sessions) {
      if (s.pending && s.pending.pub.expires <= t) { this.clearPending(s, 'expired'); this.setStatus(s, 'idle'); }
      if ((s.status === 'ended' && t - s.since > 10 * 60_000) || (!s.pending && !s.channel && t - s.lastEventAt > 6 * 3_600_000)) this.sessions.delete(sid);
    }
  }

  /**
   * The state a phone sees. `proto` is what that phone said it understands: for 1, the sessions of tools it cannot parse are left out and the proto 2
   * fields are removed (the bind still covers them: the host keeps the full request and compares the bind the phone echoes).
   */
  toState(rev: number, host: StateData['host'], presets: StateData['presets'], proto = 2, ctlFor?: (s: Sess) => SessionState['ctl']): StateData {
    const sessions: SessionState[] = [...this.sessions.values()]
      .filter((s) => proto >= 2 || PROTO1_AGENT_KINDS.includes(s.agent))
      // waiting first, then by when the session last CHANGED (not by its last event: with several sessions busy, every tool call would reorder the list,
      // which made every hook event a "changed" state and defeated the coalescing); the session id breaks ties so the order is stable
      .sort((a, b) => Number(!!b.pending) - Number(!!a.pending) || b.since - a.since || (a.sid < b.sid ? -1 : a.sid > b.sid ? 1 : 0))
      .slice(0, 20)
      .map((s) => {
        const pending = s.pending ? { ...s.pending.pub, can: s.pending.can } : undefined;
        if (pending && proto < 2) { delete pending.source; delete pending.risk; delete pending.denyWith; pending.can = { approve: pending.can.approve, reply: pending.can.reply }; } // a proto 1 phone has no deny-only card: it says "answer on your computer"
        return {
          sid: s.sid, agent: s.agent, label: s.label, status: s.status, since: s.since,
          ...(proto >= 2 && s.mode ? { mode: s.mode } : {}),
          ...(pending ? { pending } : {}),
          recent: s.recent,
          ...(proto >= 3 && ctlFor ? ((c) => (c ? { ctl: c } : {}))(ctlFor(s)) : {}),
        };
      });
    const h = { ...host };
    if (proto < 2) delete h.away;
    if (proto < 3) { delete h.ctl; h.devices = h.devices.map(({ id8, name, lastSeen }) => ({ id8, name, lastSeen })); } // a phone before protocol 3 has no scopes or control and cannot parse them
    return { rev, host: h, presets, sessions };
  }
}

// ---------------------------------------------------------------- transcript tail (assistant text only)
const TAIL_BYTES = 256 * 1024;

/** the folder Claude Code keeps its transcripts in */
export const claudeTranscriptRoots = (env: Record<string, string | undefined> = process.env): string[] => [join(env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? homedir(), '.claude'), 'projects')];

/** Only files under the tool's own session folders, regular, `.jsonl`: a caller cannot point this at any other file. Symlinks are resolved first, so a link out of the folder is refused. */
export function safeTranscript(path: string, env: Record<string, string | undefined> = process.env, roots: string[] = claudeTranscriptRoots(env)): string | null {
  try {
    const real = realpathSync(path);
    const real2 = roots.map((r) => { try { return realpathSync(r); } catch { return r; } });
    if (!real.endsWith('.jsonl') || !real2.some((r) => real.startsWith(r + sep))) return null;
    return real;
  } catch { return null; }
}

export function readRecentAssistant(path: string, n = MAX_RECENT, env: Record<string, string | undefined> = process.env): { text: string; ts: number }[] {
  const safe = safeTranscript(path, env);
  if (!safe) return [];
  let fd: number | null = null;
  try {
    fd = openSync(safe, 'r');
    const st = fstatSync(fd);
    if (!st.isFile()) return [];
    const start = Math.max(0, st.size - TAIL_BYTES);
    const buf = Buffer.alloc(st.size - start);
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift(); // first line may be cut
    const out: { text: string; ts: number }[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown }; timestamp?: string };
        if (o.type !== 'assistant' && o.message?.role !== 'assistant') continue;
        const c = o.message?.content;
        const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b): b is { type: 'text'; text: string } => !!b && typeof b === 'object' && (b as { type?: string }).type === 'text' && typeof (b as { text?: unknown }).text === 'string').map((b) => b.text).join('\n') : '';
        if (text.trim()) out.push({ text, ts: o.timestamp ? Date.parse(o.timestamp) || 0 : 0 });
      } catch { /* skip a torn line */ }
    }
    return out.slice(-n);
  } catch { return []; } finally { if (fd !== null) try { closeSync(fd); } catch { /* ignore */ } }
}

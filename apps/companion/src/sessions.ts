/**
 * The host's table of agent sessions and what each one is waiting for. Fed by the Claude Code bridge (hooks and the channel server).
 * Produces the `state` message for paired devices. Licence: Apache-2.0.
 */
import { closeSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { basename, join, sep } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { bindOf, type Option, type Pending, type SessionState, type StateData } from './protocol/index.ts';
import { clip, maskSecrets } from './mask.ts';
import { cleanText } from './textclean.ts';
import { MAX_PREVIEW_CHARS_LONG, MAX_RECENT, MAX_RECENT_CHARS_LONG, MAX_SUMMARY_CHARS_LONG } from './protocol/messages.ts';

export interface Waiter { resolve: (d: { behavior: 'allow' | 'deny'; message?: string } | null) => void }

/** how an answer can reach the agent; filled by the bridge */
export interface AnswerRoute {
  /** channel permission relay: the five-letter request id Claude Code gave */
  channelRequestId?: string;
  /** a held PermissionRequest hook */
  hook?: Waiter;
}

export type PendingCore = Omit<Pending, 'can'>;

export interface PendingInternal {
  pub: PendingCore;
  route: AnswerRoute;
  /** answers possible for this request, shown on the device */
  can: { approve: boolean; reply: boolean };
  /** present when the answer for a "question" kind is delivered as channel text */
  optionText?: Record<string, string>;
  tool?: string;
}

export interface Sess {
  sid: string;
  agent: 'claude-code';
  /** Claude session id, or ch:<pid> for a channel-only session */
  key: string;
  cwd: string;
  label: string;
  status: SessionState['status'];
  since: number;
  pending?: PendingInternal;
  recent: { role: 'assistant'; text: string; ts: number; cut?: number }[];
  channel: { send: (ev: Record<string, unknown>) => boolean; pid: number } | null;
  /** the Claude process that spawned the channel server (matched against a hook's ancestors) */
  channelParent?: number;
  transcript?: string;
  lastEventAt: number;
  masked: number;
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
  constructor(now: () => number, secrets: () => string[] = () => []) { this.now = now; this.secrets = secrets; }

  byKey(key: string): Sess | undefined { for (const s of this.sessions.values()) if (s.key === key) return s; return undefined; }
  bySid(sid: string): Sess | undefined { return this.sessions.get(sid); }
  byChannelPid(pid: number): Sess | undefined { for (const s of this.sessions.values()) if (s.channel?.pid === pid) return s; return undefined; }

  upsert(key: string, cwd: string): Sess {
    let s = this.byKey(key);
    if (!s) {
      s = { sid: sidOf(), agent: 'claude-code', key, cwd, label: clip(basename(cwd) || 'project', 60), status: 'idle', since: this.now(), recent: [], channel: null, lastEventAt: this.now(), masked: 0 };
      this.sessions.set(s.sid, s);
    }
    if (cwd && s.cwd !== cwd) { s.cwd = cwd; s.label = clip(basename(cwd) || 'project', 60); }
    s.lastEventAt = this.now();
    return s;
  }

  setStatus(s: Sess, status: Sess['status']): void { if (s.status !== status) { s.status = status; s.since = this.now(); } }

  /** a request the agent is waiting on; the bind covers exactly what the user will see */
  async setPending(s: Sess, p: { kind: Pending['kind']; tool?: string; summary: string; preview: string; options?: Option[]; ttlMs: number; route: AnswerRoute; can: { approve: boolean; reply: boolean }; optionText?: Record<string, string> }): Promise<PendingInternal> {
    const sec = this.secrets();
    const sum = maskSecrets(cleanText(p.summary), sec); const prev = maskSecrets(cleanText(p.preview), sec);
    s.masked += sum.masked + prev.masked;
    const rid = `${randomBytes(2).toString('hex')}-${randomBytes(3).toString('hex')}`;
    // the full text up to the long limits (the form each device gets is made in stateview.ts); what was cut here is counted, never silent
    const summary = cutEnd(sum.text, MAX_SUMMARY_CHARS_LONG); const preview = cutEnd(prev.text, MAX_PREVIEW_CHARS_LONG);
    const base = { rid, kind: p.kind, ...(p.tool ? { tool: clip(p.tool, 60) } : {}), summary: summary.text, preview: preview.text, ...(p.options && p.options.length ? { options: p.options.slice(0, 8) } : {}) };
    const bind = await bindOf(base);
    const cut = summary.cut + preview.cut;
    const pub: PendingCore = { ...base, ...(cut ? { cut } : {}), expires: this.now() + p.ttlMs, bind };
    this.clearPending(s, 'replaced');
    // a request that could not be shown in full cannot be approved from a phone
    s.pending = { pub, route: p.route, can: cut ? { ...p.can, approve: false } : p.can, ...(p.optionText ? { optionText: p.optionText } : {}), ...(p.tool ? { tool: p.tool } : {}) };
    this.setStatus(s, 'waiting');
    return s.pending;
  }

  /** drop the pending request; a held hook is released with no decision so Claude Code falls back to its own prompt */
  clearPending(s: Sess, _why: string): void {
    const p = s.pending;
    if (!p) return;
    p.route.hook?.resolve(null);
    delete s.pending;
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

  toState(rev: number, host: StateData['host'], presets: StateData['presets']): StateData {
    const sessions: SessionState[] = [...this.sessions.values()]
      // waiting first, then by when the session last CHANGED (not by its last event: with several sessions busy, every tool call would reorder the list,
      // which made every hook event a "changed" state and defeated the coalescing); the session id breaks ties so the order is stable
      .sort((a, b) => Number(!!b.pending) - Number(!!a.pending) || b.since - a.since || (a.sid < b.sid ? -1 : a.sid > b.sid ? 1 : 0))
      .slice(0, 20)
      .map((s) => ({
        sid: s.sid, agent: s.agent, label: s.label, status: s.status, since: s.since,
        ...(s.pending ? { pending: { ...s.pending.pub, can: s.pending.can } } : {}),
        recent: s.recent,
      }));
    return { rev, host, presets, sessions };
  }
}

// ---------------------------------------------------------------- transcript tail (assistant text only)
const TAIL_BYTES = 256 * 1024;

/** Only files under ~/.claude/projects (or CLAUDE_CONFIG_DIR/projects), regular, `.jsonl`: a caller cannot point this at any other file. */
export function safeTranscript(path: string, env: Record<string, string | undefined> = process.env): string | null {
  try {
    const real = realpathSync(path);
    const roots = [join(env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? homedir(), '.claude'), 'projects')].map((r) => { try { return realpathSync(r); } catch { return r; } });
    if (!real.endsWith('.jsonl') || !roots.some((r) => real.startsWith(r + sep))) return null;
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

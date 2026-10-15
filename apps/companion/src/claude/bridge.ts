/**
 * Claude Code bridge: turns hook events and channel events into session state, and routes answers back.
 * Integration points and their confidence: docs/CLIENT_SECURITY.md part 2. Licence: Apache-2.0.
 */
import { basename } from 'node:path';
import type { CompanionHost } from '../host.ts';
import { readRecentAssistant, safeTranscript, type Sess } from '../sessions.ts';
import { clip } from '../mask.ts';
import type { Option } from '../protocol/index.ts';

export type ChannelSender = (ev: Record<string, unknown>) => boolean;

export interface HookCall {
  event: string;
  input: Record<string, unknown>;
  /** process ids from the hook process up to init, used to match a channel server of the same Claude process */
  ancestors: number[];
  /** true once the hook process has gone away (answered locally, killed, timed out) */
  cancelled: () => boolean;
  onCancel: (fn: () => void) => void;
}

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

export class ClaudeBridge {
  private readonly host: CompanionHost;
  constructor(host: CompanionHost) { this.host = host; }

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
    this.link(s, h.ancestors, cwd);
    const tp = str(h.input.transcript_path);
    if (tp && safeTranscript(tp)) s.transcript = tp;
    switch (h.event) {
      case 'SessionStart': t.setStatus(s, 'idle'); break;
      case 'SessionEnd': t.end(s); break;
      case 'UserPromptSubmit': t.clearPending(s, 'prompt'); t.setStatus(s, 'working'); break;
      case 'PostToolUse': if (s.pending?.pub.kind === 'permission') { t.clearPending(s, 'tool_ran'); } t.setStatus(s, 'working'); break;
      case 'Stop': await this.onStop(s); break;
      case 'Notification': await this.onNotification(s, h.input); break;
      case 'PermissionRequest': { const out = await this.onPermissionRequest(s, h); this.host.schedulePush(); return out; }
      default: return null;
    }
    this.host.schedulePush();
    return null;
  }

  private async onStop(s: Sess): Promise<void> {
    const t = this.host.sessions;
    if (s.transcript) t.setRecent(s, readRecentAssistant(s.transcript));
    t.clearPending(s, 'stop');
    t.setStatus(s, 'idle');
    const last = s.recent.at(-1)?.text ?? '';
    await t.setPending(s, { kind: 'idle', summary: 'Waiting for your next instruction', preview: last, ttlMs: 30 * 60_000, route: {}, can: { approve: false, reply: !!s.channel } });
    t.setStatus(s, 'idle');
  }

  private async onNotification(s: Sess, input: Record<string, unknown>): Promise<void> {
    const type = str(input.notification_type);
    if (s.pending) return;
    if (type === 'permission_prompt' || type === 'elicitation_dialog' || type === 'elicitation_url_dialog') {
      await this.host.sessions.setPending(s, { kind: 'permission', summary: clip(str(input.message) || 'Waiting for your answer', 200), preview: '', ttlMs: 10 * 60_000, route: {}, can: { approve: false, reply: false } });
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
    let resolveHook: ((v: { behavior: 'allow' | 'deny'; message?: string } | null) => void) | null = null;
    const waiter = new Promise<{ behavior: 'allow' | 'deny'; message?: string } | null>((ok) => { resolveHook = ok; });
    await this.host.sessions.setPending(s, {
      kind: q ? 'question' : 'permission', tool, summary: q ? q.question : d.summary, preview: q ? '' : d.preview, ...(q ? { options: q.options } : {}), ttlMs: Math.max(60, cfg.holdSeconds || 600) * 1000,
      route: hold && !q ? { hook: { resolve: (v) => resolveHook?.(v) } } : {}, can: { approve: hold && !q, reply: false },
    });
    if (!hold || q) return null;
    this.host.schedulePush(0);
    const timer = setTimeout(() => resolveHook?.(null), cfg.holdSeconds * 1000);
    h.onCancel(() => resolveHook?.(null));
    const decision = await waiter;
    clearTimeout(timer);
    if (!decision) { if (s.pending?.route.hook) { delete s.pending; this.host.sessions.setStatus(s, 'working'); } return null; }
    return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: decision.behavior, ...(decision.message ? { message: decision.message } : {}) } } };
  }

  // ------------------------------------------------------------------ channel
  channelHello(pid: number, parentPid: number | undefined, cwd: string, send: ChannelSender): Sess {
    const t = this.host.sessions;
    // a hook session of the same Claude process may already exist
    let s: Sess | undefined;
    for (const x of t.sessions.values()) if (!x.channel && !x.key.startsWith('ch:') && x.cwd === cwd) s = x;
    s ??= t.upsert(`ch:${pid}`, cwd || '/');
    s.channel = { send, pid };
    if (parentPid !== undefined) s.channelParent = parentPid;
    if (!s.label || s.label === 'project') s.label = clip(basename(cwd) || 'project', 60);
    this.host.schedulePush();
    return s;
  }

  channelBye(s: Sess): void {
    s.channel = null;
    if (s.pending?.route.channelRequestId) { delete s.pending; this.host.sessions.setStatus(s, 'idle'); }
    if (s.key.startsWith('ch:')) this.host.sessions.sessions.delete(s.sid);
    this.host.schedulePush();
  }

  async channelPermissionRequest(s: Sess, r: { request_id: string; tool_name: string; description: string; input_preview: string }): Promise<void> {
    await this.host.sessions.setPending(s, {
      kind: 'permission', tool: r.tool_name, summary: r.description || `Use the ${r.tool_name} tool`, preview: r.input_preview, ttlMs: 10 * 60_000,
      route: { channelRequestId: r.request_id }, can: { approve: true, reply: false },
    });
    this.host.schedulePush(0);
  }
}

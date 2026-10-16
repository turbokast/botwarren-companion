/**
 * Herdr (https://herdr.dev, a terminal workspace manager for coding agents) as a READ-ONLY adapter: it tells the phone which agent in which folder is
 * blocked on an approval or question, for every agent kind Herdr recognises (Cursor, Aider, Cline, ... as well as Claude Code, Codex and Muse), without
 * installing anything in those tools. It can never answer: there is no `send_keys`, `prompt`, `pane.*`, `run` or `start` method in this client (the
 * allowlist below is enforced in code and tested against a fake socket), so every card says "Answer on your computer" (decision 1: no keystroke injection).
 *
 * Privacy: the folder name (never the pane title, which holds private task titles), the agent kind and the state. Text read off the screen is OFF by
 * default (`adapters herdr screenPreview`); when on, only the detection excerpt of a BLOCKED pane is read, masked, capped, labelled "from the terminal screen".
 * Unix only: Herdr's Windows pipe name is undocumented and is not guessed. Licence: Apache-2.0.
 */
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { unixSocketRequest } from '../io.ts';
import { NO_CONTROL, type Adapter, type AdapterContext, type AdapterManifest, type AgentKind, type Answer, type DeliverResult, type DetectResult, type DoctorLine, type NativeRef, type Revalidation } from '../types.ts';

/** the ONLY methods this adapter can send */
export const HERDR_ALLOWED_METHODS: ReadonlySet<string> = new Set(['ping', 'agent.list', 'agent.read']);
/** the protocol number this was written against (`ping` says 22 on Herdr 0.9.1); another number is still read, doctor says it differs */
export const HERDR_PROTOCOL = 22;
const NAME_OK = /^[A-Za-z0-9._-]{1,64}$/;
const POLL_MS = 2000;
const GONE_AFTER_MS = 10_000;

export const HERDR_MANIFEST: AdapterManifest = {
  id: 'herdr', kind: 'herdr', safety: 'A',
  caps: { detect: true, readPending: true, readRecent: false, approve: false, deny: false, presetReply: false, optionAnswer: false },
  reads: [
    'which agents Herdr recognises on this computer, the folder each works in (its name only, never the pane title), and whether each is working, idle or blocked on an approval or question',
    'only when you turn on screenPreview: a short excerpt of the terminal screen of a BLOCKED pane, masked, shown labelled "from the terminal screen"',
    'it cannot type into any pane: there is no way for this adapter to send a key, a prompt or a command, so every card says "Answer on your computer"',
  ],
  verified: { versions: [] },
  confirmFloor: { approve: 'always', reply: 'always' },
  observesOutcome: false,
  // protocol 3: no control capability is verified for this tool yet (observe and approve/deny only), so none is claimed
  control: NO_CONTROL,
};

/** Herdr's agent kind -> ours; anything else is "another agent" */
const KIND: Record<string, AgentKind> = { claude: 'claude-code', codex: 'codex', muse: 'muse', opencode: 'opencode', agy: 'agy', 'antigravity-cli': 'agy', copilot: 'copilot', ninox: 'ninox' };
/** the prefix other adapters give a session of that kind, so a Herdr pane merges with a hook-reported session of the same agent */
const KEY_PREFIX: Partial<Record<AgentKind, string>> = { codex: 'codex:', muse: 'muse:', copilot: 'copilot:' };

interface HAgent { agent: string | null; status: string; session: string | null; cwd: string; pane: string; rev: number; seq: number }

export interface HerdrTarget { name: string; path: string }

/** candidate sockets, most specific first: HERDR_SOCKET_PATH, HERDR_SESSION, the default, then named sessions found on disk (Unix only) */
export function herdrTargets(env: Record<string, string | undefined> = process.env, platform: string = process.platform, home: string = env.HOME ?? homedir()): HerdrTarget[] {
  if (platform === 'win32') return [];
  const out: HerdrTarget[] = [];
  const add = (name: string, path: string): void => { if (!out.some((t) => t.path === path) && out.length < 8) out.push({ name, path }); };
  const base = join(env.XDG_CONFIG_HOME || join(home, '.config'), 'herdr');
  if (env.HERDR_SOCKET_PATH && env.HERDR_SOCKET_PATH.startsWith('/') && env.HERDR_SOCKET_PATH.length < 1024) add('env', env.HERDR_SOCKET_PATH);
  if (env.HERDR_SESSION && NAME_OK.test(env.HERDR_SESSION)) add(env.HERDR_SESSION, join(base, 'sessions', env.HERDR_SESSION, 'herdr.sock'));
  add('default', join(base, 'herdr.sock'));
  try { for (const n of readdirSync(join(base, 'sessions'))) if (NAME_OK.test(n)) add(n, join(base, 'sessions', n, 'herdr.sock')); } catch { /* none */ }
  return out;
}

export class HerdrAdapter implements Adapter {
  readonly manifest = HERDR_MANIFEST;
  private ctx: AdapterContext | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private inflight: Promise<void> | null = null;
  private readonly targets: () => HerdrTarget[];
  /** requests sent, by method (asserted in tests: only allowlisted methods ever go out) */
  readonly sent: string[] = [];
  /** panes we reported as sessions of our own, and when each was last seen */
  private readonly own = new Map<string, number>();
  private readonly blocked = new Map<string, string>(); // pane -> fingerprint of what was reported
  private proto: number | null = null;

  constructor(o: { targets?: () => HerdrTarget[] } = {}) { this.targets = o.targets ?? (() => herdrTargets()); }

  async detect(): Promise<DetectResult> {
    const t = this.targets().find((x) => existsSync(x.path));
    if (!t) return { present: false, note: process.platform === 'win32' ? 'Windows is not supported (Herdr\'s pipe name is undocumented)' : 'no Herdr socket found' };
    const r = await this.call(t.path, 'ping', {});
    const res = (r as { result?: { version?: string; protocol?: number } } | null)?.result;
    if (!res) return { present: false, note: 'a Herdr socket exists but did not answer' };
    this.proto = typeof res.protocol === 'number' ? res.protocol : null;
    return { present: true, ...(res.version ? { version: res.version } : {}), note: `protocol ${String(res.protocol)}${res.protocol === HERDR_PROTOCOL ? '' : ` (written against ${HERDR_PROTOCOL}: still read, check the cards)`}` };
  }

  async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
    this.timer = setInterval(() => { void this.poll(); }, POLL_MS);
    this.timer.unref?.();
    void this.poll();
  }
  async stop(): Promise<void> { if (this.timer) clearInterval(this.timer); this.timer = null; }
  async revalidate(): Promise<Revalidation> { return 'gone'; }
  async deliver(_n: NativeRef, _a: Answer, _who?: { device: string }): Promise<DeliverResult> { return 'unsupported'; }
  release(): void { /* nothing is held */ }
  async doctor(): Promise<DoctorLine[]> {
    const d = await this.detect();
    return [
      { label: 'herdr', value: d.present ? `found ${d.version ?? ''} (${d.note ?? ''})` : d.note ?? 'not found', ok: d.present ? this.proto === HERDR_PROTOCOL : null },
      { label: 'herdr answers', value: 'never: read only, no keys are ever sent', ok: true },
    ];
  }

  // ------------------------------------------------------------------ polling
  /** one request over a fresh connection; refuses any method outside the allowlist */
  private async call(path: string, method: string, params: Record<string, unknown>): Promise<unknown | null> {
    if (!HERDR_ALLOWED_METHODS.has(method)) throw new Error('method not allowed');
    this.sent.push(method);
    return unixSocketRequest(path, { id: `bw-${this.sent.length}`, method, params });
  }

  private parse(r: unknown): HAgent[] {
    const list = (r as { result?: { agents?: unknown } } | null)?.result?.agents;
    if (!Array.isArray(list)) return [];
    const out: HAgent[] = [];
    for (const a of list.slice(0, 64)) {
      const o = a as Record<string, unknown>;
      if (typeof o.pane_id !== 'string' || typeof o.agent_status !== 'string') continue;
      const sess = o.agent_session as { value?: unknown } | null | undefined;
      out.push({
        agent: typeof o.agent === 'string' ? o.agent : null, status: o.agent_status, session: typeof sess?.value === 'string' && /^[0-9A-Za-z._:-]{6,120}$/.test(sess.value) ? sess.value : null,
        cwd: typeof o.cwd === 'string' ? o.cwd : '', pane: o.pane_id.slice(0, 64), rev: typeof o.revision === 'number' ? o.revision : 0, seq: typeof o.state_change_seq === 'number' ? o.state_change_seq : 0,
      });
    }
    return out;
  }

  /** the detection excerpt of a blocked pane: PaneReadResult.text, wherever the reply wraps it */
  private textOf(r: unknown): string {
    const res = (r as { result?: Record<string, unknown> } | null)?.result;
    for (const c of [res, res?.read, res?.pane_read, res?.result]) { const t = (c as { text?: unknown } | undefined)?.text; if (typeof t === 'string') return t; }
    return '';
  }

  /** one poll; a poll asked for while another is running waits for it and then runs again (so data that changed meanwhile is never missed until the next timer tick) */
  async poll(): Promise<void> {
    while (this.inflight) await this.inflight.catch(() => undefined);
    this.inflight = this.pollOnce().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async pollOnce(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx || !ctx.config().enabled) return;
    this.polling = true;
    try {
      const t = this.targets().find((x) => existsSync(x.path));
      if (!t) return;
      const agents = this.parse(await this.call(t.path, 'agent.list', {}));
      const now = ctx.now(); const seen = new Set<string>();
      const preview = ctx.config().screenPreview === true;
      for (const a of agents) {
        const kind: AgentKind = KIND[a.agent ?? ''] ?? 'other';
        const key = `herdr:${a.pane}`;
        seen.add(key);
        const correlate = a.session ? [a.session, ...(KEY_PREFIX[kind] ? [`${KEY_PREFIX[kind]}${a.session}`] : [])] : [];
        const status = a.status === 'working' ? 'working' : a.status === 'blocked' ? 'waiting' : 'idle';
        // a session only Herdr knows is ours to keep up to date; one a hook adapter reported is only given the extra ids
        const report = { key, agent: kind, cwd: a.cwd, label: basename(a.cwd) || 'project', status, correlate } as const;
        if (this.own.has(key)) { ctx.report.session(report); this.own.set(key, now); }
        else if (ctx.report.session({ ...report, passive: true }) === 'created') this.own.set(key, now);
        if (a.status === 'blocked') {
          const fp = `${a.rev}:${a.seq}`;
          if (this.blocked.get(a.pane) !== fp) {
            this.blocked.set(a.pane, fp);
            let text = '';
            if (preview) text = this.textOf(await this.call(t.path, 'agent.read', { target: a.pane, source: 'detection', lines: 12, strip_ansi: true, format: 'text' })).split('\n').slice(-12).join('\n');
            await ctx.report.pending({ sessionKey: key, kind: 'permission', summary: 'Waiting for you', preview: text, ttlMs: 30 * 60_000, native: null, can: { approve: false, reply: false }, risk: [], source: 'screen' });
            ctx.report.changed(true);
          }
        } else if (this.blocked.has(a.pane)) {
          this.blocked.delete(a.pane);
          if (ctx.report.cleared(key, 'answered_local', undefined, 'screen')) ctx.report.changed(true);
        }
      }
      for (const [key, last] of [...this.own]) {
        if (!seen.has(key) && now - last > GONE_AFTER_MS) {
          this.own.delete(key); this.blocked.delete(key.slice('herdr:'.length));
          ctx.report.cleared(key, 'ended');
          ctx.report.session({ key, agent: 'other', status: 'ended' });
        }
      }
    } finally { this.polling = false; }
  }
}

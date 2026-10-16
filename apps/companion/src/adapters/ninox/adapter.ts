/**
 * Ninox (https://github.com/Made-by-Moonlight/ninox, a fleet supervisor for coding agents) as a READ-ONLY adapter, forever (owner decision 4): it shows which Ninox
 * sessions exist and marks workers "No approval prompts", because Ninox launches workers with their permission prompts bypassed (there is nothing to approve, and the only
 * input route Ninox has is an unauthenticated raw-keystroke terminal WebSocket, which is never touched). An orchestrator is an ordinary interactive Claude Code session: it is
 * merged into the card Claude Code's own hooks report (same `claude_session_id`) and keeps its normal approvals.
 *
 * ONE request: `GET /api/v1/sessions` on 127.0.0.1 (default port 8080, `adapters.ninox.port`). Port 8080 is shared by many tools, so the shape is verified (a JSON array of
 * objects with string id/status/activity/agent_type, from Ninox's types.rs at v0.34.0 read from source; NOT verified against a live install, Ninox is not installed here)
 * before anything is trusted. Never called: DELETE, /diff, /terminal, /orchestrators, /api/brain/*, the SSE stream. Kept: status, the working folder's name, and the Claude session
 * id (correlation only). Dropped always: names, repo, summaries, notes, costs, PR numbers. Off until enabled. Licence: Apache-2.0.
 */
import { basename } from 'node:path';
import { loopbackHttp } from '../io.ts';
import { NO_CONTROL, type Adapter, type AdapterContext, type AdapterManifest, type Answer, type SessionReport, type DeliverResult, type DetectResult, type DoctorLine, type NativeRef, type Revalidation } from '../types.ts';

export const NINOX_ID = 'ninox';
export const NINOX_ALLOWED_PATHS: readonly string[] = ['/api/v1/sessions'];
export const NINOX_MANIFEST: AdapterManifest = {
  id: NINOX_ID, kind: 'ninox', safety: 'A',
  caps: { detect: true, readPending: false, readRecent: false, approve: false, deny: false, presetReply: false, optionAnswer: false },
  reads: [
    'Ninox\'s local server on this computer (loopback only, one request: the list of sessions): each session\'s state, the folder it works in (its name only) and the Claude session id it runs, to merge it with the Claude Code card',
    'workers are shown with the note "No approval prompts": Ninox starts them with approval prompts bypassed, so there is nothing to approve, and nothing here can steer them',
    'never its names, repos, summaries, notes, costs or pull-request numbers, and never its terminal, diff, delete or orchestrator routes',
  ],
  verified: { versions: [] },
  confirmFloor: { approve: 'always', reply: 'always' },
  observesOutcome: false,
  // protocol 3: no control capability is verified for this tool yet (observe and approve/deny only), so none is claimed
  control: NO_CONTROL,
};

const POLL_MS = 3000;
const TERMINAL = new Set(['done', 'terminated', 'interrupted']);
const ID_OK = /^[0-9A-Za-z_-]{1,64}$/;
const UUIDISH = /^[0-9a-f-]{36}$/i;
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

/** the session objects if the body has Ninox's shape, 'empty' for an empty list, null otherwise */
export function verifyNinoxShape(body: string): Record<string, unknown>[] | 'empty' | null {
  let v: unknown; try { v = JSON.parse(body); } catch { return null; }
  const arr = Array.isArray(v) ? v : isObj(v) && Array.isArray(v.sessions) ? v.sessions : null;
  if (!arr) return null;
  if (arr.length === 0) return 'empty';
  const objs = arr.filter(isObj);
  if (objs.length !== arr.length) return null;
  return objs.slice(0, 50).every((o) => typeof o.id === 'string' && typeof o.status === 'string' && typeof o.activity === 'string' && typeof o.agent_type === 'string') ? objs : null;
}

export class NinoxAdapter implements Adapter {
  readonly manifest = NINOX_MANIFEST;
  private ctx: AdapterContext | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inflight: Promise<void> | null = null;
  private readonly own = new Map<string, number>();
  /** every path requested (tests) */
  readonly sent: string[] = [];

  private async fetchSessions(): Promise<{ status: 'ok' | 'absent' | 'other'; rows: Record<string, unknown>[] }> {
    const port = Number((this.ctx?.config() as { port?: unknown } | undefined)?.port) || 8080;
    this.sent.push('/api/v1/sessions');
    const r = await loopbackHttp({ port, method: 'GET', path: '/api/v1/sessions', timeoutMs: 3000 });
    if (!r) return { status: 'absent', rows: [] };
    const shape = r.status === 200 ? verifyNinoxShape(r.body) : null;
    if (shape === null) return { status: 'other', rows: [] };
    return { status: 'ok', rows: shape === 'empty' ? [] : shape.slice(0, 100) };
  }

  async detect(): Promise<DetectResult> {
    const r = await this.fetchSessions();
    return r.status === 'ok' ? { present: true, note: 'Ninox answers (read-only)' } : { present: false, note: r.status === 'other' ? 'something else answers on that port: ignored' : 'no Ninox server on the configured port' };
  }
  async start(ctx: AdapterContext): Promise<void> { this.ctx = ctx; this.timer = setInterval(() => { void this.poll(); }, POLL_MS); this.timer.unref?.(); void this.poll(); }
  async stop(): Promise<void> { if (this.timer) clearInterval(this.timer); this.timer = null; }
  async revalidate(_n: NativeRef): Promise<Revalidation> { return 'gone'; }
  async deliver(_n: NativeRef, _a: Answer, _who?: { device: string }): Promise<DeliverResult> { return 'unsupported'; }
  release(): void { /* nothing is held */ }
  async doctor(): Promise<DoctorLine[]> { const d = await this.detect(); return [{ label: 'ninox', value: d.note ?? '', ok: d.present ? true : null }, { label: 'ninox answers', value: 'never: workers run without approval prompts and nothing can steer them from here', ok: true }]; }

  async poll(): Promise<void> {
    while (this.inflight) await this.inflight.catch(() => undefined);
    this.inflight = this.pollOnce().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async pollOnce(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx || !ctx.config().enabled) return;
    const { status, rows } = await this.fetchSessions();
    if (status !== 'ok') return; // never end sessions because the feed is down
    const now = ctx.now(); const live = new Set<string>();
    const ids = new Set(rows.filter((r) => !TERMINAL.has(String(r.status))).map((r) => String(r.id)));
    for (const r of rows) {
      const id = String(r.id);
      if (!ID_OK.test(id) || !ids.has(id)) continue;
      const key = `ninox:${id}`; live.add(key);
      const orch = typeof r.orchestrator_id === 'string' && ID_OK.test(r.orchestrator_id) && ids.has(r.orchestrator_id) && r.orchestrator_id !== id;
      const cs = typeof r.claude_session_id === 'string' && UUIDISH.test(r.claude_session_id) ? r.claude_session_id : null;
      const cwd = typeof r.workspace_path === 'string' && r.workspace_path.length > 0 && r.workspace_path.length <= 1024 ? r.workspace_path : '';
      const activity = String(r.activity);
      // the activity says what it is doing now; the lifecycle status only when the activity is not one of the three it knows
      const lifecycle = String(r.status);
      const st = activity === 'working' ? 'working' : activity === 'idle' || activity === 'blocked' ? 'idle' : lifecycle === 'working' || lifecycle === 'spawning' ? 'working' : 'idle';
      const report: SessionReport = { key, agent: 'ninox', cwd, label: basename(cwd) || 'project', status: st, correlate: cs ? [cs] : [], mode: orch ? 'bypass' : 'normal' } as const;
      // a worker is told apart from an orchestrator by its orchestrator link; either is merged into the Claude card of the same session when there is one
      if (this.own.has(key)) { ctx.report.session(report); this.own.set(key, now); }
      else if (ctx.report.session({ ...report, passive: true }) === 'created') this.own.set(key, now);
    }
    for (const [key, last] of [...this.own]) if (!live.has(key) && now - last > 30_000) { this.own.delete(key); ctx.report.cleared(key, 'ended'); ctx.report.session({ key, agent: 'ninox', status: 'ended' }); }
    ctx.report.changed();
  }
}

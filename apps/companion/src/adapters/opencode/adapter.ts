/**
 * OpenCode v2 (https://opencode.ai) through its local HTTP API, the best-supported route of any tool: a pending permission request has its own id, can be
 * listed, fetched and answered by that exact id, and answered once (`once`) or refused (`reject`, with an optional reason). Spike S-O1 (isolated server,
 * v2.0.21, no model: the request is created through the API's own `permission.create`) observed all of it.
 *
 * Protocol 3 (remote control, docs/PROTOCOL3.md): this adapter can also send a prompt to a session (`POST /api/session/{id}/prompt`), stop it
 * (`POST /api/session/{id}/interrupt`), answer a one-field form with free text (`POST /api/session/{id}/form/{formID}/reply`), start a session in a folder
 * from the host's launch table (`POST /api/session`) and feed the live tail (`GET /api/session/{id}/message`). The routes and every body shape are the ones
 * the server itself publishes at `GET /openapi.json` and were recorded from a real opencode 2.0.21 in the lab (test/support/fixtures/opencode-v2-shapes.json).
 * The OpenCode server docs: https://opencode.ai/docs/server/ .
 *
 * Hard rules, each asserted by a test over every request body the fake server received:
 *  - the permission decision is built from the two literal words `once` and `reject`; `always` (a persistent rule) cannot be produced by this code;
 *  - the only text an agent receives is `ControlPrompt.framed` (made by the host with its provenance line) or the host's `ControlText` for a form answer;
 *  - no `shell`, `command`, `pty`, `fs`, `worktree`, `config`, `credential` or `integration` route is ever called (the allowlist below is the whole list);
 *  - a session is started only in a folder from the host's launch table, never in one a device named; modes with no verified OpenCode meaning are refused.
 *
 * Network: loopback only, one allowlisted request shape per purpose (see `ALLOWED`), no redirects, 2 MB cap. The HTTP Basic password (OpenCode v2 always wants one)
 * is used only if the person named an environment variable for it (`adapters.opencode.passwordEnv`), is read from the daemon's own environment only (never a
 * file), and is sent only after the server on that port identified itself with OpenCode's exact 401 answer. Licence: Apache-2.0.
 */
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import { clip } from '../../mask.ts';
import { loopbackHttp, type HttpResult } from '../io.ts';
import { commandRisks, outsideWorkspace } from '../hookfamily/risk.ts';
import {
  versionVerified, safeDeviceName,
  type Adapter, type AdapterContext, type AdapterManifest, type Answer, type ControlAdapter, type ControlDelivery, type ControlPrompt, type ControlText, type DeliverResult,
  type DetectResult, type DoctorLine, type LaunchSpec, type NativeRef, type PendingReport, type Revalidation, type RiskTag, type TailKind,
} from '../types.ts';
import { messageLines } from './tail.ts';

export const OPENCODE_ID = 'opencode';
export const OPENCODE_MANIFEST: AdapterManifest = {
  id: OPENCODE_ID, kind: 'opencode', safety: 'A',
  caps: { detect: true, readPending: true, readRecent: false, approve: true, deny: true, presetReply: true, optionAnswer: false },
  reads: [
    'OpenCode\'s local server on this computer (loopback only): the sessions, the folder each works in (its name only), whether each is running, and any permission request or question waiting for you (the action, what it names, OpenCode\'s own message)',
    'for the live tail of a session you watch from a paired device: the newest messages of that session (your prompts, the assistant\'s text, one line per tool call, and tool output only if you turned it on for that session); never its reasoning',
    'the HTTP password only if you named an environment variable for it (adapters.opencode.passwordEnv); it is read from the companion\'s own environment, never from a file, and sent only to a server that identified itself as OpenCode',
    'it answers a permission request by its exact id with once or reject only: a persistent rule cannot be sent; with remote control on and a device you gave the control scope it can also send that device\'s prompt to a session, stop a session, answer a question that takes one line of text, or start a session in a folder from your launch list; no shell, command, terminal or file route is ever called',
  ],
  verified: { versions: ['2.0.*'] },
  confirmFloor: { approve: 'off', reply: 'off' },
  observesOutcome: true,
  // protocol 3: every capability below was exercised against a real opencode 2.0.21 in the lab (scripts/lab/run.sh, scenario opencode-control). Only an unverified version falls back to read-only (the methods answer `unsupported`).
  control: { prompt: true, interrupt: true, softInterrupt: false, answer: true, start: true, tail: true, route: 'api' },
};

const SES = 'ses[A-Za-z0-9_]{4,80}';
/** the ONLY requests this adapter makes */
export const ALLOWED: readonly { method: 'GET' | 'POST'; path: RegExp }[] = [
  { method: 'GET', path: /^\/api\/info$/ },
  { method: 'GET', path: /^\/api\/session(?:\?.*)?$/ },
  { method: 'GET', path: /^\/api\/session\/active(?:\?.*)?$/ },
  { method: 'GET', path: /^\/api\/permission\/request(?:\?.*)?$/ },
  { method: 'GET', path: /^\/api\/form(?:\?.*)?$/ },
  { method: 'GET', path: new RegExp(`^/api/session/${SES}/permission/per[A-Za-z0-9_]{4,80}$`) },
  { method: 'POST', path: new RegExp(`^/api/session/${SES}/permission/per[A-Za-z0-9_]{4,80}/reply$`) },
  // protocol 3
  { method: 'POST', path: /^\/api\/session$/ },
  { method: 'POST', path: new RegExp(`^/api/session/${SES}/prompt$`) },
  { method: 'POST', path: new RegExp(`^/api/session/${SES}/interrupt$`) },
  { method: 'GET', path: new RegExp(`^/api/session/${SES}/message(?:\\?order=desc&limit=\\d{1,2})?$`) },
  { method: 'GET', path: new RegExp(`^/api/session/${SES}/message/msg_[A-Za-z0-9_]{4,80}$`) },
  { method: 'GET', path: new RegExp(`^/api/session/${SES}/form/frm[A-Za-z0-9_]{4,80}$`) },
  { method: 'POST', path: new RegExp(`^/api/session/${SES}/form/frm[A-Za-z0-9_]{4,80}/reply$`) },
];

const ID = /^[A-Za-z0-9_]{4,90}$/;
const SESSION_KEY = new RegExp(`^opencode:(${SES})$`);
const MSG_ID = /^msg_[A-Za-z0-9_]{4,80}$/;
const FORM_ID = /^frm[A-Za-z0-9_]{4,80}$/;
const POLL_MS = 3000;
const TAIL_FETCH = 10; // messages asked for per session per fetch
const TAIL_SESSIONS = 5; // sessions fetched per poll
const NETWORK_ACTIONS = /^(webfetch|websearch|fetch|http|network)/i;
/** a session started from here asks before every tool (the closest verified thing to Claude's "default"); no rule that allows anything is ever sent */
const ASK_EVERYTHING = [{ action: '*', resource: '*', effect: 'ask' }] as const;
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const parse = (s: string): unknown => { try { return JSON.parse(s); } catch { return undefined; } };
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Req { id: string; sessionID: string; action: string; resources: string[]; message: string; description: string; dir: string; fingerprint: string }
interface Form { id: string; sessionID: string; title: string; dir: string; fingerprint: string; preview: string; /** the one field a free-text answer fills, when the form is exactly that */ text: { key: string; maxLength?: number } | null }
interface TailState { emitted: Map<string, true>; updated: number; primed: boolean; wasRunning: boolean }

export class OpenCodeAdapter implements ControlAdapter {
  readonly manifest = OPENCODE_MANIFEST;
  private ctx: AdapterContext | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private waiting = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private version: string | null = null;
  private identified = false;
  private lastNote = '';
  private stopped = false;
  /** request id -> where it lives */
  private readonly reqs = new Map<string, Req>();
  private readonly forms = new Map<string, Form>();
  private readonly posted = new Set<string>(); // request ids already reported (forms: `form:<id>`)
  private readonly own = new Map<string, number>(); // session keys we report -> last seen
  private readonly shownAs = new Map<string, string>(); // session key -> `status|mode` last reported (a push is asked for only when it changes)
  private readonly tails = new Map<string, TailState>();
  private readonly background = new Set<Promise<unknown>>();
  /** every request sent (method + path), for the tests */
  readonly sent: string[] = [];
  private readonly env: Record<string, string | undefined>;
  constructor(o: { env?: Record<string, string | undefined> } = {}) { this.env = o.env ?? process.env; }

  // ------------------------------------------------------------------ http
  private async http(method: 'GET' | 'POST', path: string, body?: unknown): Promise<HttpResult | null> {
    if (!ALLOWED.some((a) => a.method === method && a.path.test(path))) throw new Error('request not allowed');
    const cfg = this.ctx?.config() ?? { port: 4096 };
    const port = Number((cfg as { port?: unknown }).port) || 4096;
    const passEnv = str((cfg as { passwordEnv?: unknown }).passwordEnv);
    const password = passEnv ? this.env[passEnv] : undefined;
    this.sent.push(`${method} ${path.split('?')[0]}`);
    const headers: Record<string, string> = {};
    if (this.identified && password) headers.authorization = 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64');
    return loopbackHttp({ port, method, path, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), headers, timeoutMs: 4000 });
  }

  /** everything that talks to the server (a poll, a command, a confirmation) runs one at a time: `identify` resets the identified flag, and a command must never see it half way */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    this.waiting += 1;
    const run = this.chain.then(fn).finally(() => { this.waiting -= 1; });
    this.chain = run.catch(() => undefined);
    return run;
  }
  /** a confirmation that runs after the command returned; tracked so a test can wait for it and `stop` can let go of it */
  private later(fn: () => Promise<void>): void {
    const p: Promise<unknown> = this.exclusive(async () => { if (!this.stopped) await fn(); }).catch(() => undefined).finally(() => { this.background.delete(p); });
    this.background.add(p);
  }
  /** for tests: resolves when every confirmation started so far has finished */
  async settled(): Promise<void> { while (this.background.size) await Promise.all([...this.background]); }

  /** is the thing on the port OpenCode v2? Only then is the password ever sent. */
  private async identify(): Promise<'ok' | 'no_password' | 'absent' | 'other' | 'bad_password'> {
    const cfg = this.ctx?.config(); const passEnv = str((cfg as { passwordEnv?: unknown } | undefined)?.passwordEnv);
    this.identified = false;
    const r = await this.http('GET', '/api/info');
    if (!r) return 'absent';
    const b = parse(r.body);
    if (r.status === 401 && isObj(b) && b._tag === 'UnauthorizedError') {
      if (!passEnv || !this.env[passEnv]) return 'no_password';
      this.identified = true;
      const r2 = await this.http('GET', '/api/info');
      if (!r2 || r2.status !== 200) { this.identified = false; return 'bad_password'; }
      const j = parse(r2.body); this.version = isObj(j) ? str(j.version) || null : null;
      return 'ok';
    }
    if (r.status === 200 && isObj(b) && typeof b.version === 'string' && isObj(b.paths)) { this.identified = true; this.version = b.version; return 'ok'; } // a server without a password
    return 'other';
  }

  private isVerified(): boolean { return versionVerified(this.version, [...this.manifest.verified.versions, ...(this.ctx?.config().verifiedVersions ?? [])]); }

  // ------------------------------------------------------------------ adapter interface
  async detect(): Promise<DetectResult> {
    const s = await this.exclusive(() => this.identify());
    const note = { ok: `OpenCode ${this.version ?? ''}`, no_password: 'OpenCode is running but needs its password: set adapters.opencode.passwordEnv to the NAME of an environment variable that holds it (in the companion\'s environment)', absent: 'no OpenCode server on the configured port', other: 'something else answers on that port: not touched', bad_password: 'the password in that environment variable was not accepted' }[s];
    return { present: s === 'ok', ...(this.version ? { version: this.version } : {}), note };
  }

  async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx; this.stopped = false;
    this.timer = setInterval(() => { if (this.waiting === 0) void this.poll(); }, POLL_MS);
    this.timer.unref?.();
    void this.poll();
  }
  async stop(): Promise<void> { this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = null; }

  async doctor(): Promise<DoctorLine[]> {
    const d = await this.detect();
    const cfg = this.ctx?.config() as { passwordEnv?: string; port?: number } | undefined;
    const verified = this.isVerified();
    return [
      { label: 'opencode', value: `${d.present ? `found ${this.version ?? ''}${verified ? ' (verified: can answer and, with remote control on, act)' : ' (not verified: read only)'}` : d.note ?? 'not found'} (port ${cfg?.port ?? 4096})`, ok: d.present ? verified : null },
      { label: 'opencode auth', value: cfg?.passwordEnv ? `password from the environment variable ${cfg.passwordEnv}` : 'no password configured', ok: null },
      { label: 'opencode answers', value: 'once or reject only, by exact request id; a persistent rule is never sent', ok: true },
      { label: 'opencode control', value: 'prompt, stop, one-line question answer and start through the API only (needs the background service; a terminal started with --standalone cannot be reached); never a shell, command or file route', ok: null },
    ];
  }

  revalidate(n: NativeRef): Promise<Revalidation> { return this.exclusive(() => this.revalidateNow(n)); }
  private async revalidateNow(n: NativeRef): Promise<Revalidation> {
    const f = this.forms.get(n.id);
    if (f) {
      const res = await this.http('GET', `/api/session/${f.sessionID}/form/${f.id}`).catch(() => null);
      if (!res || res.status !== 200) return 'gone';
      const b = parse(res.body); const d = isObj(b) && isObj(b.data) ? b.data : null;
      if (!d || !isObj(d.state) || d.state.status !== 'pending') return 'gone';
      return formFingerprint(f.sessionID, f.id, d.fields) === n.fingerprint ? 'live' : 'changed';
    }
    const r = this.reqs.get(n.id);
    if (!r) return 'gone';
    const res = await this.http('GET', `/api/session/${r.sessionID}/permission/${r.id}`).catch(() => null);
    if (!res || res.status === 404) return 'gone';
    if (res.status !== 200) return 'gone';
    const b = parse(res.body); const d = isObj(b) && isObj(b.data) ? b.data : null;
    if (!d) return 'gone';
    return fingerprint(str(d.sessionID), str(d.action), Array.isArray(d.resources) ? d.resources.filter((x): x is string => typeof x === 'string') : []) === n.fingerprint ? 'live' : 'changed';
  }

  release(n: NativeRef): void { this.reqs.delete(n.id); this.forms.delete(n.id); this.posted.delete(n.id); this.posted.delete(`form:${n.id}`); }

  deliver(n: NativeRef, a: Answer, who: { device: string }): Promise<DeliverResult> { return this.exclusive(() => this.deliverNow(n, a, who)); }
  private async deliverNow(n: NativeRef, a: Answer, who: { device: string }): Promise<DeliverResult> {
    const r = this.reqs.get(n.id);
    if (!r) return 'gone';
    if (a.t !== 'permission') return 'unsupported';
    // the whole body, built from literals: the decision is one of two words, the reason (deny only) is fixed words plus a host preset
    const body = a.behavior === 'allow'
      ? { decision: 'once' as const }
      : { decision: 'reject' as const, message: `Denied from "${safeDeviceName(who.device)}" via Botwarren Companion${a.message ? `: ${a.message}` : ''}` };
    const res = await this.http('POST', `/api/session/${r.sessionID}/permission/${r.id}/reply`, body).catch(() => null);
    if (!res) return 'failed';
    if (res.status === 404) return 'gone';
    if (res.status !== 204 && res.status !== 200) return 'failed';
    // the tool's own follow-up, asked for right now: the request must be gone (an exact-id answer was accepted)
    if (a.behavior === 'allow') {
      const after = await this.http('GET', `/api/session/${r.sessionID}/permission/${r.id}`).catch(() => null);
      if (after && after.status === 404) this.ctx?.report.resolved(n, 'allowed');
    }
    return 'delivered';
  }

  // ------------------------------------------------------------------ control (protocol 3)
  /** the host has already decided; here only: is this a control call we can make, and is the server really OpenCode (a lone control call after a restart re-identifies first) */
  private async ready(): Promise<boolean> {
    if (!this.ctx || this.stopped) return false;
    if (!this.identified && (await this.identify()) !== 'ok') return false;
    return this.isVerified();
  }
  /** the session id inside a key the host passes back; only a session this adapter itself reported is accepted */
  private sidOf(key: string): string | null {
    const m = SESSION_KEY.exec(key);
    return m && this.own.has(key) ? m[1]! : null;
  }
  private status(res: HttpResult | null): ControlDelivery | 'ok' {
    if (!res) return 'failed';
    if (res.status === 200 || res.status === 204) return 'ok';
    if (res.status === 404) return 'gone';
    if (res.status === 409) return 'busy';
    return 'failed';
  }

  /** `POST /api/session/{id}/prompt` with `{text, delivery:'queue'}`: queued behind a running turn (never steers into it), starts a turn at once on an idle session. The text is the host's framed text, unchanged. */
  async sendPrompt(sessionKey: string, p: ControlPrompt, _who: { device: string }): Promise<ControlDelivery> {
    const sid = this.sidOf(sessionKey);
    if (!sid) return 'gone';
    return this.exclusive(async () => {
      if (!(await this.ready())) return this.identified ? 'unsupported' : 'failed';
      return (await this.promptNow(sessionKey, sid, p.framed)).result;
    });
  }

  private async promptNow(key: string, sid: string, text: ControlText): Promise<{ result: ControlDelivery }> {
    const res = await this.http('POST', `/api/session/${sid}/prompt`, { text, delivery: 'queue' }).catch(() => null);
    const st = this.status(res);
    if (st !== 'ok') { this.ctx?.audit('opencode_control', { op: 'prompt', ok: false, status: res?.status ?? 0 }); return { result: st }; }
    const b = parse(res!.body); const d = isObj(b) && isObj(b.data) ? b.data : null;
    const mid = d ? str(d.id) : '';
    // OpenCode's own proof: the message is now stored in the session (the same id comes back from `message.get`)
    if (MSG_ID.test(mid)) this.later(async () => {
      const g = await this.http('GET', `/api/session/${sid}/message/${mid}`).catch(() => null);
      const gb = g && g.status === 200 ? parse(g.body) : null;
      if (isObj(gb) && isObj(gb.data) && gb.data.id === mid) this.ctx?.report.followup(key, 'prompt');
    });
    return { result: 'delivered' };
  }

  /** `POST /api/session/{id}/interrupt` -> `{interrupted: boolean}`; the follow-up is claimed only when the session is really no longer running */
  async interrupt(sessionKey: string, _who: { device: string }): Promise<ControlDelivery> {
    const sid = this.sidOf(sessionKey);
    if (!sid) return 'gone';
    return this.exclusive(async () => {
      if (!(await this.ready())) return this.identified ? 'unsupported' : 'failed';
      const res = await this.http('POST', `/api/session/${sid}/interrupt`).catch(() => null);
      const st = this.status(res);
      if (st !== 'ok') { this.ctx?.audit('opencode_control', { op: 'interrupt', ok: false, status: res?.status ?? 0 }); return st; }
      const b = parse(res!.body);
      if (isObj(b) && b.interrupted === true) this.later(async () => {
        for (let i = 0; i < 6; i++) {
          const act = await this.http('GET', '/api/session/active').catch(() => null);
          const ab = act && act.status === 200 ? parse(act.body) : undefined;
          if (isObj(ab) && isObj(ab.data) && !(sid in ab.data)) { this.ctx?.report.followup(sessionKey, 'interrupt'); return; }
          await sleep(250);
        }
      });
      return 'delivered'; // `interrupted:false` = nothing was running: accepted, but no follow-up is claimed
    });
  }

  /** `POST /api/session/{id}/form/{formID}/reply` with `{answer: {<the form's one field>: text}}`, only for a form that is exactly one free-text field */
  async answerText(n: NativeRef, text: ControlText, _who: { device: string }): Promise<ControlDelivery> {
    const f = this.forms.get(n.id);
    if (!f) return 'gone';
    if (!f.text) return 'unsupported';
    const field = f.text;
    return this.exclusive(async () => {
      if (!(await this.ready())) return this.identified ? 'unsupported' : 'failed';
      if (field.maxLength !== undefined && [...text].length > field.maxLength) return 'failed';
      const res = await this.http('POST', `/api/session/${f.sessionID}/form/${f.id}/reply`, { answer: { [field.key]: text } }).catch(() => null);
      const st = this.status(res);
      if (st === 'busy') return 'gone'; // 409: already settled (answered at the terminal a moment ago)
      if (st !== 'ok') { this.ctx?.audit('opencode_control', { op: 'answer', ok: false, status: res?.status ?? 0 }); return st; }
      const key = `opencode:${f.sessionID}`;
      this.later(async () => {
        const g = await this.http('GET', `/api/session/${f.sessionID}/form/${f.id}`).catch(() => null);
        const gb = g && g.status === 200 ? parse(g.body) : null;
        const state = isObj(gb) && isObj(gb.data) && isObj(gb.data.state) ? gb.data.state : null;
        if (state && state.status === 'answered') { this.ctx?.report.followup(key, 'answer'); this.ctx?.report.cleared(key, 'answered_local', f.id); this.release({ adapter: OPENCODE_ID, kind: 'request_id', id: f.id, fingerprint: f.fingerprint }); }
      });
      return 'delivered';
    });
  }

  /**
   * `POST /api/session` with `{location:{directory: <launch root>}, permissions:[ask everything], agent?:'plan'}`, then the optional first prompt. `default` asks before
   * every tool; `plan` selects OpenCode's read-only `plan` agent on top of that; `acceptEdits` has no verified OpenCode rule semantics and is refused (`unsupported`).
   * The folder is the host launch entry's, checked to exist, and never anything a device sent.
   */
  async startSession(launch: LaunchSpec, text: ControlPrompt | null, _who: { device: string }): Promise<{ result: ControlDelivery; sessionKey?: string }> {
    if (launch.harness !== 'opencode' || (launch.mode !== 'default' && launch.mode !== 'plan')) return { result: 'unsupported' };
    const root = launch.root;
    if (!isAbsolute(root) || /[\0\r\n]/.test(root) || root.length > 1000) return { result: 'failed' };
    try { if (!statSync(root).isDirectory()) return { result: 'failed' }; } catch { return { result: 'failed' }; }
    return this.exclusive(async () => {
      if (!(await this.ready())) return { result: this.identified ? 'unsupported' as const : 'failed' as const };
      const body = { location: { directory: root }, permissions: ASK_EVERYTHING, ...(launch.mode === 'plan' ? { agent: 'plan' } : {}) };
      const res = await this.http('POST', '/api/session', body).catch(() => null);
      const st = this.status(res);
      if (st !== 'ok') { this.ctx?.audit('opencode_control', { op: 'start', ok: false, status: res?.status ?? 0 }); return { result: st === 'gone' ? 'failed' as const : st }; }
      const b = parse(res!.body); const d = isObj(b) && isObj(b.data) ? b.data : null;
      const sid = d ? str(d.id) : '';
      if (!new RegExp(`^${SES}$`).test(sid)) return { result: 'failed' as const };
      const key = `opencode:${sid}`;
      // reported at once, so the host knows the key before it is returned
      this.own.set(key, this.ctx!.now());
      this.ctx!.report.session({ key, agent: 'opencode', cwd: root, label: basename(root) || 'project', status: 'idle', mode: 'normal' });
      this.ctx!.report.changed(true);
      if (text) {
        const r = await this.promptNow(key, sid, text.framed);
        if (r.result !== 'delivered') return { result: r.result, sessionKey: key };
      }
      return { result: 'delivered' as const, sessionKey: key };
    });
  }

  // ------------------------------------------------------------------ polling
  /** one poll; a poll asked for while another is running waits for it and then runs again (so data that changed meanwhile is never missed until the next timer tick) */
  poll(): Promise<void> { return this.exclusive(() => this.pollOnce()); }

  private async pollOnce(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx || !ctx.config().enabled || this.stopped) return;
    const s = await this.identify();
    if (s !== 'ok') { if (this.lastNote !== s) { this.lastNote = s; ctx.audit('state', { state: s }); } return; }
    this.lastNote = 'ok';
    const verified = this.isVerified();
    const now = ctx.now();
    // sessions (most recent first), their folders, and which are running
    const sl = await this.http('GET', '/api/session');
    const list = isObj(parse(sl?.body ?? '')) && Array.isArray((parse(sl!.body) as { data?: unknown }).data) ? ((parse(sl!.body) as { data: unknown[] }).data.filter(isObj)) : [];
    const act = await this.http('GET', '/api/session/active');
    const actData = isObj(parse(act?.body ?? '')) ? (parse(act!.body) as { data?: unknown }).data : null;
    const running = new Set(isObj(actData) ? Object.keys(actData) : []);
    const dirs = new Set<string>(['']);
    const sessions = new Map<string, { dir: string; updated: number; mode: 'normal' | 'bypass' | undefined }>();
    for (const x of list.slice(0, 60)) {
      const id = str(x.id); const dir = isObj(x.location) ? str(x.location.directory) : '';
      const updated = isObj(x.time) && typeof x.time.updated === 'number' ? x.time.updated : 0;
      if (!ID.test(id)) continue;
      sessions.set(id, { dir, updated, mode: sessionMode(x.permissions) });
      if (dir && now - updated < 6 * 3_600_000 && dirs.size < 8) dirs.add(dir);
    }
    // pending permission requests and questions, per folder (OpenCode scopes both lists to a folder)
    const pending: Req[] = []; const asking = new Map<string, Form>();
    for (const dir of dirs) {
      const q = dir ? `?location%5Bdirectory%5D=${encodeURIComponent(dir)}` : '';
      const pr = await this.http('GET', `/api/permission/request${q}`);
      const items = isObj(parse(pr?.body ?? '')) && Array.isArray((parse(pr!.body) as { data?: unknown }).data) ? (parse(pr!.body) as { data: unknown[] }).data.filter(isObj) : [];
      for (const it of items) {
        const id = str(it.id); const sessionID = str(it.sessionID);
        if (!ID.test(id) || !ID.test(sessionID)) continue;
        const resources = Array.isArray(it.resources) ? it.resources.filter((v): v is string => typeof v === 'string').slice(0, 20) : [];
        const meta = isObj(it.metadata) ? it.metadata : {};
        pending.push({ id, sessionID, action: str(it.action), resources, message: str(it.message), description: str(meta.description), dir: dir || sessions.get(sessionID)?.dir || '', fingerprint: fingerprint(sessionID, str(it.action), resources) });
      }
      const fr = await this.http('GET', `/api/form${q}`);
      const forms = isObj(parse(fr?.body ?? '')) && Array.isArray((parse(fr!.body) as { data?: unknown }).data) ? (parse(fr!.body) as { data: unknown[] }).data.filter(isObj) : [];
      for (const f of forms) {
        const sid = str(f.sessionID); const id = str(f.id);
        if (!ID.test(sid) || !ID.test(id) || asking.has(sid)) continue; // the oldest form of a session is shown first; the next one when it is gone
        asking.set(sid, formOf(f, dir || sessions.get(sid)?.dir || ''));
      }
    }
    const live = new Set<string>();
    let changed = false;
    const reportSession = (sid: string, dir: string, status: 'working' | 'waiting' | 'idle'): void => {
      const key = `opencode:${sid}`; live.add(key); this.own.set(key, now);
      const mode = sessions.get(sid)?.mode;
      ctx.report.session({ key, agent: 'opencode', cwd: dir, label: basename(dir) || 'project', status, ...(mode ? { mode } : {}) });
      const sig = `${status}|${mode ?? ''}`;
      if (this.shownAs.get(key) !== sig) { this.shownAs.set(key, sig); changed = true; }
    };
    for (const [sid, m] of sessions) if (running.has(sid) || pending.some((p) => p.sessionID === sid) || asking.has(sid) || now - m.updated < 15 * 60_000) reportSession(sid, m.dir, pending.some((p) => p.sessionID === sid) || asking.has(sid) ? 'waiting' : running.has(sid) ? 'working' : 'idle');
    if (changed) ctx.report.changed();
    const pendingIds = new Set<string>();
    for (const p of pending) {
      pendingIds.add(p.id);
      this.reqs.set(p.id, p);
      if (!this.posted.has(p.id)) {
        this.posted.add(p.id);
        if (!live.has(`opencode:${p.sessionID}`)) reportSession(p.sessionID, p.dir, 'waiting');
        await ctx.report.pending(this.report(p, verified));
        ctx.report.changed(true);
      }
    }
    // forms (questions): answerable from a paired device only when the form is exactly one free-text line and the version is verified; otherwise shown read-only
    const askingIds = new Set<string>();
    for (const [sid, f] of asking) {
      const key = `opencode:${sid}`; askingIds.add(f.id);
      this.forms.set(f.id, f);
      if (!pending.some((p) => p.sessionID === sid) && !this.posted.has(`form:${f.id}`)) {
        this.posted.add(`form:${f.id}`);
        const native: NativeRef | null = verified && f.text ? { adapter: OPENCODE_ID, kind: 'request_id', id: f.id, fingerprint: f.fingerprint } : null;
        await ctx.report.pending({ sessionKey: key, kind: 'question', summary: clip(f.title || 'OpenCode asks a question', 200), preview: f.preview, ttlMs: 30 * 60_000, native, can: { approve: false, reply: false }, risk: [], source: 'structured', onlyIfNone: true });
        ctx.report.changed(true);
      }
    }
    // requests that are gone (answered at the terminal, or by us): let the card go
    for (const id of [...this.posted]) {
      if (id.startsWith('form:')) {
        const fid = id.slice(5);
        if (askingIds.has(fid)) continue;
        this.posted.delete(id);
        const f = this.forms.get(fid); this.forms.delete(fid);
        // a card that carried this form's native id is cleared by it; a read-only card only when no permission request holds the session
        const own = !!f && !!f.text && verified;
        if (f && (own || !pending.some((p) => p.sessionID === f.sessionID)) && ctx.report.cleared(`opencode:${f.sessionID}`, 'answered_local', own ? fid : undefined, own ? undefined : 'structured')) ctx.report.changed(true);
        continue;
      }
      if (!pendingIds.has(id)) {
        const r = this.reqs.get(id); this.posted.delete(id); this.reqs.delete(id);
        if (r && ctx.report.cleared(`opencode:${r.sessionID}`, 'answered_local', id)) ctx.report.changed(true);
      }
    }
    // the live tail: only for the newest few sessions that changed (or are running), and only while a device is paired
    if (verified && ctx.facts().devices > 0) {
      const order = [...sessions].filter(([sid]) => live.has(`opencode:${sid}`)).sort((a, b) => Number(running.has(b[0])) - Number(running.has(a[0])) || b[1].updated - a[1].updated).slice(0, TAIL_SESSIONS);
      for (const [sid, m] of order) await this.tailSession(ctx, sid, m.updated, running.has(sid), now);
    }
    for (const [key, last] of [...this.own]) if (!live.has(key) && now - last > 30_000) { this.own.delete(key); this.tails.delete(key); this.shownAs.delete(key); ctx.report.cleared(key, 'ended'); ctx.report.session({ key, agent: 'opencode', status: 'ended' }); }
  }

  /** newest messages of one session -> tail lines not emitted before, oldest first */
  private async tailSession(ctx: AdapterContext, sid: string, updated: number, isRunning: boolean, now: number): Promise<void> {
    const key = `opencode:${sid}`;
    let st = this.tails.get(key);
    if (!st) { st = { emitted: new Map(), updated: -1, primed: false, wasRunning: false }; this.tails.set(key, st); }
    if (st.primed && !isRunning && !st.wasRunning && updated <= st.updated) return; // nothing new since the last read (a session that has just stopped is read once more: its last message completes after the last poll that saw it running)
    const res = await this.http('GET', `/api/session/${sid}/message?order=desc&limit=${TAIL_FETCH}`).catch(() => null);
    if (!res || res.status !== 200) return;
    const b = parse(res.body); const msgs = isObj(b) && Array.isArray(b.data) ? [...b.data].reverse() : [];
    const items: { k: TailKind; text: string; ts: number }[] = [];
    for (const m of msgs) for (const l of messageLines(m, now)) {
      if (st.emitted.has(l.id)) continue;
      st.emitted.set(l.id, true); items.push({ k: l.k, text: l.text, ts: l.ts });
    }
    while (st.emitted.size > 600) st.emitted.delete(st.emitted.keys().next().value as string);
    st.updated = updated; st.primed = true; st.wasRunning = isRunning;
    if (items.length) { ctx.report.tail(key, items); ctx.report.changed(); }
  }

  private report(p: Req, verified: boolean): PendingReport {
    const risk = new Set<RiskTag>();
    if (/external[_-]?directory/i.test(p.action)) risk.add('outside_workspace');
    if (NETWORK_ACTIONS.test(p.action)) risk.add('network');
    if (/^bash$/i.test(p.action)) for (const r of p.resources.flatMap((c) => commandRisks(c, p.dir))) risk.add(r);
    else if (/^(edit|write|patch|read)/i.test(p.action)) for (const r of p.resources) { if (p.dir && outsideWorkspace(p.dir, r)) risk.add('outside_workspace'); }
    else if (!/^(bash|edit|write|patch|read|glob|grep|list|task|todo)/i.test(p.action) && !risk.size) risk.add('unknown_tool');
    const native: NativeRef = { adapter: OPENCODE_ID, kind: 'request_id', id: p.id, fingerprint: p.fingerprint };
    return {
      sessionKey: `opencode:${p.sessionID}`, kind: 'permission', tool: p.action || 'permission',
      summary: clip(p.message || p.description || `OpenCode asks to use ${p.action || 'a tool'}`, 200), preview: p.resources.join('\n'), ttlMs: 30 * 60_000,
      native: verified ? native : null, can: { approve: verified, reply: false }, denyWithPreset: verified, risk: [...risk], source: 'structured',
    };
  }
}

export function fingerprint(sessionID: string, action: string, resources: readonly string[]): string {
  return createHash('sha256').update([sessionID, action, JSON.stringify(resources)].join('\u0000')).digest('hex');
}
function formFingerprint(sessionID: string, formID: string, fields: unknown): string {
  return createHash('sha256').update([sessionID, formID, JSON.stringify(fields ?? [])].join('\u0000')).digest('hex');
}

/** a session whose permission rules allow everything runs without approval prompts; one whose rules do not is normal; no rules = unknown (the config decides) */
function sessionMode(permissions: unknown): 'normal' | 'bypass' | undefined {
  if (!Array.isArray(permissions) || !permissions.length) return undefined;
  return permissions.some((r) => isObj(r) && r.effect === 'allow' && r.action === '*' && r.resource === '*') ? 'bypass' : 'normal';
}

/** a pending form from `GET /api/form`; `text` is set only for a form that is exactly one free-text field (a string field with no fixed options, or with `custom` allowed) */
function formOf(f: Record<string, unknown>, dir: string): Form {
  const id = str(f.id); const sessionID = str(f.sessionID);
  const fields = Array.isArray(f.fields) ? f.fields.filter(isObj) : [];
  const one = fields.length === 1 ? fields[0]! : null;
  const options = one && Array.isArray(one.options) ? one.options : [];
  const free = !!one && one.type === 'string' && one.hidden !== true && !/^(email|uri|date|date-time)$/.test(str(one.format)) && (options.length === 0 || one.custom === true) && /^[A-Za-z0-9_.-]{1,80}$/.test(str(one.key));
  const preview = fields.map((x) => [str(x.title) || str(x.key), str(x.description), str(x.placeholder)].filter(Boolean).join(' - ')).filter(Boolean).join('\n');
  return {
    id, sessionID, title: str(f.title), dir, fingerprint: formFingerprint(sessionID, id, f.fields), preview: clip(preview, 400),
    text: free ? { key: str(one!.key), ...(typeof one!.maxLength === 'number' && one!.maxLength > 0 ? { maxLength: one!.maxLength } : {}) } : null,
  };
}

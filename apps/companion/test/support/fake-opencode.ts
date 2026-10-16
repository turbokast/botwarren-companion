/**
 * A fake OpenCode v2 server in the shapes recorded from a REAL opencode 2.0.21 in the lab (test/support/fixtures/opencode-v2-shapes.json, written by
 * test/lab/opencode-probe.mjs): HTTP Basic password, `{data: ...}` wrappers, lists scoped by `location[directory]`, permission requests
 * `{id, sessionID, action, resources, save, metadata, source, message?}`, reply -> 204 then 404 `PermissionNotFoundError`, 401 `UnauthorizedError`, and (protocol 3)
 * session create, prompt (200 with the stored message, `delivery` defaulting to `steer`), interrupt (`{interrupted}`), message list/get, form get/reply
 * (204, 409 `FormAlreadySettledError`, 404 `FormNotFoundError`, 400 `FormInvalidAnswerError`). Records every request it receives (headers included) so tests can audit the wire.
 */
import { createServer, type Server } from 'node:http';
import { isAbsolute } from 'node:path';

export interface FakePerm { id: string; sessionID: string; action: string; resources: string[]; save?: string[]; metadata?: Record<string, unknown>; message?: string; dir: string }
export interface FakeMessage { id: string; type: 'user' | 'assistant'; time: { created: number; completed?: number }; text?: string; content?: unknown[]; error?: unknown }
export interface FakeSession { id: string; dir: string; updated?: number; running?: boolean; agent?: string; permissions?: unknown[]; messages?: FakeMessage[] }
export interface FakeFormField { key: string; type: string; title?: string; options?: { value: string; label: string }[]; custom?: boolean; maxLength?: number; [k: string]: unknown }
export interface FakeForm { id: string; sessionID: string; title: string; dir: string; fields?: FakeFormField[]; state?: 'pending' | 'answered' | 'cancelled'; answer?: Record<string, unknown> }
export interface Recorded { method: string; path: string; query: string; body: unknown; authorization: string | undefined }
export interface FakeOpenCode {
  port: number; password: string | null; version: string; sessions: FakeSession[]; perms: FakePerm[]; forms: FakeForm[]; requests: Recorded[];
  /** what a reply did: id -> decision */
  replies: { id: string; body: unknown }[];
  /** bodies of POST /api/session, prompts (per session), interrupts and form replies, as the server received them */
  created: unknown[]; prompts: { sessionID: string; body: unknown }[]; interrupts: string[]; formReplies: { id: string; body: unknown }[];
  /** the next prompt answers 409 (a conflict) */
  promptConflict: boolean;
  /** an assistant message appears in a session (completed unless `done:false`) */
  assistant(sessionID: string, content: unknown[], o?: { done?: boolean; error?: unknown }): FakeMessage;
  close(): Promise<void>;
}

export async function fakeOpenCode(o: { password?: string | null; version?: string; noPassword401?: boolean } = {}): Promise<FakeOpenCode> {
  const me: FakeOpenCode = {
    port: 0, password: o.password === undefined ? 'pw-' + Math.random().toString(36).slice(2) : o.password, version: o.version ?? '2.0.21', sessions: [], perms: [], forms: [], requests: [], replies: [],
    created: [], prompts: [], interrupts: [], formReplies: [], promptConflict: false, assistant: () => ({ id: '', type: 'assistant', time: { created: 0 } }), close: async () => undefined,
  };
  let seq = 0;
  const mid = (): string => `msg_14431f${(++seq).toString(36).padStart(6, '0')}0143SR4BrCsTpssZ`;
  me.assistant = (sessionID, content, x = {}) => {
    const s = me.sessions.find((v) => v.id === sessionID)!;
    const t = Date.now();
    const m: FakeMessage = { id: mid(), type: 'assistant', time: { created: t, ...(x.done === false ? {} : { completed: t }) }, content, ...(x.error ? { error: x.error } : {}) };
    (s.messages ??= []).push(m);
    s.updated = Math.max((s.updated ?? 0) + 1, t); // the real server bumps the session's `time.updated` when a message lands
    return m;
  };
  const send = (res: import('node:http').ServerResponse, status: number, body?: unknown): void => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };
  const publicMsg = (m: FakeMessage): unknown => (m.type === 'user' ? { id: m.id, time: { created: m.time.created }, text: m.text ?? '', type: 'user' } : { id: m.id, time: m.time, type: 'assistant', agent: 'build', model: { id: 'll-alpha-free', providerID: 'opencode' }, content: m.content ?? [], ...(m.error ? { error: m.error } : {}) });
  const formInfo = (f: FakeForm): { id: string; sessionID: string; title: string; fields: unknown[] } => ({ id: f.id, sessionID: f.sessionID, title: f.title, fields: f.fields ?? [] });
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []; req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const u = new URL(req.url ?? '/', 'http://x');
      let body: unknown; const raw = Buffer.concat(chunks).toString('utf8'); if (raw) { try { body = JSON.parse(raw); } catch { body = raw; } }
      me.requests.push({ method: req.method ?? '', path: u.pathname, query: u.search, body, authorization: req.headers.authorization });
      const dir = u.searchParams.get('location[directory]') ?? '/srv/default';
      if (me.password !== null) {
        const want = 'Basic ' + Buffer.from(`opencode:${me.password}`).toString('base64');
        if (req.headers.authorization !== want) return send(res, 401, { _tag: 'UnauthorizedError', message: 'Unauthorized' });
      }
      const path = u.pathname; const method = req.method ?? '';
      if (path === '/api/info') return send(res, 200, { version: me.version, pid: 1, urls: [`http://127.0.0.1:${me.port}`], paths: { tmp: '/tmp/opencode' } });
      if (path === '/api/session' && method === 'POST') {
        const b = (typeof body === 'object' && body ? body : {}) as { location?: { directory?: string }; agent?: string; permissions?: unknown[] };
        const known = new Set(['id', 'agent', 'model', 'location', 'metadata', 'permissions']);
        if (Object.keys(b).some((k) => !known.has(k))) return send(res, 400, { _tag: 'InvalidRequestError', message: 'unexpected field' });
        const d = b.location?.directory ?? '';
        if (!isAbsolute(d)) return send(res, 500); // the real server takes the platform's absolute paths (C:\... on Windows)
        me.created.push(body);
        const id = `ses_ebbce2b1d${(++seq).toString(36).padStart(4, '0')}fe1S0z5sMVLZs5VF`;
        const s: FakeSession = { id, dir: d, updated: Date.now(), ...(b.agent ? { agent: b.agent } : {}), ...(b.permissions ? { permissions: b.permissions } : {}) };
        me.sessions.push(s);
        return send(res, 200, { data: { id, projectID: 'proj0000', ...(b.agent ? { agent: b.agent } : {}), cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: s.updated, updated: s.updated }, ...(b.permissions ? { permissions: b.permissions } : {}), location: { directory: d } } });
      }
      if (path === '/api/session') return send(res, 200, { data: me.sessions.map((s) => ((s.updated ??= Date.now()), s)).map((s) => ({ id: s.id, projectID: 'p', cost: 0, ...(s.permissions ? { permissions: s.permissions } : {}), time: { created: s.updated ?? Date.now(), updated: s.updated ?? Date.now() }, location: { directory: s.dir }, title: 'PRIVATE-SESSION-TITLE-CANARY' })), cursor: { previous: null, next: null } });
      if (path === '/api/session/active') return send(res, 200, { data: Object.fromEntries(me.sessions.filter((s) => s.running).map((s) => [s.id, { type: 'running' }])) });
      if (path === '/api/permission/request') return send(res, 200, { location: { directory: dir }, data: me.perms.filter((p) => p.dir === dir).map(({ dir: _d, ...p }) => ({ save: [], metadata: {}, source: { type: 'tool', messageID: 'msg_1', id: 'call_1' }, ...p })) });
      if (path === '/api/form') return send(res, 200, { location: { directory: dir }, data: me.forms.filter((f) => f.dir === dir && (f.state ?? 'pending') === 'pending').map(formInfo) });
      // ---- per session
      const sm = /^\/api\/session\/(ses[A-Za-z0-9_]+)(\/.*)?$/.exec(path);
      if (sm) {
        const sid = sm[1]!; const rest = sm[2] ?? '';
        const s = me.sessions.find((x) => x.id === sid);
        const nf = { _tag: 'SessionNotFoundError', sessionID: sid, message: `Session not found: ${sid}` };
        if (rest === '/prompt' && method === 'POST') {
          if (!s) return send(res, 404, nf);
          const b = (typeof body === 'object' && body ? body : null) as { text?: unknown; delivery?: unknown } | null;
          if (!b || typeof b.text !== 'string') return send(res, 400, { _tag: 'InvalidRequestError', message: 'text required' });
          if (me.promptConflict) { me.promptConflict = false; return send(res, 409, { _tag: 'ConflictError', message: 'conflict' }); }
          me.prompts.push({ sessionID: sid, body });
          const t = Date.now(); const m: FakeMessage = { id: mid(), type: 'user', time: { created: t }, text: b.text };
          (s.messages ??= []).push(m); s.running = true; s.updated = t;
          const delivery = b.delivery === 'queue' ? 'queue' : 'steer';
          return send(res, 200, { data: { id: m.id, sessionID: sid, time: { created: t }, type: 'user', payload: { text: b.text }, delivery } });
        }
        if (rest === '/interrupt' && method === 'POST') {
          if (!s) return send(res, 404, nf);
          me.interrupts.push(sid); const was = !!s.running; s.running = false;
          return send(res, 200, { interrupted: was });
        }
        if (rest === '/message' && method === 'GET') {
          if (!s) return send(res, 404, nf);
          const limit = Number(u.searchParams.get('limit') ?? '50') || 50;
          const all = [...(s.messages ?? [])];
          const list = u.searchParams.get('order') === 'desc' ? all.reverse() : all;
          return send(res, 200, { data: list.slice(0, limit).map(publicMsg), cursor: { previous: 'CURSOR', next: 'CURSOR' } });
        }
        const mm = /^\/message\/(msg_[A-Za-z0-9_]+)$/.exec(rest);
        if (mm && method === 'GET') {
          if (!s) return send(res, 404, nf);
          const m = (s.messages ?? []).find((x) => x.id === mm[1]);
          return m ? send(res, 200, { data: publicMsg(m) }) : send(res, 404, { _tag: 'MessageNotFoundError', sessionID: sid, messageID: mm[1], message: 'Message not found' });
        }
        const fm = /^\/form\/(frm[A-Za-z0-9_]+)(\/reply)?$/.exec(rest);
        if (fm) {
          if (!s) return send(res, 404, nf);
          const f = me.forms.find((x) => x.id === fm[1] && x.sessionID === sid);
          if (!f) return send(res, 404, { _tag: 'FormNotFoundError', id: fm[1], message: `Form not found: ${fm[1]}` });
          if (method === 'GET' && !fm[2]) return send(res, 200, { data: { ...formInfo(f), state: f.state === 'answered' ? { status: 'answered', answer: f.answer ?? {} } : f.state === 'cancelled' ? { status: 'cancelled' } : { status: 'pending' } } });
          if (method === 'POST' && fm[2]) {
            if ((f.state ?? 'pending') !== 'pending') return send(res, 409, { _tag: 'FormAlreadySettledError', id: f.id, message: `Form already settled: ${f.id}` });
            const answer = ((body as { answer?: Record<string, unknown> } | undefined)?.answer ?? {}) as Record<string, unknown>;
            for (const field of f.fields ?? []) {
              const v = answer[field.key];
              if (field.options?.length && field.custom !== true && !field.options.some((op) => op.value === v)) return send(res, 400, { _tag: 'FormInvalidAnswerError', id: f.id, message: `Invalid option for form field: ${field.key}` });
              if (typeof v === 'string' && field.maxLength && v.length > field.maxLength) return send(res, 400, { _tag: 'FormInvalidAnswerError', id: f.id, message: `Too long: ${field.key}` });
            }
            me.formReplies.push({ id: f.id, body });
            f.state = 'answered'; f.answer = answer;
            return send(res, 204);
          }
        }
        const pm = /^\/permission\/(per[A-Za-z0-9_]+)(\/reply)?$/.exec(rest);
        if (pm) {
          const p = me.perms.find((x) => x.id === pm[1] && x.sessionID === sid);
          if (!p) return send(res, 404, { _tag: 'PermissionNotFoundError', requestID: pm[1], message: `Permission request not found: ${pm[1]}` });
          if (method === 'GET' && !pm[2]) { const { dir: _d, ...r } = p; return send(res, 200, { data: { save: [], metadata: {}, source: { type: 'tool', messageID: 'msg_1', id: 'call_1' }, ...r } }); }
          if (method === 'POST' && pm[2]) { me.replies.push({ id: p.id, body }); me.perms = me.perms.filter((x) => x !== p); return send(res, 204); }
        }
      }
      return send(res, 404, { _tag: 'NotFound' });
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
  me.port = (server.address() as { port: number }).port;
  me.close = () => new Promise<void>((ok) => { server.close(() => ok()); server.closeAllConnections(); });
  return me;
}

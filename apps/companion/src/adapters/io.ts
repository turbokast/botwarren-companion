/**
 * The only way an adapter touches the machine besides the hook socket: running a tool's own command-line with a FIXED argument list (no shell, no
 * user text), and loopback HTTP / local sockets for the tools that have them. Everything here is local: there is no function that can reach another
 * computer. A test (adapters.lint.test.ts) fails if any other file under src/adapters/ imports `node:net`, `node:http(s)`, `node:child_process` or `node:dgram`.
 * Licence: Apache-2.0.
 */
import { execFile, spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { createConnection } from 'node:net';

/** the arguments must be plain words: they are fixed in our own code, never built from anything a tool or a phone says */
const SAFE_ARG = /^[A-Za-z0-9][A-Za-z0-9._=:/-]*$|^--?[A-Za-z0-9][A-Za-z0-9._=-]*$/;
const SAFE_BIN = /^[A-Za-z0-9._-]{1,40}$/;

export interface CliResult { ok: boolean; stdout: string; code: number | null }

/** `bin args...` with no shell; on Windows the `.cmd` shim needs one, which is safe only because bin and args are checked to be plain words */
export function runCli(bin: string, args: readonly string[], o: { timeoutMs?: number; env?: Record<string, string | undefined> } = {}): Promise<CliResult> {
  if (!SAFE_BIN.test(bin) || !args.every((a) => SAFE_ARG.test(a))) return Promise.resolve({ ok: false, stdout: '', code: null });
  return new Promise((resolve) => {
    execFile(bin, [...args], { timeout: o.timeoutMs ?? 5000, maxBuffer: 256 * 1024, shell: process.platform === 'win32', windowsHide: true, env: { ...process.env, ...(o.env ?? {}) } as NodeJS.ProcessEnv }, (err, stdout) => {
      const code = err && typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : err ? null : 0;
      resolve({ ok: !err, stdout: String(stdout ?? ''), code });
    });
  });
}

/**
 * Like runCli, plus ONE absolute path argument (a folder this companion wrote, e.g. the Muse plugin directory) that cannot be checked as a plain word.
 * Not available on Windows, where a `.cmd` shim would need a shell: the command is printed for the person to run instead.
 */
export function runCliWithPath(bin: string, args: readonly string[], path: string, o: { timeoutMs?: number; env?: Record<string, string | undefined> } = {}): Promise<CliResult> {
  const ok = process.platform !== 'win32' && SAFE_BIN.test(bin) && args.every((a) => SAFE_ARG.test(a)) && path.startsWith('/') && !path.startsWith('-') && !/[\0\n\r]/.test(path) && path.length < 500;
  if (!ok) return Promise.resolve({ ok: false, stdout: '', code: null });
  return new Promise((resolve) => {
    execFile(bin, [...args.slice(0, 2), path, ...args.slice(2)], { timeout: o.timeoutMs ?? 20_000, maxBuffer: 512 * 1024, shell: false, env: { ...process.env, ...(o.env ?? {}) } as NodeJS.ProcessEnv }, (err, stdout) => resolve({ ok: !err, stdout: String(stdout ?? ''), code: err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : err ? null : 0 }));
  });
}

/** "codex-cli 0.162.1" or "Muse Code 1.4.8 (1.4.8-R6256.1)" -> "0.162.1" / "1.4.8": the first dotted version in the output */
export const firstVersion = (s: string): string | null => /\b(\d+\.\d+\.\d+)\b/.exec(s)?.[1] ?? null;

/** a version cache for `<bin> --version`, refreshed every few minutes (a tool updates itself while the daemon runs) */
export function versionProbe(bin: string, ttlMs = 5 * 60_000): () => Promise<string | null> {
  let at = 0; let cached: string | null = null; let inflight: Promise<string | null> | null = null;
  return () => {
    if (Date.now() - at < ttlMs) return Promise.resolve(cached);
    inflight ??= runCli(bin, ['--version'], { timeoutMs: 4000 }).then((r) => { cached = r.ok ? firstVersion(r.stdout) : null; at = Date.now(); inflight = null; return cached; });
    return inflight;
  };
}

/**
 * Asks `codex app-server` (stdio, started by us for a moment) which hooks Codex knows and whether each is trusted. Used only by `doctor`.
 * Returns null when Codex or its app-server is not available.
 */
export interface ListedHook { command: string; eventName: string; trustStatus: string; sourcePath: string }
export function codexHooksList(cwd: string, o: { timeoutMs?: number; env?: Record<string, string | undefined> } = {}): Promise<ListedHook[] | null> {
  return new Promise((resolve) => {
    const child = spawn('codex', ['app-server'], { cwd, stdio: ['pipe', 'pipe', 'ignore'], shell: process.platform === 'win32', windowsHide: true, env: { ...process.env, ...(o.env ?? {}) } as NodeJS.ProcessEnv });
    let buf = ''; let done = false; let phase = 0;
    const finish = (v: ListedHook[] | null): void => { if (done) return; done = true; clearTimeout(timer); try { child.kill(); } catch { /* gone */ } resolve(v); };
    const timer = setTimeout(() => finish(null), o.timeoutMs ?? 10_000);
    child.on('error', () => finish(null));
    child.on('close', () => finish(null));
    const send = (m: unknown): void => { try { child.stdin.write(JSON.stringify(m) + '\n'); } catch { finish(null); } };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c: string) => {
      buf += c; let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m: { id?: number; result?: { data?: { hooks?: { command?: string; eventName?: string; trustStatus?: string; sourcePath?: string; handlerType?: string }[] }[] } };
        try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1 && phase === 0) { phase = 1; send({ jsonrpc: '2.0', method: 'initialized' }); send({ jsonrpc: '2.0', id: 2, method: 'hooks/list', params: { cwds: [cwd] } }); }
        else if (m.id === 2) {
          const hooks = (m.result?.data ?? []).flatMap((e) => e.hooks ?? []).filter((h) => h.handlerType === 'command' && typeof h.command === 'string');
          finish(hooks.map((h) => ({ command: h.command!, eventName: String(h.eventName), trustStatus: String(h.trustStatus), sourcePath: String(h.sourcePath) })));
        }
      }
    });
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'botwarren-companion', version: '0' }, capabilities: {} } });
  });
}

// ------------------------------------------------------------------ loopback HTTP and local sockets (OpenCode, Ninox, Herdr)

export interface HttpResult { status: number; body: string }

/**
 * One loopback HTTP request. Only 127.0.0.1 / ::1 / localhost, no redirects followed, 2 MB cap, a timeout. `headers` may carry a Basic password
 * the person opted in to (OpenCode); it is never logged.
 */
export function loopbackHttp(o: { port: number; method: 'GET' | 'POST'; path: string; body?: string; headers?: Record<string, string>; timeoutMs?: number; host?: '127.0.0.1' | '::1' }): Promise<HttpResult | null> {
  if (!/^\/[A-Za-z0-9_./%?&=:,-]*$/.test(o.path) || o.port < 1 || o.port > 65535) return Promise.resolve(null);
  return new Promise((resolve) => {
    const req = httpRequest({ host: o.host ?? '127.0.0.1', port: o.port, method: o.method, path: o.path, headers: { ...(o.body !== undefined ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(o.body)) } : {}), ...(o.headers ?? {}) }, timeout: o.timeoutMs ?? 4000 }, (res) => {
      const chunks: Buffer[] = []; let n = 0;
      res.on('data', (c: Buffer) => { n += c.length; if (n > 2 * 1024 * 1024) { req.destroy(); resolve(null); return; } chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', () => resolve(null));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    if (o.body !== undefined) req.write(o.body);
    req.end();
  });
}

/** one newline-delimited JSON request/response over a local Unix socket (Herdr). Resolves the first line the peer sends back, or null. */
export function unixSocketRequest(path: string, request: unknown, timeoutMs = 3000): Promise<unknown | null> {
  return new Promise((resolve) => {
    const sock = createConnection(path);
    let buf = ''; let done = false;
    const finish = (v: unknown | null): void => { if (done) return; done = true; clearTimeout(t); sock.destroy(); resolve(v); };
    const t = setTimeout(() => finish(null), timeoutMs);
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(JSON.stringify(request) + '\n'));
    sock.on('data', (c: string) => { buf += c; const i = buf.indexOf('\n'); if (i >= 0) { try { finish(JSON.parse(buf.slice(0, i))); } catch { finish(null); } } });
    sock.on('error', () => finish(null));
    sock.on('close', () => finish(null));
  });
}

/**
 * The Botwarren Companion relay. It carries opaque, signed frames between a user's host and that user's paired devices.
 * It cannot decrypt (it has no key) and cannot forge (frames are signed by the sender's key, which it never holds).
 *
 * What it keeps: nothing durable. An in-memory queue of ciphertext frames for offline recipients (default 15 minutes), the open
 * sockets, short-lived pairing rendezvous entries, rate-limit counters. What it logs: counters and fixed error codes, never a frame,
 * header, id, name, ticket, address or key. See docs/PROTOCOL.md section 7.
 * Licence: Apache-2.0.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket, type RawData } from 'ws';
import {
  MAX_FRAME_BYTES, SignedSchema, b64u, randomBytes, unb64u, verifyAuth, verifyDeviceCert, verifyFrameSignature, verifyRevocation, verifyTicket, type Bytes,
} from '@botwarren/companion/protocol';
import { KeyedLimiter, TokenBucket } from './limits.ts';
import { KillState, fetchKillList, type KillScope } from './kill.ts';
import { MAX_ALERT_BYTES, deliver, pushOrigin, type VapidKeys } from './webpush.ts';

export interface RelayConfig {
  port: number;
  host?: string;
  /** the public origin clients sign into their auth proof, e.g. https://relay.botwarren.com (set after listen in tests) */
  origin?: string;
  /** raw 32-byte Ed25519 public keys of the botwarren.com ticket signers */
  ticketKeys: Bytes[];
  adminToken?: string;
  killListUrl?: string;
  killListPollMs?: number;
  /** directory of the signed web client to serve at / (optional) */
  clientDir?: string;
  queueTtlMs?: number;
  maxQueueFrames?: number;
  maxQueueBytes?: number;
  /** frames without a replace key that one sender may have queued for one recipient (default 12): the oldest beyond it is dropped (counter `queue_trimmed`) */
  maxUnkeyedPerSender?: number;
  /** distinct replace keys one sender may have queued for one recipient (default 8) */
  maxKeyedPerSender?: number;
  maxAcctQueuedFrames?: number;
  /** frame rate limits (tests raise them; the defaults are the production values) */
  rates?: { connBurst?: number; connPerSec?: number; acctBurst?: number; acctPerSec?: number };
  maxHostsPerAcct?: number;
  maxDevicesPerAcct?: number;
  maxConnections?: number;
  /** read the client IP from Fly-Client-IP (only behind Fly's proxy) */
  trustFlyProxy?: boolean;
  now?: () => number;
  /** receives fixed-code log lines only */
  logSink?: (line: string) => void;
  fetchImpl?: typeof fetch;
  globalKill?: boolean;
  /** phone alerts: the relay's VAPID key pair (it signs the delivery of alerts the companion sealed). Without it alerts are off and the page does not offer them. */
  push?: {
    vapid: VapidKeys;
    /** RFC 8292 contact, a mailto: or https: URI */
    subject?: string;
    /** alerts a host may have delivered per hour (default 30) */
    perHostPerHour?: number;
    /** tests only */
    fetchImpl?: typeof fetch;
    extraHosts?: RegExp[];
  };
}

interface Conn {
  ws: WebSocket;
  role: 'host' | 'device';
  id: string;
  acct: string;
  host: string;
  pub: Bytes;
  bucket: TokenBucket;
  /** hosts only: alert deliveries */
  pushBucket: TokenBucket;
  violations: number;
}

/** `f` = sender and `r` = the signed replace key (see protocol Header.r): a newer frame of the same sender and key supersedes this one */
interface QItem { m: string; raw: string; bytes: number; x: number; acct: string; f: string; r?: string }

interface PairEntry {
  hostId: string;
  offer: string;
  expires: number;
  requests: Map<string, { req: string; result?: string; rejected?: boolean }>;
  consumed: boolean;
  consumedAt: number;
}

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8', '.sig': 'application/json' };
const RID = /^[A-Za-z0-9_-]{22}$/;

export class Relay {
  readonly cfg: Required<Pick<RelayConfig, 'port' | 'ticketKeys'>> & RelayConfig;
  readonly kill = new KillState();
  readonly counters = new Map<string, number>();
  private server: Server | null = null;
  private wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  private readonly conns = new Map<string, Conn>();
  private readonly devicesOfHost = new Map<string, Set<Conn>>();
  private readonly queues = new Map<string, QItem[]>();
  private readonly acctQueued = new Map<string, number>();
  private readonly pairs = new Map<string, PairEntry>();
  private readonly acctBucket: KeyedLimiter;
  private readonly ipConnect = new KeyedLimiter(20, 20 / 60);
  private readonly ipPair = new KeyedLimiter(10, 10 / 60);
  private readonly ipKey = new KeyedLimiter(30, 30 / 60);
  private readonly acctPush = new KeyedLimiter(30, 30 / 3600);
  /** ops switch for alerts without removing the secrets (POST /admin/push) */
  pushOff = false;
  private timers: NodeJS.Timeout[] = [];
  origin: string;

  constructor(cfg: RelayConfig) {
    this.cfg = { ...cfg };
    this.origin = cfg.origin ?? '';
    this.acctBucket = new KeyedLimiter(cfg.rates?.acctBurst ?? 120, cfg.rates?.acctPerSec ?? 10);
    if (cfg.globalKill) this.kill.global = true;
  }

  private now(): number { return (this.cfg.now ?? Date.now)(); }
  private count(code: string): void { this.counters.set(code, (this.counters.get(code) ?? 0) + 1); }
  private log(code: string): void { this.count(code); this.cfg.logSink?.(JSON.stringify({ t: Math.floor(this.now() / 1000), c: code })); }
  private get ttl(): number { return this.cfg.queueTtlMs ?? 15 * 60_000; }

  // ------------------------------------------------------------------ lifecycle
  async listen(): Promise<number> {
    this.server = createServer((req, res) => { void this.http(req, res); });
    this.server.on('upgrade', (req, sock, head) => this.upgrade(req, sock, head));
    await new Promise<void>((ok) => this.server!.listen(this.cfg.port, this.cfg.host ?? '0.0.0.0', ok));
    const port = (this.server.address() as { port: number }).port;
    const sweep = setInterval(() => this.sweep(), 10_000); sweep.unref(); this.timers.push(sweep);
    if (this.cfg.killListUrl) {
      const poll = (): void => { void this.pollKillList(); };
      const t = setInterval(poll, this.cfg.killListPollMs ?? 30_000); t.unref(); this.timers.push(t);
      poll();
    }
    return port;
  }

  async close(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    for (const c of this.conns.values()) c.ws.terminate();
    for (const c of this.wss.clients) c.terminate();
    this.wss.close();
    await new Promise<void>((ok) => { if (!this.server) return ok(); this.server.close(() => ok()); this.server.closeAllConnections?.(); });
  }

  private async pollKillList(): Promise<void> {
    if (!this.cfg.killListUrl) return;
    const l = await fetchKillList(this.cfg.killListUrl, this.cfg.ticketKeys, this.cfg.fetchImpl);
    if (!l) { this.count('killlist_unavailable'); return; }
    if (this.kill.applyList(l)) { this.count('killlist_applied'); this.enforceKills(); }
  }

  // ------------------------------------------------------------------ http
  private ip(req: IncomingMessage): string {
    if (this.cfg.trustFlyProxy) { const h = req.headers['fly-client-ip']; if (typeof h === 'string') return h; }
    return req.socket.remoteAddress ?? 'x';
  }

  private securityHeaders(): Record<string, string> {
    const ws = this.origin.replace(/^http/, 'ws');
    return {
      'content-security-policy': `default-src 'none'; script-src 'self' blob:; worker-src 'self'; style-src 'self' blob:; img-src 'self' data:; manifest-src 'self'; connect-src 'self' ${ws}; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
      'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'cross-origin-opener-policy': 'same-origin',
      'cross-origin-resource-policy': 'same-origin', 'permissions-policy': 'camera=(self), microphone=(), geolocation=(), payment=()', 'x-robots-tag': 'noindex, nofollow',
    };
  }

  private send(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...this.securityHeaders(), ...extra });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  }

  private async readBody(req: IncomingMessage, max: number): Promise<string | null> {
    const chunks: Buffer[] = []; let n = 0;
    for await (const c of req) { n += (c as Buffer).length; if (n > max) return null; chunks.push(c as Buffer); }
    return Buffer.concat(chunks).toString('utf8');
  }

  private async http(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      const p = url.pathname;
      if (p === '/healthz') return this.send(res, 200, { ok: true });
      if (p.startsWith('/admin/')) return await this.admin(req, res, p);
      if (p.startsWith('/v1/pair/')) return await this.pairHttp(req, res, p, url);
      if (p === '/v1/push/key' && req.method === 'GET') return this.pushKey(req, res);
      if (req.method === 'GET' || req.method === 'HEAD') return this.serveStatic(req, res, p);
      return this.send(res, 404, { error: 'not_found' });
    } catch { if (!res.headersSent) this.send(res, 500, { error: 'failed' }); }
  }

  // ------------------------------------------------------------------ static client
  private serveStatic(req: IncomingMessage, res: ServerResponse, p: string): void {
    const dir = this.cfg.clientDir;
    if (!dir) return this.send(res, 404, { error: 'not_found' });
    const root = resolve(dir);
    const rel = p === '/' ? 'index.html' : decodeURIComponent(p.slice(1));
    const file = resolve(join(root, rel));
    if (!(file === root || file.startsWith(root + sep)) || !existsSync(file) || !statSync(file).isFile()) return this.send(res, 404, { error: 'not_found' });
    const type = MIME[extname(file)] ?? 'application/octet-stream';
    const immutable = /\.[0-9a-f]{12}\.(js|css)$/.test(file);
    res.writeHead(200, { 'content-type': type, 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-store', ...this.securityHeaders() });
    res.end(req.method === 'HEAD' ? undefined : readFileSync(file));
  }

  // ------------------------------------------------------------------ admin (bearer token; kill switches and counters only)
  private async admin(req: IncomingMessage, res: ServerResponse, p: string): Promise<void> {
    const tok = this.cfg.adminToken;
    const given = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
    const ok = !!tok && given.length === tok.length && timingSafeEqual(Buffer.from(given), Buffer.from(tok));
    if (!ok) { this.count('admin_denied'); return this.send(res, 404, { error: 'not_found' }); }
    if (p === '/admin/stats' && req.method === 'GET') {
      return this.send(res, 200, { connections: this.conns.size, queuedFrames: [...this.queues.values()].reduce((n, q) => n + q.length, 0), pairing: this.pairs.size, counters: Object.fromEntries(this.counters), kill: { global: this.kill.global, accounts: this.kill.accounts.size, hosts: this.kill.hosts.size, devices: this.kill.devices.size, seq: this.kill.seq } });
    }
    if (p === '/admin/push' && req.method === 'POST') {
      let j: { on?: unknown };
      try { j = JSON.parse((await this.readBody(req, 512)) ?? '') as typeof j; } catch { return this.send(res, 400, { error: 'invalid' }); }
      if (typeof j.on !== 'boolean') return this.send(res, 400, { error: 'invalid' });
      this.pushOff = !j.on; this.count(j.on ? 'admin_push_on' : 'admin_push_off');
      return this.send(res, 200, { ok: true, configured: !!this.cfg.push, on: !this.pushOff });
    }
    if ((p === '/admin/kill' || p === '/admin/unkill') && req.method === 'POST') {
      const body = await this.readBody(req, 2048);
      let j: { scope?: unknown; id?: unknown };
      try { j = JSON.parse(body ?? '') as typeof j; } catch { return this.send(res, 400, { error: 'invalid' }); }
      const scope = j.scope as KillScope;
      if (!['global', 'account', 'host', 'device'].includes(String(scope)) || (scope !== 'global' && typeof j.id !== 'string')) return this.send(res, 400, { error: 'invalid' });
      this.kill.set(scope, typeof j.id === 'string' ? j.id : undefined, p === '/admin/kill');
      this.count(p === '/admin/kill' ? 'admin_kill' : 'admin_unkill');
      this.enforceKills();
      return this.send(res, 200, { ok: true });
    }
    return this.send(res, 404, { error: 'not_found' });
  }

  private enforceKills(): void {
    for (const c of [...this.conns.values()]) if (this.kill.blocked(c.acct, c.host, c.role === 'device' ? c.id : undefined)) { this.count('kill_close'); this.closeConn(c, 4403, 'killed'); }
  }

  /** the public application server key a phone subscribes with; 404 when alerts are not configured or switched off */
  private pushKey(req: IncomingMessage, res: ServerResponse): void {
    if (!this.cfg.push || this.pushOff || this.kill.global) return this.send(res, 404, { error: 'not_found' });
    if (!this.ipKey.take(this.ip(req), this.now())) { this.count('push_key_rate_limited'); return this.send(res, 429, { error: 'rate_limited' }, { 'retry-after': '30' }); }
    return this.send(res, 200, { key: this.cfg.push.vapid.publicKey });
  }

  // ------------------------------------------------------------------ pairing rendezvous (unauthenticated device side, rate limited)
  private async pairHttp(req: IncomingMessage, res: ServerResponse, p: string, url: URL): Promise<void> {
    const now = this.now();
    if (!this.ipPair.take(this.ip(req), now)) { this.count('pair_rate_limited'); return this.send(res, 429, { error: 'rate_limited' }, { 'retry-after': '30' }); }
    const m = /^\/v1\/pair\/([A-Za-z0-9_-]{22})(?:\/(request|result))?$/.exec(p);
    const e = m ? this.pairs.get(m[1]!) : undefined;
    const notFound = (): void => this.send(res, 404, { error: 'not_found' });
    if (!m || !e || e.expires <= now) return notFound();
    const sub = m[2];
    if (e.consumed && sub !== 'result') return notFound();
    if (!sub && req.method === 'GET') return this.send(res, 200, { offer: e.offer });
    if (sub === 'request' && req.method === 'POST') {
      const body = await this.readBody(req, 3072);
      let j: { req?: unknown };
      try { j = JSON.parse(body ?? '') as typeof j; } catch { return this.send(res, 400, { error: 'invalid' }); }
      if (typeof j.req !== 'string' || j.req.length > 2048 || e.requests.size >= 3) return this.send(res, 400, { error: 'invalid' });
      const host = this.conns.get(e.hostId);
      if (!host) return notFound();
      const rq = b64u(randomBytes(9));
      e.requests.set(rq, { req: j.req });
      host.ws.send(JSON.stringify({ t: 'pair_request', rid: m[1], rq, req: j.req }));
      this.count('pair_request');
      return this.send(res, 200, { rq });
    }
    if (sub === 'result' && req.method === 'GET') {
      const rq = url.searchParams.get('rq') ?? '';
      const r = e.requests.get(rq);
      if (!r) return notFound();
      const deadline = now + 25_000;
      while (this.now() < deadline) {
        if (r.rejected) return this.send(res, 410, { error: 'rejected' });
        if (r.result) return this.send(res, 200, { result: r.result });
        if (res.destroyed || this.pairs.get(m[1]!) !== e) break;
        await new Promise((ok) => setTimeout(ok, 250));
      }
      return this.send(res, 200, { pending: true });
    }
    return notFound();
  }

  // ------------------------------------------------------------------ websocket
  private upgrade(req: IncomingMessage, sock: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? '/', 'http://x');
    const origin = req.headers.origin;
    const reject = (code: string): void => { this.count(code); sock.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); sock.destroy(); };
    if (url.pathname !== '/v1/ws') return reject('upgrade_bad_path');
    // a browser always sends Origin; only our own origin may open the socket (non-browser clients send none). No cookie is ever read.
    if (typeof origin === 'string' && origin !== this.origin) return reject('upgrade_bad_origin');
    if (this.kill.global) return reject('upgrade_killed');
    if (this.conns.size >= (this.cfg.maxConnections ?? 5000)) return reject('upgrade_capacity');
    if (!this.ipConnect.take(this.ip(req), this.now())) return reject('upgrade_rate_limited');
    this.wss.handleUpgrade(req, sock, head, (ws) => this.onSocket(ws));
  }

  private onSocket(ws: WebSocket): void {
    const nonce = randomBytes(32);
    let conn: Conn | null = null;
    let authing = false;
    ws.send(JSON.stringify({ t: 'hello', v: 1, nonce: b64u(nonce), aud: this.origin }));
    const authTimer = setTimeout(() => { if (!conn) { this.count('auth_timeout'); ws.close(4408, 'auth_timeout'); } }, 10_000);
    authTimer.unref();
    ws.on('close', () => { clearTimeout(authTimer); if (conn) this.dropConn(conn); });
    ws.on('error', () => { /* counted by close */ });
    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) return ws.close(4400, 'binary');
      const text = data.toString('utf8');
      if (!conn && text.length > 8192) { this.count('auth_too_big'); return ws.close(4400, 'too_big'); } // before authentication nothing is that big
      void (async () => {
        let msg: Record<string, unknown>;
        try { msg = JSON.parse(text) as Record<string, unknown>; } catch { this.count('bad_json'); return ws.close(4400, 'bad_json'); }
        if (!conn) {
          if (authing || msg.t !== 'auth') return ws.close(4401, 'auth_required');
          authing = true;
          conn = await this.authenticate(ws, msg, nonce);
          if (!conn) return;
          return;
        }
        await this.onMessage(conn, msg);
      })();
    });
  }

  private async authenticate(ws: WebSocket, msg: Record<string, unknown>, nonce: Bytes): Promise<Conn | null> {
    const fail = (code: string): null => { this.count(code); ws.send(JSON.stringify({ t: 'error', code })); ws.close(4401, code); return null; };
    const now = this.now();
    if (msg.role !== 'host' && msg.role !== 'device') return fail('auth_bad_role');
    if (typeof msg.id !== 'string' || typeof msg.sig !== 'string') return fail('auth_malformed');
    const ticket = await verifyTicket(msg.ticket, this.cfg.ticketKeys, now);
    if (!ticket) return fail('auth_bad_ticket');
    let id: string; let pub: Bytes; let acct = ticket.acct; const host = ticket.host;
    if (msg.role === 'host') { id = ticket.host; pub = unb64u(ticket.hostSig); }
    else {
      const cert = await verifyDeviceCert(msg.cert, unb64u(ticket.hostSig));
      if (!cert || cert.host !== ticket.host || cert.acct !== ticket.acct) return fail('auth_bad_cert');
      id = cert.dev; pub = unb64u(cert.sig); acct = cert.acct;
    }
    if (msg.id !== id) return fail('auth_id_mismatch');
    if (!(await verifyAuth(pub, msg.sig, nonce, this.origin, id))) return fail('auth_bad_signature');
    if (this.kill.blocked(acct, host, msg.role === 'device' ? id : undefined)) return fail('auth_killed');
    // per-account connection caps
    let hosts = 0; let devices = 0;
    for (const c of this.conns.values()) if (c.acct === acct && c.id !== id) { if (c.role === 'host') hosts++; else devices++; }
    if (msg.role === 'host' ? hosts >= (this.cfg.maxHostsPerAcct ?? 3) : devices >= (this.cfg.maxDevicesPerAcct ?? 8)) return fail('auth_account_cap');
    // a newer connection from the same key replaces the older one
    const old = this.conns.get(id);
    if (old) { this.count('conn_replaced'); this.closeConn(old, 4409, 'replaced'); }
    const conn: Conn = { ws, role: msg.role, id, acct, host, pub, bucket: new TokenBucket(this.cfg.rates?.connBurst ?? 20, this.cfg.rates?.connPerSec ?? 2, now), pushBucket: new TokenBucket(5, 1 / 30, now), violations: 0 };
    this.conns.set(id, conn);
    if (conn.role === 'device') { let s = this.devicesOfHost.get(host); if (!s) this.devicesOfHost.set(host, (s = new Set())); s.add(conn); }
    this.count(`auth_ok_${conn.role}`);
    const q = this.queues.get(id) ?? [];
    ws.send(JSON.stringify({ t: 'ready', peerOnline: conn.role === 'device' ? this.conns.has(host) : (this.devicesOfHost.get(host)?.size ?? 0) > 0, queued: q.length, maxFrame: MAX_FRAME_BYTES }));
    if (conn.role === 'host') this.presence(host, true);
    for (const it of q) if (it.x > this.now()) ws.send(it.raw);
    return conn;
  }

  private presence(host: string, online: boolean): void {
    for (const d of this.devicesOfHost.get(host) ?? []) d.ws.send(JSON.stringify({ t: 'presence', host: online }));
  }

  private closeConn(c: Conn, code: number, reason: string): void {
    this.dropConn(c);
    try { c.ws.close(code, reason); } catch { /* already closed */ }
  }

  private dropConn(c: Conn): void {
    if (this.conns.get(c.id) === c) this.conns.delete(c.id);
    if (c.role === 'device') this.devicesOfHost.get(c.host)?.delete(c);
    if (c.role === 'host' && !this.conns.has(c.id)) this.presence(c.host, false);
  }

  private async onMessage(c: Conn, msg: Record<string, unknown>): Promise<void> {
    const now = this.now();
    if (this.kill.blocked(c.acct, c.host, c.role === 'device' ? c.id : undefined)) { this.count('kill_close'); return this.closeConn(c, 4403, 'killed'); }
    if (!c.bucket.take(now) || !this.acctBucket.take(c.acct, now)) {
      this.count('rate_limited');
      c.ws.send(JSON.stringify({ t: 'error', code: 'rate_limited', retryMs: c.bucket.retryMs() }));
      if (++c.violations >= 5) this.closeConn(c, 4429, 'rate_limited');
      return;
    }
    switch (msg.t) {
      case 'msg': return this.onFrame(c, msg, now);
      case 'push': return this.onPush(c, msg, now);
      case 'ack': {
        if (typeof msg.m === 'string') { const q = this.queues.get(c.id); if (q) { const i = q.findIndex((x) => x.m === msg.m); if (i >= 0) this.dequeue(c.id, q, i); } }
        return;
      }
      case 'ping': return void c.ws.send('{"t":"pong"}');
      case 'revoke': {
        if (c.role !== 'host') return;
        const r = await verifyRevocation(SignedSchema.safeParse(msg.rev).success ? msg.rev : null, c.pub);
        if (!r || r.host !== c.id) { this.count('revoke_bad'); return; }
        this.kill.set('device', r.dev, true);
        for (const d of [...(this.devicesOfHost.get(c.id) ?? [])]) if (d.id === r.dev) this.closeConn(d, 4403, 'revoked');
        this.count('revoke_ok');
        return;
      }
      case 'revoke_self': {
        if (c.role !== 'device') return;
        this.kill.set('device', c.id, true); this.count('revoke_self');
        return this.closeConn(c, 4403, 'revoked');
      }
      case 'pair_offer': {
        if (c.role !== 'host' || typeof msg.rid !== 'string' || !RID.test(msg.rid) || typeof msg.offer !== 'string' || msg.offer.length > 4096) return;
        let open = 0; for (const e of this.pairs.values()) if (e.hostId === c.id && e.expires > now && !e.consumed) open++;
        if (open >= 3) { c.ws.send(JSON.stringify({ t: 'error', code: 'pair_cap' })); return; }
        this.pairs.set(msg.rid, { hostId: c.id, offer: msg.offer, expires: now + 10 * 60_000, requests: new Map(), consumed: false, consumedAt: 0 });
        this.count('pair_offer');
        return void c.ws.send(JSON.stringify({ t: 'pair_ok', rid: msg.rid }));
      }
      case 'pair_result': {
        if (c.role !== 'host' || typeof msg.rid !== 'string' || typeof msg.rq !== 'string') return;
        const e = this.pairs.get(msg.rid); const r = e?.requests.get(msg.rq);
        if (!e || !r || e.hostId !== c.id) return;
        if (msg.rejected === true) r.rejected = true;
        else if (typeof msg.result === 'string' && msg.result.length <= 4096) { r.result = msg.result; e.consumed = true; e.consumedAt = now; }
        this.count('pair_result');
        return;
      }
      default: this.count('unknown_type');
    }
  }

  private async onFrame(c: Conn, frame: Record<string, unknown>, now: number): Promise<void> {
    const header = await verifyFrameSignature(frame, c.pub);
    if (!header) return void this.reject(c, 'bad_frame');
    if (header.f !== c.id) return void this.reject(c, 'wrong_sender');
    if (header.x <= now) return void this.reject(c, 'expired');
    if (c.role === 'device' && header.t !== c.host) return void this.reject(c, 'wrong_recipient');
    if (c.role === 'host' && header.t === c.id) return void this.reject(c, 'wrong_recipient');
    const raw = JSON.stringify({ t: 'msg', h: frame.h, c: frame.c, s: frame.s });
    const bytes = raw.length;
    const q = this.queues.get(header.t) ?? [];
    const maxFrames = this.cfg.maxQueueFrames ?? 100; const maxBytes = this.cfg.maxQueueBytes ?? 1024 * 1024;
    const acctMax = this.cfg.maxAcctQueuedFrames ?? 400;
    // newest wins per (sender, replace key): the older queued frame is superseded, not stacked (the key is in the signed header and says nothing about content)
    if (header.r) for (let i = q.length - 1; i >= 0; i--) if (q[i]!.f === header.f && q[i]!.r === header.r) { this.dequeue(header.t, q, i); this.count('queue_replaced'); }
    if ((this.acctQueued.get(c.acct) ?? 0) >= acctMax) return void this.reject(c, 'quota');
    q.push({ m: header.m, raw, bytes, x: Math.min(header.x, now + this.ttl), acct: c.acct, f: header.f, ...(header.r ? { r: header.r } : {}) });
    this.acctQueued.set(c.acct, (this.acctQueued.get(c.acct) ?? 0) + 1);
    // one sender cannot fill a recipient's queue, whether its frames carry replace keys or not (a computer from before 0.1.2 sends a frame per event and
    // no key): the newest few of each kind are kept, the older are dropped, and that is not an overflow
    const capUn = this.cfg.maxUnkeyedPerSender ?? 12; const capKeyed = this.cfg.maxKeyedPerSender ?? 8;
    for (const keyed of [false, true]) {
      const cap = keyed ? capKeyed : capUn;
      const idx: number[] = [];
      q.forEach((x, i) => { if (x.f === header.f && !!x.r === keyed) idx.push(i); });
      for (let k = 0; k < idx.length - cap; k++) { this.dequeue(header.t, q, idx[k]! - k); this.count('queue_trimmed'); }
    }
    let total = q.reduce((n, x) => n + x.bytes, 0);
    // over capacity: drop the oldest frame that has no replace key first (the keyed one is already the newest of its kind), then the oldest of all
    while (q.length > maxFrames || total > maxBytes) {
      const i = Math.max(0, q.findIndex((x) => !x.r && x.m !== header.m));
      total -= q[i]!.bytes; this.dequeue(header.t, q, i); this.count('queue_overflow');
    }
    this.queues.set(header.t, q);
    this.count('frames');
    const dest = this.conns.get(header.t);
    if (dest) dest.ws.send(raw);
  }

  /**
   * `{t:'push', q, ep, body, ttl?, urgency?, topic?}` from a host: deliver an alert the host sealed for one phone's push subscription. `q` is echoed in
   * the answer `{t:'push_result', q, ok, gone?, why?}`. The relay checks shape, destination and rate; it cannot look inside `body`.
   */
  private async onPush(c: Conn, msg: Record<string, unknown>, now: number): Promise<void> {
    if (c.role !== 'host') return void this.count('push_wrong_role');
    const q = typeof msg.q === 'string' && /^[A-Za-z0-9_-]{1,16}$/.test(msg.q) ? msg.q : '';
    const answer = (r: { ok: boolean; gone?: boolean; why?: string }): void => { try { c.ws.send(JSON.stringify({ t: 'push_result', q, ...r })); } catch { /* closed */ } };
    const cfg = this.cfg.push;
    if (!cfg || this.pushOff) { this.count('push_off'); return answer({ ok: false, why: 'disabled' }); }
    if (!q || typeof msg.ep !== 'string' || typeof msg.body !== 'string' || msg.body.length > Math.ceil((MAX_ALERT_BYTES * 4) / 3) + 4 || !/^[A-Za-z0-9_-]+$/.test(msg.body)) { this.count('push_malformed'); return answer({ ok: false, why: 'malformed' }); }
    if (!pushOrigin(msg.ep, cfg.extraHosts)) { this.count('push_bad_endpoint'); return answer({ ok: false, why: 'bad_endpoint' }); } // not a push service: refused before it costs a token
    const body = unb64u(msg.body);
    const hourly = cfg.perHostPerHour ?? 30;
    if (!c.pushBucket.take(now) || !this.acctPush.take(c.acct, now) || this.pushThisHour(c.id, now) >= hourly) { this.count('push_rate_limited'); return answer({ ok: false, why: 'rate_limited' }); }
    const ttl = typeof msg.ttl === 'number' && Number.isFinite(msg.ttl) ? Math.min(3600, Math.max(60, Math.floor(msg.ttl))) : 600;
    const urgency = msg.urgency === 'high' || msg.urgency === 'normal' || msg.urgency === 'low' || msg.urgency === 'very-low' ? msg.urgency : 'high';
    const r = await deliver(msg.ep, body, {
      vapid: cfg.vapid, subject: cfg.subject ?? 'mailto:support@turbokast.com', ttl, urgency, ...(typeof msg.topic === 'string' ? { topic: msg.topic } : {}),
      ...(cfg.fetchImpl ? { fetchImpl: cfg.fetchImpl } : {}), ...(cfg.extraHosts ? { extraHosts: cfg.extraHosts } : {}), now: () => this.now(),
    });
    if (r.ok) { this.count('push_sent'); return answer({ ok: true }); }
    this.count(r.gone ? 'push_gone' : `push_failed_${r.why}`);
    return answer(r.gone ? { ok: false, gone: true } : { ok: false, why: r.why });
  }

  private readonly pushLog = new Map<string, number[]>();
  private pushThisHour(host: string, now: number): number {
    const l = (this.pushLog.get(host) ?? []).filter((t) => now - t < 3_600_000);
    l.push(now);
    this.pushLog.set(host, l);
    if (this.pushLog.size > 5000) this.pushLog.delete(this.pushLog.keys().next().value as string);
    return l.length - 1;
  }

  private reject(c: Conn, code: string): void {
    this.count(`frame_${code}`);
    c.ws.send(JSON.stringify({ t: 'error', code }));
  }

  private dequeue(id: string, q: QItem[], i: number): void {
    const [it] = q.splice(i, 1);
    if (it) this.acctQueued.set(it.acct, Math.max(0, (this.acctQueued.get(it.acct) ?? 1) - 1));
    if (q.length === 0) this.queues.delete(id);
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, q] of [...this.queues]) {
      for (let i = q.length - 1; i >= 0; i--) if (q[i]!.x <= now) this.dequeue(id, q, i);
    }
    for (const [rid, e] of [...this.pairs]) if (e.expires <= now || (e.consumedAt > 0 && now - e.consumedAt > 120_000)) this.pairs.delete(rid);
  }
}


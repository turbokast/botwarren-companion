/**
 * The daemon's local socket: how the hooks, the channel server and the CLI talk to the running companion. A Unix socket in the 0700
 * home directory (a named pipe on Windows), never a network port. Every request carries the per-install secret from hook.secret.
 * Newline-delimited JSON. Licence: Apache-2.0.
 */
import { VERSION } from './version.ts';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { chmodSync, existsSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { ClaudeBridge } from './claude/bridge.ts';
import { CompanionHost, type LocalConfirmRequest } from './host.ts';
import type { Sess } from './sessions.ts';

type Msg = Record<string, unknown> & { id?: number | string; op?: string };

/** requests that need a person at this computer, answered from an attached `botwarren-companion confirm` terminal */
export class ConfirmHub {
  private readonly queue = new Map<string, { req: LocalConfirmRequest; resolve: (ok: boolean) => void }>();
  private readonly watchers = new Set<(cid: string, req: LocalConfirmRequest) => void>();

  ask(req: LocalConfirmRequest): Promise<boolean> {
    const cid = randomBytes(4).toString('hex');
    return new Promise<boolean>((resolve) => {
      this.queue.set(cid, { req, resolve: (ok) => { this.queue.delete(cid); resolve(ok); } });
      for (const w of this.watchers) w(cid, req);
    });
  }
  decide(cid: string, ok: boolean): boolean { const q = this.queue.get(cid); if (!q) return false; q.resolve(ok); return true; }
  watch(fn: (cid: string, req: LocalConfirmRequest) => void): () => void {
    this.watchers.add(fn);
    for (const [cid, q] of this.queue) fn(cid, q.req);
    return () => this.watchers.delete(fn);
  }
  get pending(): number { return this.queue.size; }
}

export class LocalServer {
  private server: Server | null = null;
  private readonly host: CompanionHost;
  private readonly bridge: ClaudeBridge;
  private readonly hub: ConfirmHub;
  private readonly secret: Buffer;
  private readonly path: string;
  private readonly shutdown: () => void;
  private readonly sockets = new Set<Socket>();
  private readonly watchMs: number;
  /** the inode of the socket file this server created (Unix): if the file at the path is ever another one, this server is no longer the one clients reach */
  private ino: number | null = null;
  private watch: ReturnType<typeof setInterval> | null = null;
  private verifying = false;
  /** told when the socket was taken back or found to belong to someone else (the daemon audits it) */
  onSocketEvent: (e: 'rebound' | 'taken') => void = () => undefined;

  constructor(o: { host: CompanionHost; bridge: ClaudeBridge; hub: ConfirmHub; secret: string; path: string; shutdown: () => void; watchMs?: number }) {
    this.host = o.host; this.bridge = o.bridge; this.hub = o.hub; this.secret = Buffer.from(o.secret); this.path = o.path; this.shutdown = o.shutdown;
    this.watchMs = o.watchMs ?? 5000;
  }

  private get unix(): boolean { return process.platform !== 'win32'; }
  private inoOfPath(): number | null { try { return statSync(this.path).ino; } catch { return null; } }

  /** true if something accepts connections on the path right now (a live daemon, as opposed to a stale file) */
  private answers(): Promise<boolean> {
    return new Promise<boolean>((ok) => {
      const c = createConnection(this.path);
      const done = (v: boolean): void => { clearTimeout(t); c.destroy(); ok(v); };
      const t = setTimeout(() => done(false), 800);
      c.once('connect', () => done(true));
      c.once('error', () => done(false));
    });
  }

  async listen(): Promise<void> {
    if (this.unix && existsSync(this.path)) {
      // a file from a crashed run is removed; one that something still answers on is another running daemon, which must not be knocked off its socket
      if (await this.answers()) throw new Error('another companion daemon is already running on this socket');
      unlinkSync(this.path);
    }
    await this.bind();
    if (this.unix && this.watchMs > 0 && !this.watch) { this.watch = setInterval(() => { void this.verify(); }, this.watchMs); this.watch.unref(); }
  }

  private async bind(): Promise<void> {
    const server = createServer((sock) => this.onSocket(sock));
    await new Promise<void>((ok, bad) => { server.once('error', bad); server.listen(this.path, ok); });
    this.server = server;
    if (this.unix) { chmodSync(this.path, 0o600); this.ino = this.inoOfPath(); }
  }

  /**
   * Closes a listening server WITHOUT deleting somebody else's socket. libuv unlinks the path a server was bound to when it closes, whatever file is
   * there by then; if a restarted daemon has bound the same path meanwhile, that would delete the new daemon's socket and leave it listening on a file
   * nobody can reach (clients get "connection refused"). So a file that is not ours is moved aside for the moment of the close and put back.
   */
  private async closeServer(server: Server | null, wait = true): Promise<void> {
    if (!server) return;
    let aside: string | null = null;
    if (this.unix) {
      const cur = this.inoOfPath();
      if (cur !== null && cur !== this.ino) { aside = `${this.path}.keep-${process.pid}`; try { renameSync(this.path, aside); } catch { aside = null; } }
    }
    // the listening handle (and its file) is released at once; the callback only fires when every open connection has ended, which a long-lived channel never does
    const closed = new Promise<void>((ok) => { server.close(() => ok()); });
    if (wait) await closed;
    if (aside) { try { renameSync(aside, this.path); } catch { /* the other daemon is gone too */ } }
  }

  /**
   * Checks that the socket file at the path is still the one this server created (Unix). If it was deleted or replaced by a dead file (an update, a
   * cleanup, an old daemon exiting) the server is bound again at once, so the CLI and the hooks can reach this daemon. If another daemon is live on
   * the path, nothing is touched. Runs every few seconds and on SIGHUP.
   */
  async verify(): Promise<'ok' | 'rebound' | 'taken'> {
    if (!this.unix || !this.server || this.verifying) return 'ok';
    const cur = this.inoOfPath();
    if (cur !== null && cur === this.ino) return 'ok';
    this.verifying = true;
    try {
      if (cur !== null && (await this.answers())) { this.onSocketEvent('taken'); return 'taken'; }
      if (cur !== null) { try { unlinkSync(this.path); } catch { /* gone already */ } }
      const old = this.server;
      this.server = null;
      await this.closeServer(old, false); // existing connections (an attached channel) stay up
      await this.bind();
      this.onSocketEvent('rebound');
      return 'rebound';
    } finally { this.verifying = false; }
  }

  async close(): Promise<void> {
    if (this.watch) { clearInterval(this.watch); this.watch = null; }
    for (const s of this.sockets) s.destroy();
    const server = this.server; this.server = null;
    await this.closeServer(server); // removes our own socket file (libuv), and leaves a replacement alone
  }

  private authed(m: Msg): boolean {
    const t = typeof m.token === 'string' ? Buffer.from(m.token) : Buffer.alloc(0);
    return t.length === this.secret.length && timingSafeEqual(t, this.secret);
  }

  private onSocket(sock: Socket): void {
    this.sockets.add(sock);
    let buf = '';
    const cancels: (() => void)[] = [];
    let channelSess: Sess | null = null;
    const send = (m: unknown): boolean => { if (sock.destroyed) return false; sock.write(JSON.stringify(m) + '\n'); return true; };
    sock.setEncoding('utf8');
    sock.on('data', (chunk: string) => {
      buf += chunk;
      if (buf.length > 256 * 1024) { sock.destroy(); return; }
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m: Msg;
        try { m = JSON.parse(line) as Msg; } catch { continue; }
        if (!this.authed(m)) { send({ id: m.id, ok: false, error: 'unauthorized' }); sock.destroy(); return; }
        void this.handle(m, send, cancels, (s) => { channelSess = s; }, () => channelSess).catch(() => send({ id: m.id, ok: false, error: 'failed' }));
      }
    });
    sock.on('close', () => {
      this.sockets.delete(sock);
      for (const c of cancels) c();
      if (channelSess) this.bridge.channelBye(channelSess);
    });
    sock.on('error', () => { /* close follows */ });
  }

  private async handle(m: Msg, send: (x: unknown) => boolean, cancels: (() => void)[], setChannel: (s: Sess) => void, getChannel: () => Sess | null): Promise<void> {
    const id = m.id;
    switch (m.op) {
      case 'hook': {
        let cancelled = false;
        cancels.push(() => { cancelled = true; });
        const ancestors = Array.isArray(m.ancestors) ? m.ancestors.filter((n): n is number => typeof n === 'number').slice(0, 12) : [];
        const out = await this.bridge.onHook({
          event: String(m.event ?? ''), input: (m.input && typeof m.input === 'object' ? m.input : {}) as Record<string, unknown>, ancestors,
          cancelled: () => cancelled, onCancel: (fn) => { cancels.push(fn); },
        });
        send({ id, ok: true, ...(out ? { out } : {}) });
        return;
      }
      case 'channel_hello': {
        const pid = Number(m.pid); const parent = typeof m.ppid === 'number' ? m.ppid : undefined;
        const s = this.bridge.channelHello(pid, parent, String(m.cwd ?? ''), (ev) => send({ ev }));
        setChannel(s);
        send({ id, ok: true });
        return;
      }
      case 'permission_request': {
        const s = getChannel();
        const rid = String(m.request_id ?? '');
        if (s && /^[a-km-z]{5}$/.test(rid)) await this.bridge.channelPermissionRequest(s, { request_id: rid, tool_name: String(m.tool_name ?? ''), description: String(m.description ?? ''), input_preview: String(m.input_preview ?? '') });
        send({ id, ok: !!s });
        return;
      }
      case 'status': {
        const cfg = this.host.config;
        send({
          id, ok: true,
          status: {
            version: VERSION, relay: this.host.relayState, enrolled: this.host.store.enrollment() !== null, paused: cfg.paused, hostId: this.host.hostId,
            devices: this.host.listDevices().map((d) => ({ id: d.id.slice(0, 8), name: d.name, lastSeen: d.lastSeen, pairedAt: d.pairedAt })),
            sessions: [...this.host.sessions.sessions.values()].map((s) => ({ label: s.label, status: s.status, waiting: !!s.pending, channel: !!s.channel, masked: s.masked })),
            alerts: { enabled: cfg.alerts.enabled, phones: this.host.listDevices().filter((d) => d.push).length },
            pendingConfirmations: this.hub.pending,
          },
        });
        return;
      }
      case 'pair_start': {
        try {
          const { code, expiresAt } = await this.host.beginPairing(async (req) => {
            const cid = randomBytes(4).toString('hex');
            return new Promise<boolean>((ok) => {
              pairWaiters.set(cid, ok);
              send({ ev: { t: 'pair_confirm', cid, device: req.device, sas: req.sas, startedAt: req.startedAt } });
            });
          });
          send({ id, ok: true, code, expiresAt });
        } catch (e) { send({ id, ok: false, error: (e as Error).message }); }
        return;
      }
      case 'pair_decision': { const w = pairWaiters.get(String(m.cid)); pairWaiters.delete(String(m.cid)); w?.(m.ok === true); send({ id, ok: !!w }); return; }
      case 'confirm_attach': {
        const off = this.hub.watch((cid, req) => { send({ ev: { t: 'confirm', cid, req } }); });
        cancels.push(off);
        send({ id, ok: true });
        return;
      }
      case 'confirm_decision': send({ id, ok: this.hub.decide(String(m.cid), m.ok === true) }); return;
      case 'revoke_device': send({ id, ok: await this.host.revokeDevice(String(m.device ?? '')) }); return;
      case 'revoke_all': await this.host.revokeAll(m.reason === 'account_off' ? 'account_off' : 'removed'); send({ id, ok: true }); return;
      case 'shutdown': send({ id, ok: true }); setTimeout(this.shutdown, 50); return;
      default: send({ id, ok: false, error: 'unknown_op' });
    }
  }
}

const pairWaiters = new Map<string, (ok: boolean) => void>();

/**
 * The daemon's local socket: how the hooks, the channel server and the CLI talk to the running companion. A Unix socket in the 0700
 * home directory (a named pipe on Windows), never a network port. Every request carries the per-install secret from hook.secret.
 * Newline-delimited JSON. Licence: Apache-2.0.
 */
import { createServer, type Server, type Socket } from 'node:net';
import { chmodSync, existsSync, unlinkSync } from 'node:fs';
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

  constructor(o: { host: CompanionHost; bridge: ClaudeBridge; hub: ConfirmHub; secret: string; path: string; shutdown: () => void }) {
    this.host = o.host; this.bridge = o.bridge; this.hub = o.hub; this.secret = Buffer.from(o.secret); this.path = o.path; this.shutdown = o.shutdown;
  }

  async listen(): Promise<void> {
    if (process.platform !== 'win32' && existsSync(this.path)) unlinkSync(this.path); // a stale socket from a crashed run
    this.server = createServer((sock) => this.onSocket(sock));
    await new Promise<void>((ok, bad) => { this.server!.once('error', bad); this.server!.listen(this.path, ok); });
    if (process.platform !== 'win32') chmodSync(this.path, 0o600);
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((ok) => { if (!this.server) return ok(); this.server.close(() => ok()); });
    if (process.platform !== 'win32' && existsSync(this.path)) try { unlinkSync(this.path); } catch { /* ignore */ }
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
            relay: this.host.relayState, enrolled: this.host.store.enrollment() !== null, paused: cfg.paused, hostId: this.host.hostId,
            devices: this.host.listDevices().map((d) => ({ id: d.id.slice(0, 8), name: d.name, lastSeen: d.lastSeen, pairedAt: d.pairedAt })),
            sessions: [...this.host.sessions.sessions.values()].map((s) => ({ label: s.label, status: s.status, waiting: !!s.pending, channel: !!s.channel, masked: s.masked })),
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

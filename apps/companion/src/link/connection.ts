/**
 * A reconnecting WebSocket connection to the relay, shared by the companion daemon (Node) and the browser client. It uses only the
 * global WebSocket and fetch, so there is one implementation. It signs the audience derived from ITS OWN url (never the one the
 * server claims in `hello`), so a relay that forwards a challenge to another relay gets a proof that is useless there.
 * Licence: Apache-2.0.
 */
import { b64u, signAuth, unb64u, type Frame, type Identity, type Signed } from '../protocol/index.ts';

export type ConnState = 'idle' | 'connecting' | 'online' | 'offline' | 'killed';

export interface ConnectionOptions {
  /** e.g. wss://relay.botwarren.com/v1/ws or ws://127.0.0.1:1234/v1/ws */
  url: string;
  role: 'host' | 'device';
  identity: Identity;
  ticket: Signed;
  cert?: Signed;
  onFrame: (f: Frame) => void | Promise<void>;
  onState?: (s: ConnState, info?: { peerOnline?: boolean; queued?: number }) => void;
  onPresence?: (hostOnline: boolean) => void;
  onControl?: (msg: Record<string, unknown>) => void;
  /** send these control messages right after `ready` (e.g. the host's signed revocations) */
  onReady?: (send: (m: unknown) => void) => void;
  reconnect?: boolean;
  /** tests */
  WebSocketImpl?: typeof WebSocket;
  backoffMs?: [number, number];
}

/** http(s)/ws(s) URL to the origin string the relay signs into its challenge */
export function audienceOf(wsUrl: string): string {
  const u = new URL(wsUrl);
  return `${u.protocol === 'wss:' ? 'https' : 'http'}://${u.host}`;
}

export class RelayConnection {
  private ws: WebSocket | null = null;
  private stopped = true;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  state: ConnState = 'idle';
  private readonly o: ConnectionOptions;

  constructor(o: ConnectionOptions) { this.o = o; }

  start(): void { if (!this.stopped) return; this.stopped = false; this.connect(); }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    try { this.ws?.close(1000, 'stop'); } catch { /* ignore */ }
    this.ws = null;
    this.setState('idle');
  }

  private setState(s: ConnState, info?: { peerOnline?: boolean; queued?: number }): void { this.state = s; this.o.onState?.(s, info); }

  get online(): boolean { return this.state === 'online'; }

  private connect(): void {
    if (this.stopped) return;
    this.setState('connecting');
    const Impl = this.o.WebSocketImpl ?? WebSocket;
    let ws: WebSocket;
    try { ws = new Impl(this.o.url); } catch { return this.retry(); }
    this.ws = ws;
    ws.onmessage = (ev: MessageEvent) => { void this.onMessage(ws, String(ev.data)); };
    ws.onclose = (ev: CloseEvent) => {
      if (this.ws === ws) this.ws = null;
      if (ev.code === 4403) { this.setState('killed'); if (!this.o.reconnect) return; }
      else this.setState('offline');
      this.retry(ev.code === 4403 ? 60_000 : undefined);
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  private retry(forceMs?: number): void {
    if (this.stopped || this.o.reconnect === false) return;
    const [lo, hi] = this.o.backoffMs ?? [1000, 30_000];
    const base = Math.min(hi, lo * 2 ** Math.min(this.attempt++, 8));
    this.timer = setTimeout(() => this.connect(), forceMs ?? base / 2 + Math.random() * (base / 2));
  }

  private async onMessage(ws: WebSocket, text: string): Promise<void> {
    let m: Record<string, unknown>;
    try { m = JSON.parse(text) as Record<string, unknown>; } catch { return; }
    switch (m.t) {
      case 'hello': {
        if (typeof m.nonce !== 'string') return;
        const sig = await signAuth(this.o.identity, unb64u(m.nonce), audienceOf(this.o.url));
        ws.send(JSON.stringify({ t: 'auth', role: this.o.role, id: this.o.identity.id, ticket: this.o.ticket, ...(this.o.cert ? { cert: this.o.cert } : {}), sig }));
        return;
      }
      case 'ready': {
        this.attempt = 0;
        this.setState('online', { peerOnline: m.peerOnline === true, queued: typeof m.queued === 'number' ? m.queued : 0 });
        this.o.onReady?.((x) => this.send(x));
        return;
      }
      case 'msg': {
        const f = { t: 'msg' as const, h: String(m.h), c: String(m.c), s: String(m.s) };
        await this.o.onFrame(f);
        return;
      }
      case 'presence': this.o.onPresence?.(m.host === true); return;
      case 'error': this.o.onControl?.(m); return;
      default: this.o.onControl?.(m);
    }
  }

  send(obj: unknown): boolean {
    if (!this.ws || this.ws.readyState !== 1) return false;
    this.ws.send(JSON.stringify(obj));
    return true;
  }

  sendFrame(f: Frame): boolean { return this.send(f); }
  ack(m: string): void { this.send({ t: 'ack', m }); }
}

export { b64u };

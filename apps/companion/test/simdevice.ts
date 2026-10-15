/**
 * A simulated paired device for tests: does exactly what the browser client does, using the same protocol library and connection
 * class, so the whole path (relay, daemon, bridge) is exercised without a browser.
 */
import {
  KemKeyring, ReplayGuard, SendCounter, b64u, derivePairKeys, generateIdentity, openMessage, openOffer, openResult, parseCode, sealMessage, sealRequest, shortAuthString, unb64u, verifyDeviceCert,
  DEVICE_REPLACE_KEYS, type ActionData, type Frame, type Identity, type PushAckData, type PushTestAck, type PushSub, type Signed, type StateData,
} from '../src/protocol/index.ts';
import { RelayConnection } from '../src/link/connection.ts';

const replaceKey = (kind: string): string | undefined => (DEVICE_REPLACE_KEYS as Record<string, string>)[kind];

export class SimDevice {
  id!: Identity;
  ring = new KemKeyring(false);
  cert!: Signed;
  ticket!: Signed;
  hostSig!: Uint8Array;
  hostKem!: Uint8Array;
  hostEp = 0;
  guard = new ReplayGuard();
  counter = new SendCounter(0, 1, () => {});
  conn: RelayConnection | null = null;
  states: StateData[] = [];
  results: { rid: string; outcome: string; note?: string }[] = [];
  kinds: string[] = [];
  acks: PushAckData[] = [];
  testAcks: PushTestAck[] = [];
  /** what this simulated page says it can read in its `sync` (the real page sends ["long1"]) */
  caps: string[] = [];
  /** the header of every frame received (the relay's view: no content) */
  headers: { r?: string; n: number }[] = [];
  revoked = false;
  online = false;
  clock: () => number = () => Date.now();
  readonly base: string;
  readonly name: string;

  constructor(base: string, name = 'Sim phone') { this.base = base; this.name = name; }

  /** returns the short authentication string once the request is in; `finish()` completes after the host confirms */
  async pair(code: string): Promise<{ sas: string; finish: () => Promise<boolean> }> {
    const secret = parseCode(code);
    if (!secret) throw new Error('bad code');
    const keys = await derivePairKeys(secret);
    const r = await fetch(`${this.base}/v1/pair/${keys.rid}`);
    if (!r.ok) throw new Error(`offer ${r.status}`);
    const offer = await openOffer(keys, ((await r.json()) as { offer: string }).offer);
    if (!offer) throw new Error('offer did not verify');
    this.id = await generateIdentity(false);
    const k = await this.ring.init(Date.now());
    const req = await sealRequest(keys, { v: 1, devSig: b64u(this.id.pub), devKem: b64u(k.pair.pub), devName: this.name });
    const rq = ((await (await fetch(`${this.base}/v1/pair/${keys.rid}/request`, { method: 'POST', body: JSON.stringify({ req }) })).json()) as { rq: string }).rq;
    this.hostSig = unb64u(offer.hostSig); this.hostKem = unb64u(offer.hostKem); this.hostEp = offer.hostEp; this.ticket = offer.ticket;
    const sas = await shortAuthString(this.hostSig, this.hostKem, this.id.pub, k.pair.pub);
    const finish = async (): Promise<boolean> => {
      for (let i = 0; i < 8; i++) {
        const res = await fetch(`${this.base}/v1/pair/${keys.rid}/result?rq=${rq}`);
        if (res.status === 410 || res.status === 404) return false;
        const j = (await res.json()) as { result?: string };
        if (j.result) {
          const body = await openResult(keys, j.result);
          const cert = body ? await verifyDeviceCert(body.cert, this.hostSig) : null;
          if (!body || !cert || cert.dev !== this.id.id) return false;
          this.cert = body.cert; this.hostEp = body.hostEp;
          return true;
        }
      }
      return false;
    };
    return { sas, finish };
  }

  connect(): void {
    const ws = this.base.replace(/^http/, 'ws') + '/v1/ws';
    this.conn = new RelayConnection({
      url: ws, role: 'device', identity: this.id, ticket: this.ticket, cert: this.cert, reconnect: false,
      onState: (s) => { this.online = s === 'online'; if (s === 'online') setTimeout(() => { void this.send('sync', this.caps.length ? { caps: this.caps } : {}); }, 0); },
      onFrame: (f) => this.onFrame(f),
    });
    this.conn.start();
  }

  private async onFrame(f: Frame): Promise<void> {
    const hostId = await (await import('../src/protocol/index.ts')).idOf(this.hostSig);
    const r = await openMessage(f, { me: { id: this.id.id, ring: this.ring }, senderKey: (id) => (id === hostId ? this.hostSig : null), guard: this.guard, now: this.clock() });
    if (!r.ok) return;
    const hd = (await import('../src/protocol/index.ts')).peekHeader(f);
    if (hd) this.headers.push({ n: hd.header.n, ...(hd.header.r ? { r: hd.header.r } : {}) });
    this.kinds.push(r.msg.kind);
    if (r.msg.kind === 'pushack') this.acks.push(r.msg.data as PushAckData);
    if (r.msg.kind === 'pushtestack') this.testAcks.push(r.msg.data as PushTestAck);
    if (r.msg.kind === 'state') this.states.push(r.msg.data as StateData);
    else if (r.msg.kind === 'result') this.results.push(r.msg.data as { rid: string; outcome: string });
    else if (r.msg.kind === 'revoked') this.revoked = true;
    else if (r.msg.kind === 'keyupdate') { const d = r.msg.data as { ep: number; kem: string }; this.hostKem = unb64u(d.kem); this.hostEp = d.ep; }
  }

  get latest(): StateData | undefined { return this.states.at(-1); }

  async hostId(): Promise<string> { return (await import('../src/protocol/index.ts')).idOf(this.hostSig); }

  async send(kind: string, data: unknown, now = this.clock()): Promise<Frame> {
    const frame = await sealMessage({ from: this.id, to: { id: await this.hostId(), kemPub: this.hostKem, epoch: this.hostEp }, seq: this.counter.next() + 1, now, ttlMs: 120_000, kind, data, ...(replaceKey(kind) ? { replace: replaceKey(kind)! } : {}) });
    this.conn!.sendFrame(frame);
    return frame;
  }

  /** turns alerts on (a subscription) or off (null) for this phone, exactly as the page does */
  async registerAlerts(sub: PushSub | null): Promise<void> { await this.send('push', sub ? { on: true, sub } : { on: false }); }

  async act(a: Omit<ActionData, 'nonce'> & { nonce?: string }, now = this.clock()): Promise<Frame> {
    return this.send('action', { nonce: Math.random().toString(36).slice(2, 12).padEnd(8, 'x'), ...a }, now);
  }

  async waitFor<T>(fn: () => T | undefined | false, ms = 5000): Promise<T> {
    const t0 = Date.now();
    for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 20)); }
  }

  stop(): void { this.conn?.stop(); }
}

/**
 * The device side of the protocol: pairing, the relay connection, receiving state, sending actions. Uses the same protocol library
 * and connection class as the companion; keys are non-extractable WebCrypto keys kept in IndexedDB.
 */
import {
  KemKeyring, ReplayGuard, SendCounter, b64u, derivePairKeys, generateIdentity, idOf, openMessage, openOffer, openResult, parseCode, sealMessage, sealRequest, shortAuthString,
  unb64u, verifyDeviceCert, StateData, ResultData, PushAckData, PushTestAck, CAP_LONG, DEVICE_REPLACE_KEYS, PROTO_VERSION, type KemEntry, type Signed, type Identity, type ActionData, type Frame, peekHeader,
} from '../../src/protocol/index.ts';
import { RelayConnection, type ConnState } from '../../src/link/connection.ts';
import { idbDel, idbGet, idbPut } from './idb.ts';
import { currentSubscription, wantsAlerts } from './alerts.ts';

const KEY = 'device';
const ROTATE_MS = 7 * 86_400_000;

interface Saved {
  v: 1;
  id: { pub: Uint8Array; priv: CryptoKey };
  ring: KemEntry[];
  cert: Signed;
  ticket: Signed;
  hostSig: string;
  hostKem: string;
  hostEp: number;
  name: string;
  guard: Record<string, number>;
  sendReserved: number;
  relay: string;
  pairedAt: number;
}

export type Outcome = ResultData['outcome'];

export class Link {
  state: StateData | null = null;
  hostOnline: boolean | null = null;
  conn: ConnState = 'idle';
  revoked = false;
  /** what the computer says about this phone's alerts (null until it has said): on, and why not if not */
  alerts: PushAckData | null = null;
  /**
   * What this connection has heard from the computer since it connected. A computer on 0.1.2 or later answers every `sync` with `pushack`; one that
   * sends state but never a `pushack` is older than that (it cannot send alerts at all). Used to say so in plain words instead of waiting forever.
   */
  stateSeen = false;
  ackSeen = false;
  private syncSentAt = 0;
  private alertWaiters: ((a: PushAckData | null) => void)[] = [];
  private testWaiters = new Map<string, (a: PushTestAck) => void>();
  readonly results = new Map<string, Outcome>();
  private connection: RelayConnection | null = null;
  private ident!: Identity;
  private ring!: KemKeyring;
  private guard!: ReplayGuard;
  private counter!: SendCounter;
  private hostId = '';
  private listeners: (() => void)[] = [];
  private waiters = new Map<string, (o: Outcome) => void>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** set once this phone is forgotten or removed: nothing may write its keys back */
  private forgotten = false;
  private saved: Saved;
  private constructor(saved: Saved) { this.saved = saved; }

  get name(): string { return this.saved.name; }
  get id8(): string { return this.ident.id.slice(0, 8); }
  get pairedAt(): number { return this.saved.pairedAt; }
  onChange(fn: () => void): void { this.listeners.push(fn); }
  private emit(): void { for (const l of this.listeners) l(); }

  static async load(): Promise<Link | null> {
    const s = await idbGet<Saved>(KEY);
    if (!s || s.v !== 1) return null;
    const l = new Link(s);
    await l.hydrate();
    return l;
  }

  private async hydrate(): Promise<void> {
    const s = this.saved;
    this.ident = { pub: s.id.pub, priv: s.id.priv, id: await idOf(s.id.pub) };
    this.ring = KemKeyring.fromEntries(s.ring, false);
    this.guard = new ReplayGuard(s.guard);
    this.hostId = await idOf(unb64u(s.hostSig));
    this.counter = new SendCounter(s.sendReserved, 25, (n) => { this.saved.sendReserved = n; void this.persist(); });
  }

  private async persist(): Promise<void> {
    if (this.forgotten) return;
    this.saved.guard = this.guard.snapshot();
    this.saved.ring = [...this.ring.all];
    await idbPut(KEY, this.saved);
  }

  private persistSoon(): void { if (this.saveTimer || this.forgotten) return; this.saveTimer = setTimeout(() => { this.saveTimer = null; void this.persist(); }, 400); }

  // ------------------------------------------------------------------ pairing
  /** step 1: make keys, send the request, return the six digits to compare with the computer */
  static async beginPair(origin: string, code: string, deviceName: string): Promise<{ sas: string; finish: () => Promise<boolean> }> {
    const secret = parseCode(code);
    if (!secret) throw new Error('That is not a valid code. It has 16 letters and numbers.');
    const keys = await derivePairKeys(secret);
    const r = await fetch(`${origin}/v1/pair/${keys.rid}`, { credentials: 'omit' });
    if (r.status === 429) throw new Error('Too many tries. Wait a minute.');
    if (!r.ok) throw new Error('No pairing is waiting for that code. Start a new one on your computer.');
    const offer = await openOffer(keys, ((await r.json()) as { offer: string }).offer);
    if (!offer) throw new Error('That code did not match. Check it and try again.');
    const id = await generateIdentity(false);
    const ring = new KemKeyring(false);
    const k = await ring.init(Date.now());
    const req = await sealRequest(keys, { v: 1, devSig: b64u(id.pub), devKem: b64u(k.pair.pub), devName: deviceName });
    const pr = await fetch(`${origin}/v1/pair/${keys.rid}/request`, { method: 'POST', body: JSON.stringify({ req }), credentials: 'omit' });
    if (!pr.ok) throw new Error('Could not reach your computer. Is the companion running?');
    const rq = ((await pr.json()) as { rq: string }).rq;
    const sas = await shortAuthString(unb64u(offer.hostSig), unb64u(offer.hostKem), id.pub, k.pair.pub);
    const finish = async (): Promise<boolean> => {
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        const res = await fetch(`${origin}/v1/pair/${keys.rid}/result?rq=${rq}`, { credentials: 'omit' });
        if (res.status === 410 || res.status === 404) return false;
        const j = (await res.json()) as { result?: string };
        if (!j.result) continue;
        const body = await openResult(keys, j.result);
        const cert = body ? await verifyDeviceCert(body.cert, unb64u(offer.hostSig)) : null;
        if (!body || !cert || cert.dev !== id.id) return false;
        const saved: Saved = {
          v: 1, id: { pub: id.pub, priv: id.priv }, ring: [...ring.all], cert: body.cert, ticket: offer.ticket, hostSig: offer.hostSig, hostKem: offer.hostKem, hostEp: body.hostEp,
          name: deviceName, guard: {}, sendReserved: 0, relay: origin, pairedAt: Date.now(),
        };
        await idbPut(KEY, saved);
        return true;
      }
      return false;
    };
    return { sas, finish };
  }

  // ------------------------------------------------------------------ connection
  connect(): void {
    const url = `${this.saved.relay.replace(/^http/, 'ws')}/v1/ws`;
    this.connection = new RelayConnection({
      url, role: 'device', identity: this.ident, ticket: this.saved.ticket, cert: this.saved.cert, reconnect: true,
      onFrame: (f) => this.onFrame(f),
      onState: (s, info) => {
        this.conn = s;
        if (info?.peerOnline !== undefined) this.hostOnline = info.peerOnline;
        if (s === 'online') {
          this.stateSeen = false; this.ackSeen = false; this.connectedAt = Date.now();
          for (const ms of [6500, 8500]) setTimeout(() => this.emit(), ms); // the "no answer yet" verdicts below are time-based: draw again when they can change
          void this.sendSync(); void this.maybeRotate(); void this.resendAlerts(); }
        if (s === 'killed') { this.revoked = true; }
        this.emit();
      },
      onPresence: (h) => { this.hostOnline = h; if (h) { void this.sendSync(); void this.resendAlerts(); } this.emit(); }, // the computer (re)started: tell it again what this page can read
    });
    this.connection.start();
  }

  disconnect(): void { this.connection?.stop(); this.connection = null; }

  private async onFrame(f: Frame): Promise<void> {
    const r = await openMessage(f, { me: { id: this.ident.id, ring: this.ring }, senderKey: (id) => (id === this.hostId ? unb64u(this.saved.hostSig) : null), guard: this.guard, now: Date.now() });
    const h = peekHeader(f);
    if (h) this.connection?.ack(h.header.m);
    if (!r.ok) return;
    this.persistSoon();
    switch (r.msg.kind) {
      case 'state': { const s = StateData.safeParse(r.msg.data); if (s.success) { this.state = s.data; this.stateSeen = true; this.badState = false; this.emit(); } else { this.stateSeen = true; this.badState = true; this.emit(); } return; }
      case 'result': { const x = ResultData.safeParse(r.msg.data); if (x.success) { this.results.set(x.data.rid, x.data.outcome); if (['applied', 'sent', 'denied', 'expired', 'stale', 'failed'].includes(x.data.outcome)) this.dropPending(x.data.rid); this.waiters.get(x.data.rid)?.(x.data.outcome); this.waiters.delete(x.data.rid); this.emit(); } return; }
      case 'keyupdate': { const d = r.msg.data as { ep?: number; kem?: string }; if (typeof d.ep === 'number' && typeof d.kem === 'string' && d.ep > this.saved.hostEp) { this.saved.hostEp = d.ep; this.saved.hostKem = d.kem; void this.persist(); } return; }
      case 'pushack': { const a = PushAckData.safeParse(r.msg.data); if (a.success) { this.ackSeen = true; this.alerts = a.data; for (const w of this.alertWaiters.splice(0)) w(a.data); this.emit(); } return; }
      case 'pushtestack': { const a = PushTestAck.safeParse(r.msg.data); if (a.success) this.testWaiters.get(a.data.n)?.(a.data); return; }
      case 'revoked': { this.revoked = true; await this.forgetLocal(); this.emit(); return; }
      default: for (const fn of this.kindListeners.get(r.msg.kind) ?? []) fn(r.msg.data); return;
    }
  }

  /** the computer has answered for this request: stop offering it until the next state arrives */
  private dropPending(rid: string): void {
    if (!this.state) return;
    this.state = { ...this.state, sessions: this.state.sessions.map((s) => (s.pending?.rid === rid ? (({ pending: _p, ...rest }) => rest)(s) : s)) };
  }

  /** a state the page could not read (a computer newer than this page, or a damaged one); shown as a plain notice */
  badState = false;
  /** when this connection became ready (ms since 1970) */
  connectedAt = 0;

  /**
   * Protocol 3 (remote control) rides the same sealed channel: the control transport sends commands with this and hears the computer's answers through
   * `onKind` (cresult, tail, hist, su_*). Nothing here interprets them.
   */
  sendKind(kind: string, data: unknown, replace?: string): Promise<boolean> { return this.send(kind, data, replace); }
  private kindListeners = new Map<string, Set<(data: unknown) => void>>();
  /** hears every message of `kind` from the computer; returns the function that stops listening */
  onKind(kind: string, fn: (data: unknown) => void): () => void {
    let set = this.kindListeners.get(kind);
    if (!set) { set = new Set(); this.kindListeners.set(kind, set); }
    set.add(fn);
    return () => { set.delete(fn); };
  }
  /** resolves with the next message of `kind`; rejects after `ms` */
  nextKind(kind: string, ms: number): Promise<unknown> {
    return new Promise((ok, bad) => { const t = setTimeout(() => { off(); bad(new Error(`no ${kind} from the computer within ${ms} ms`)); }, ms); const off = this.onKind(kind, (d) => { clearTimeout(t); off(); ok(d); }); });
  }
  private async send(kind: string, data: unknown, replaceKey?: string): Promise<boolean> {
    if (!this.connection) return false;
    const replace = replaceKey ?? (DEVICE_REPLACE_KEYS as Record<string, string>)[kind];
    const frame = await sealMessage({ from: this.ident, to: { id: this.hostId, kemPub: unb64u(this.saved.hostKem), epoch: this.saved.hostEp }, seq: this.counter.next() + 1, now: Date.now(), ttlMs: 120_000, kind, data, ...(replace ? { replace } : {}) });
    return this.connection.sendFrame(frame);
  }

  /** asks for the state and says what this page can read (long messages); a computer from before 0.1.3 ignores the extra field */
  private async sendSync(): Promise<void> { this.syncSentAt = Date.now(); await this.send('sync', { proto: PROTO_VERSION, caps: [CAP_LONG] }); }

  /** true when the computer sent its state but has not answered the alerts question since this connection began: it is older than 0.1.2 */
  hostLacksAlerts(graceMs = 6000): boolean { return this.conn === 'online' && this.hostOnline !== false && this.stateSeen && !this.ackSeen && Date.now() - this.syncSentAt > graceMs; }

  /**
   * Gives the computer this phone's Web Push subscription (or withdraws it), inside the encrypted channel, and waits for its answer. Resolves null if
   * the computer is not reachable: the page sends the subscription again whenever it connects, as long as the person has alerts on.
   */
  async setAlerts(sub: { endpoint: string; p256dh: string; auth: string } | null, waitMs = 12_000): Promise<{ sent: boolean; ack: PushAckData | null }> {
    let waiter!: (a: PushAckData | null) => void;
    const answer = new Promise<PushAckData | null>((ok) => { const t = setTimeout(() => { this.alertWaiters = this.alertWaiters.filter((w) => w !== waiter); ok(null); }, waitMs); waiter = (a) => { clearTimeout(t); ok(a); }; this.alertWaiters.push(waiter); });
    if (!(await this.send('push', sub ? { on: true, sub } : { on: false }))) { this.alertWaiters = this.alertWaiters.filter((w) => w !== waiter); return { sent: false, ack: null }; }
    return { sent: true, ack: await answer };
  }

  /**
   * "Send a test alert": asks the computer to push a test alert to this phone through the same path real alerts take. `onStage` hears each step the
   * computer reports (received, pushed, or failed and where). Resolves with the last thing heard, or null when the computer said nothing at all.
   */
  async sendTestAlert(n: string, onStage: (a: PushTestAck) => void, waitMs = 10_000): Promise<PushTestAck | null> {
    let last: PushTestAck | null = null;
    return new Promise<PushTestAck | null>((done) => {
      const finish = (): void => { clearTimeout(t); this.testWaiters.delete(n); done(last); };
      const t = setTimeout(finish, waitMs);
      this.testWaiters.set(n, (a) => { last = a; onStage(a); if (a.stage !== 'received') finish(); });
      void this.send('pushtest', { n }).then((ok) => { if (!ok) finish(); });
    });
  }

  /** the subscription can change (the browser rotates it); the computer always gets the current one while alerts are on */
  private async resendAlerts(): Promise<void> {
    if (!wantsAlerts()) return;
    const sub = await currentSubscription();
    if (sub) await this.send('push', { on: true, sub });
  }

  /** the device rotates its encryption key every 7 days and tells the computer */
  private async maybeRotate(): Promise<void> {
    if (!this.ring.rotationDue(Date.now(), ROTATE_MS)) return;
    const e = await this.ring.rotate(Date.now());
    await this.persist();
    await this.send('keyupdate', { ep: e.epoch, kem: b64u(e.pair.pub) });
    this.ring.prune(Date.now());
  }

  /** sends an action and waits for the computer's answer (or gives up) */
  async act(sid: string, p: { rid: string; bind: string }, a: 'approve' | 'deny' | 'reply', opt?: string): Promise<Outcome | 'timeout' | 'offline'> {
    const nonce = b64u(crypto.getRandomValues(new Uint8Array(9)));
    const data: ActionData = { rid: p.rid, sid, a, bind: p.bind, nonce, ...(opt ? { opt } : {}) };
    const answer = new Promise<Outcome | 'timeout'>((ok) => { this.waiters.set(p.rid, ok); setTimeout(() => { if (this.waiters.delete(p.rid)) ok('timeout'); }, 20_000); });
    if (!(await this.send('action', data))) { this.waiters.delete(p.rid); return 'offline'; }
    return answer;
  }

  // ------------------------------------------------------------------ forgetting
  private async forgetLocal(): Promise<void> {
    this.forgotten = true;
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    this.disconnect();
    await idbDel(KEY);
  }

  async forget(): Promise<void> {
    this.connection?.send({ t: 'revoke_self' });
    await new Promise((r) => setTimeout(r, 150));
    await this.forgetLocal();
  }
}

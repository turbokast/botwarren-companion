/**
 * The companion host: owns the host's keys, the paired devices, the relay connection, the session table, and decides every action.
 * The relay and the website only ever carry ciphertext. See docs/PROTOCOL.md.
 * Licence: Apache-2.0.
 */
import { z } from 'zod';
import {
  ActionData, KemKeyring, ReplayGuard, SendCounter, StateData as StateSchema, b64u, derivePairKeys, exportIdentityPkcs8, formatCode, generateIdentity, importIdentityPkcs8, idOf, newPairingSecret,
  openMessage, openRequest, peekHeader, sealMessage, sealOffer, sealResult, shortAuthString, signDeviceCert, signRevocation, unb64u, importKemPrivatePkcs8, exportKemPrivatePkcs8,
  KeyUpdateData, PAIR_TTL_MS, PushAckData, PushRegData, PushTestData, STATE_REPLACE_KEY, SyncData, TEST_REPLACE_KEY, CAP_LONG, maxInnerFor, Ticket,
  type Frame, type Identity, type KemEntry, type Signed, type PairKeys, type PushTestAck, type StateData,
} from './protocol/index.ts';
import { fitLong, toLegacy } from './stateview.ts';
import { RelayConnection, type ConnectionOptions, type ConnState } from './link/connection.ts';
import { LEGACY_FRAME_BYTES } from './protocol/index.ts';
import { ActionLimiter, needsLocalConfirmation, relayAllowed } from './policy.ts';
import { SessionTable, type Sess } from './sessions.ts';
import { AlertPlanner, type Episode } from './alerts.ts';
import { sealAlert, sealTestAlert } from './webpush.ts';
import { secretEnvValues } from './mask.ts';
import type { Config, DeviceRecord, Store } from './store.ts';

export interface LocalConfirmRequest {
  kind: 'approve' | 'reply' | 'pair';
  agent: string;
  label: string;
  tool?: string | undefined;
  preview: string;
  device: string;
  /** pairing only: the six digits to compare */
  sas?: string | undefined;
  startedAt?: number | undefined;
}

export interface ConnectionLike { start(): void; stop(): void; send(o: unknown): boolean; sendFrame(f: Frame): boolean; ack(m: string): void; readonly online: boolean }

export interface HostOptions {
  store: Store;
  now?: () => number;
  /** asks the person at this computer; resolves false on "no" or after 60 s */
  confirmer: (r: LocalConfirmRequest) => Promise<boolean>;
  makeConnection?: (o: ConnectionOptions) => ConnectionLike;
  env?: Record<string, string | undefined>;
  onState?: (s: ConnState) => void;
  /** at least this long between two state pushes that are not urgent (tests shorten it; default 2000) */
  minStateGapMs?: number;
}

export const MAX_DEVICES = 8;
const STATE_TTL_MS = 5 * 60_000;
const ACTION_RESULT_TTL_MS = 5 * 60_000;
const CONFIRM_TIMEOUT_MS = 60_000;
/** at least this long between two state pushes that are not urgent (a pending request changing is urgent) */
const MIN_STATE_GAP_MS = 2_000;
const ACK_REPLACE_KEY = 'a';
const ALERT_TTL_S = 600;
const ALERT_TOPIC = 'bw-waiting';
const ID_FIELDS = { rotateEveryMs: 7 * 86_400_000, seenWithinMs: 24 * 3_600_000 };

interface ActivePairing { keys: PairKeys; expires: number; confirm: (r: LocalConfirmRequest) => Promise<boolean>; done: boolean }

export class CompanionHost {
  readonly store: Store;
  readonly sessions: SessionTable;
  private readonly now: () => number;
  private readonly opts: HostOptions;
  identity!: Identity;
  ring!: KemKeyring;
  private devices: DeviceRecord[] = [];
  private revoked = new Set<string>();
  private guard = new ReplayGuard();
  private counters = new Map<string, SendCounter>();
  private conn: ConnectionLike | null = null;
  private connState: ConnState = 'idle';
  private pairings = new Map<string, ActivePairing>();
  private limiter: ActionLimiter | null = null;
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private pushDue = 0;
  private lastPushAt = 0;
  /** per device: what its last state looked like (without the counter), so an unchanged state is never sent again */
  private lastSig = new Map<string, string>();
  private readonly alerts: AlertPlanner;
  private alertTimer: ReturnType<typeof setTimeout> | null = null;
  private alertQ = 0;
  /** relay delivery requests in flight: request id -> device id (and the phone's test id when it is a test alert) */
  private alertAsks = new Map<string, { dev: string; test?: string; timer?: ReturnType<typeof setTimeout> }>();
  /** the biggest frame the relay we are connected to accepts (it says so in `ready`; a relay that does not say is a 0.1.2 relay: 16 KB) */
  private relayMaxFrame = LEGACY_FRAME_BYTES;
  private testLog = new Map<string, number[]>();
  private house: ReturnType<typeof setInterval> | null = null;
  private rev = 0;

  constructor(o: HostOptions) {
    this.opts = o; this.store = o.store; this.now = o.now ?? Date.now;
    this.sessions = new SessionTable(this.now, () => secretEnvValues(o.env ?? process.env));
    this.alerts = new AlertPlanner(() => this.store.config().alerts);
  }

  // ------------------------------------------------------------------ keys and files
  async init(): Promise<void> {
    const t = this.now();
    const idFile = this.store.readJson('identity.json', z.object({ pkcs8: z.string(), pub: z.string() }).nullable(), () => null);
    if (idFile) this.identity = await importIdentityPkcs8(unb64u(idFile.pkcs8), unb64u(idFile.pub), true);
    else {
      this.identity = await generateIdentity(true);
      this.store.writeJson('identity.json', { pkcs8: b64u(await exportIdentityPkcs8(this.identity)), pub: b64u(this.identity.pub) });
      this.store.audit('host_key_created', { host: this.identity.id.slice(0, 8) });
    }
    const ringFile = this.store.readJson('ring.json', z.array(z.object({ epoch: z.number(), priv: z.string(), pub: z.string(), createdAt: z.number(), retiredAt: z.number().nullable() })), () => []);
    if (ringFile.length) {
      const entries: KemEntry[] = [];
      for (const e of ringFile) entries.push({ epoch: e.epoch, pair: { pub: unb64u(e.pub), priv: await importKemPrivatePkcs8(unb64u(e.priv), true) }, createdAt: e.createdAt, retiredAt: e.retiredAt });
      this.ring = KemKeyring.fromEntries(entries, true);
    } else {
      this.ring = new KemKeyring(true);
      await this.ring.init(t);
      await this.saveRing();
    }
    this.devices = this.store.devices();
    const st = this.store.state();
    this.guard = new ReplayGuard(st.replay);
    this.rev = st.rev;
    for (const r of st.revocations) { try { const j = JSON.parse(new TextDecoder().decode(unb64u(r.j))) as { dev?: string }; if (j.dev) this.revoked.add(j.dev); } catch { /* skip */ } }
    for (const d of this.devices) this.counters.set(d.id, this.counterFor(d.id, st.sendReserved[d.id] ?? 0));
  }

  private async saveRing(): Promise<void> {
    const out = [];
    for (const e of this.ring.all) out.push({ epoch: e.epoch, priv: b64u(await exportKemPrivatePkcs8(e.pair.priv)), pub: b64u(e.pair.pub), createdAt: e.createdAt, retiredAt: e.retiredAt });
    this.store.writeJson('ring.json', out);
  }

  private counterFor(devId: string, reserved: number): SendCounter {
    return new SendCounter(reserved, 100, (n) => { const s = this.store.state(); s.sendReserved[devId] = n; this.store.saveState(s); });
  }

  get hostId(): string { return this.identity.id; }
  get hostSigPub(): string { return b64u(this.identity.pub); }
  listDevices(): readonly DeviceRecord[] { return this.devices; }
  get relayState(): ConnState { return this.connState; }
  get config(): Config { return this.store.config(); }

  // ------------------------------------------------------------------ relay connection
  start(): boolean {
    const enr = this.store.enrollment();
    const cfg = this.store.config();
    const url = enr?.relayUrl || cfg.relayUrl;
    if (!enr || !url) return false;
    if (!relayAllowed(url, cfg.allowRelayHosts)) { this.store.audit('relay_refused', { reason: 'not_allowed' }); return false; }
    const ws = url.replace(/^http/, 'ws').replace(/\/$/, '') + (url.includes('/v1/ws') ? '' : '/v1/ws');
    const make = this.opts.makeConnection ?? ((o: ConnectionOptions) => new RelayConnection(o));
    this.conn = make({
      url: ws, role: 'host', identity: this.identity, ticket: enr.ticket, reconnect: true,
      onFrame: (f) => this.onFrame(f),
      onState: (s, info) => { this.connState = s; if (s === 'online') this.relayMaxFrame = info?.maxFrame ?? LEGACY_FRAME_BYTES; this.opts.onState?.(s); if (s === 'killed') this.store.audit('relay_killed'); },
      onControl: (m) => { void this.onControl(m); },
      onReady: (send) => {
        for (const r of this.store.state().revocations) send({ t: 'revoke', rev: r });
        for (const [rid, p] of this.pairings) if (!p.done && p.expires > this.now()) void this.postOffer(rid, p);
        this.lastSig.clear(); // a new connection: the relay may have lost its queue, so the next state goes out whatever it was
        this.schedulePush(0);
      },
    });
    this.conn.start();
    this.house = setInterval(() => { void this.housekeeping(); }, 30_000);
    this.house.unref?.();
    return true;
  }

  stop(): void {
    this.conn?.stop(); this.conn = null;
    if (this.house) clearInterval(this.house);
    if (this.pushTimer) clearTimeout(this.pushTimer);
    if (this.alertTimer) clearTimeout(this.alertTimer);
    for (const a of this.alertAsks.values()) if (a.timer) clearTimeout(a.timer);
    this.pushTimer = null; this.alertTimer = null;
    for (const s of this.sessions.sessions.values()) this.sessions.clearPending(s, 'stop');
  }

  // ------------------------------------------------------------------ pairing
  /** shows nothing itself: returns the code for the CLI to display. `confirm` is asked once a device asks to pair. */
  async beginPairing(confirm: (r: LocalConfirmRequest) => Promise<boolean>): Promise<{ code: string; expiresAt: number }> {
    if (this.devices.length >= MAX_DEVICES) throw new Error('device_limit');
    const secret = newPairingSecret();
    const keys = await derivePairKeys(secret);
    const p: ActivePairing = { keys, expires: this.now() + PAIR_TTL_MS, confirm, done: false };
    this.pairings.set(keys.rid, p);
    this.store.audit('pairing_started', { expires: new Date(p.expires).toISOString() });
    if (this.conn?.online) await this.postOffer(keys.rid, p);
    return { code: formatCode(secret), expiresAt: p.expires };
  }

  private async postOffer(rid: string, p: ActivePairing): Promise<void> {
    const enr = this.store.enrollment();
    if (!enr) return;
    const blob = await sealOffer(p.keys, { v: 1, hostSig: b64u(this.identity.pub), hostKem: b64u(this.ring.current.pair.pub), hostEp: this.ring.current.epoch, hostName: this.store.config().name, ticket: enr.ticket, t: this.now() });
    this.conn?.send({ t: 'pair_offer', rid, offer: blob });
  }

  private async onControl(m: Record<string, unknown>): Promise<void> {
    if (m.t === 'pair_request' && typeof m.rid === 'string' && typeof m.rq === 'string' && typeof m.req === 'string') await this.onPairRequest(m.rid, m.rq, m.req);
    else if (m.t === 'push_result') this.onPushResult(m);
    else if (m.t === 'error' && m.code === 'quota') this.store.audit('relay_quota');
  }

  private async onPairRequest(rid: string, rq: string, reqBlob: string): Promise<void> {
    const p = this.pairings.get(rid);
    const reject = (why: string): void => { this.store.audit('pairing_rejected', { why }); this.conn?.send({ t: 'pair_result', rid, rq, rejected: true }); };
    if (!p || p.done || p.expires <= this.now()) return reject('no_active_pairing');
    const req = await openRequest(p.keys, reqBlob);
    if (!req) return reject('bad_request');
    if (this.devices.length >= MAX_DEVICES) return reject('device_limit');
    const sas = await shortAuthString(this.identity.pub, this.ring.current.pair.pub, unb64u(req.devSig), unb64u(req.devKem));
    this.store.audit('pairing_request', { name_len: req.devName.length });
    const startedAt = p.expires - PAIR_TTL_MS;
    const ok = await withTimeout(p.confirm({ kind: 'pair', agent: '', label: '', preview: '', device: req.devName, sas, startedAt }), CONFIRM_TIMEOUT_MS);
    if (!ok) return reject('declined');
    if (p.done) return reject('already_paired');
    p.done = true;
    const enr = this.store.enrollment();
    if (!enr) return reject('not_enrolled');
    const ticket = Ticket.parse(JSON.parse(new TextDecoder().decode(unb64u(enr.ticket.j))));
    const devId = await idOf(unb64u(req.devSig));
    const st = this.store.state(); st.certCtr += 1; this.store.saveState(st);
    const cert = await signDeviceCert(this.identity, { v: 1, acct: ticket.acct, host: this.identity.id, dev: devId, sig: req.devSig, kem: req.devKem, name: req.devName, iat: this.now(), ctr: st.certCtr });
    const rec: DeviceRecord = { id: devId, name: req.devName, sig: req.devSig, kem: req.devKem, kemEpoch: 0, cert, pairedAt: this.now(), lastSeen: null };
    this.devices = [...this.devices.filter((d) => d.id !== devId), rec];
    this.store.saveDevices(this.devices);
    this.counters.set(devId, this.counterFor(devId, 0));
    this.pairings.delete(rid);
    this.store.audit('device_paired', { device: devId.slice(0, 8), name_len: req.devName.length });
    this.conn?.send({ t: 'pair_result', rid, rq, result: await sealResult(p.keys, { v: 1, cert, hostEp: this.ring.current.epoch }) });
  }

  // ------------------------------------------------------------------ devices
  async revokeDevice(idOrName: string): Promise<boolean> {
    const d = this.devices.find((x) => x.id === idOrName || x.name === idOrName || x.id.startsWith(idOrName));
    if (!d) return false;
    await this.sendTo(d, 'revoked', { reason: 'removed' }, 60_000).catch(() => undefined);
    this.devices = this.devices.filter((x) => x.id !== d.id);
    this.store.saveDevices(this.devices);
    this.revoked.add(d.id); this.guard.forget(d.id); this.counters.delete(d.id);
    const rev = await signRevocation(this.identity, { v: 1, host: this.identity.id, dev: d.id, iat: this.now() });
    const st = this.store.state(); st.revocations = [...st.revocations, rev].slice(-200); this.store.saveState(st);
    this.conn?.send({ t: 'revoke', rev });
    this.store.audit('device_revoked', { device: d.id.slice(0, 8) });
    return true;
  }

  /** the account was switched off or the companion is being removed: tell every device, then stop */
  async revokeAll(reason: 'account_off' | 'removed'): Promise<void> {
    for (const d of [...this.devices]) { await this.sendTo(d, 'revoked', { reason }, 60_000).catch(() => undefined); await this.revokeDevice(d.id); }
  }

  // ------------------------------------------------------------------ sending
  private async sendTo(d: DeviceRecord, kind: string, data: unknown, ttlMs: number, replace?: string): Promise<boolean> {
    if (!this.conn?.online) return false;
    let c = this.counters.get(d.id);
    if (!c) { c = this.counterFor(d.id, this.store.state().sendReserved[d.id] ?? 0); this.counters.set(d.id, c); }
    const frame = await sealMessage({ from: this.identity, to: { id: d.id, kemPub: unb64u(d.kem), epoch: d.kemEpoch }, seq: c.next(), now: this.now(), ttlMs, kind, data, ...(replace ? { replace } : {}) });
    return this.conn.sendFrame(frame);
  }

  /**
   * The state as one device gets it: `long` for a page that said it can read long messages (and a relay that carries big frames), otherwise the short
   * form every version understands (see stateview.ts). Every form stays inside one padded frame.
   */
  buildState(rev = this.rev, long = false): StateData {
    const cfg = this.store.config();
    const presets = cfg.presets.map((p) => ({ id: p.id, label: p.label }));
    const full = this.sessions.toState(rev, { name: cfg.name, paused: cfg.paused, confirm: cfg.confirm, devices: this.devices.map((d) => ({ id8: d.id.slice(0, 8), name: d.name, lastSeen: d.lastSeen === null ? null : Math.floor(d.lastSeen / 60_000) * 60_000 })) }, presets);
    return StateSchema.parse(long ? fitLong(full, this.longBudget()) : toLegacy(full));
  }

  /** JSON bytes the long form may take: what the relay's frame limit allows, less the envelope around the state */
  private longBudget(): number { return Math.min(65_534, maxInnerFor(this.relayMaxFrame)) - 220; }
  private canLong(d: DeviceRecord): boolean { return !!d.caps?.includes(CAP_LONG) && this.longBudget() > 8000; }

  /**
   * COALESCED. Many hook events (every tool call fires one) become at most one state message per 2 seconds, and a state that has not changed since
   * the device last got one is not sent at all. `delayMs` 0 is for a pending request appearing or going (the person is waiting for that): it goes at once.
   * Whatever is still queued at the relay for an absent phone is superseded by the next state (the replace key), so a phone that comes back gets the latest
   * state of every session and the request that is pending now, not a stream of what happened meanwhile.
   */
  schedulePush(delayMs = 150): void {
    this.checkAlerts();
    const wait = delayMs === 0 ? 0 : Math.max(delayMs, this.lastPushAt + (this.opts.minStateGapMs ?? MIN_STATE_GAP_MS) - this.now());
    const due = this.now() + wait;
    if (this.pushTimer) { if (this.pushDue <= due) return; clearTimeout(this.pushTimer); }
    this.pushDue = due;
    this.pushTimer = setTimeout(() => { this.pushTimer = null; void this.pushState(); }, wait);
    this.pushTimer.unref?.();
  }

  /** sends the current state to every device whose last state differs (or to `only`; `force` sends it even if unchanged, e.g. when a device asks to sync) */
  async pushState(only?: DeviceRecord, force = false): Promise<void> {
    if (!this.conn?.online) return;
    const forms = new Map<boolean, { st: StateData; sig: string }>();
    const form = (long: boolean): { st: StateData; sig: string } => {
      let f = forms.get(long);
      if (!f) { const st = this.buildState(this.rev, long); f = { st, sig: JSON.stringify({ ...st, rev: 0 }) }; forms.set(long, f); }
      return f;
    };
    // the signature includes the form, so a phone that just said it can read long messages gets its state again in that form
    const targets = (only ? [only] : this.devices).filter((d) => force || this.lastSig.get(d.id) !== form(this.canLong(d)).sig);
    if (targets.length === 0) return;
    this.rev += 1; this.lastPushAt = this.now();
    const st = this.store.state(); st.rev = this.rev; this.store.saveState(st);
    for (const d of targets) {
      const f = form(this.canLong(d));
      this.lastSig.set(d.id, f.sig);
      await this.sendTo(d, 'state', { ...f.st, rev: this.rev }, STATE_TTL_MS, STATE_REPLACE_KEY).catch(() => undefined);
    }
  }

  // ------------------------------------------------------------------ phone alerts
  private waitingEpisodes(): Episode[] {
    const out: Episode[] = [];
    for (const s of this.sessions.sessions.values()) if (s.pending && s.status !== 'ended' && s.pending.pub.expires > this.now()) out.push({ rid: s.pending.pub.rid, kind: s.pending.pub.kind });
    return out;
  }

  /** looks at what is waiting and sends at most one content-free alert (see alerts.ts for the rules); re-arms itself for the next look */
  checkAlerts(): void {
    if (this.alertTimer) { clearTimeout(this.alertTimer); this.alertTimer = null; }
    if (!this.conn) return;
    const t = this.now();
    const plan = this.alerts.plan(this.waitingEpisodes(), t, this.store.config().paused);
    if (plan.fire) {
      if (!this.fireAlert(plan.rid)) this.armAlert(15_000); // not delivered (no relay connection yet): try again shortly
      return;
    }
    if (plan.recheckMs !== null) this.armAlert(plan.recheckMs);
  }

  private armAlert(ms: number): void {
    this.alertTimer = setTimeout(() => { this.alertTimer = null; this.checkAlerts(); }, Math.max(250, ms));
    this.alertTimer.unref?.();
  }

  /**
   * Seals one alert per phone that turned alerts on (the payload is `{v:1,k:"waiting",r:<request id>}`, sealed for that phone's own Web Push keys)
   * and hands the ciphertext to the relay, which delivers it. Returns false when nothing could be handed over.
   */
  private fireAlert(rid: string | null): boolean {
    const targets = this.devices.filter((d) => d.push);
    if (targets.length === 0) return true; // nobody to tell; a phone that turns alerts on later is told about what is still waiting
    if (!this.conn?.online) return false;
    let n = 0;
    for (const d of targets) {
      let body: Buffer;
      try { body = sealAlert(d.push!, rid ?? undefined); } catch { this.store.audit('alert_not_sealed', { device: d.id.slice(0, 8) }); continue; }
      const q = `a${(this.alertQ = (this.alertQ + 1) % 1_000_000).toString(36)}`;
      this.rememberAsk(q, { dev: d.id });
      if (this.conn.send({ t: 'push', q, ep: d.push!.endpoint, body: b64u(body), ttl: ALERT_TTL_S, urgency: 'high', topic: ALERT_TOPIC })) n++;
    }
    if (n === 0) return false;
    this.alerts.markSent(this.now());
    this.store.audit('alert_sent', { devices: n, single: rid !== null });
    return true;
  }

  private rememberAsk(q: string, a: { dev: string; test?: string; timer?: ReturnType<typeof setTimeout> }): void {
    this.alertAsks.set(q, a);
    if (this.alertAsks.size > 64) { const k = this.alertAsks.keys().next().value as string; const old = this.alertAsks.get(k); if (old?.timer) clearTimeout(old.timer); this.alertAsks.delete(k); }
  }

  /** the relay's answer to a delivery request */
  private onPushResult(m: Record<string, unknown>): void {
    const ask = typeof m.q === 'string' ? this.alertAsks.get(m.q) : undefined;
    if (typeof m.q === 'string') this.alertAsks.delete(m.q);
    if (ask?.timer) clearTimeout(ask.timer);
    const d = ask ? this.devices.find((x) => x.id === ask.dev) : undefined;
    const why = typeof m.why === 'string' ? m.why.slice(0, 20) : 'unknown';
    if (m.ok === true) { if (ask?.test && d) void this.testAck(d, { n: ask.test, stage: 'pushed' }); return; }
    if (m.gone === true && d) {
      if (d.push) { delete d.push; this.store.saveDevices(this.devices); this.store.audit('alert_subscription_gone', { device: d.id.slice(0, 8) }); }
      if (ask?.test) void this.testAck(d, { n: ask.test, stage: 'failed', why: 'push_gone' });
      return;
    }
    this.store.audit('alert_not_delivered', { why });
    if (ask?.test && d) void this.testAck(d, { n: ask.test, stage: 'failed', why: why === 'disabled' ? 'relay_off' : why === 'rate_limited' ? 'relay_busy' : why === 'bad_endpoint' ? 'bad_endpoint' : 'push_refused' });
  }

  private async testAck(dev: DeviceRecord, ack: PushTestAck): Promise<void> {
    await this.sendTo(dev, 'pushtestack', ack, 2 * 60_000, TEST_REPLACE_KEY).catch(() => undefined);
  }

  /**
   * "Send a test alert" from a phone: the same path a real alert takes (seal for that phone's own keys, hand to the relay, push service, phone), with
   * answers back as it goes: `received` (this computer has the request), `pushed` (the relay's push service accepted it) or `failed` with where it stopped.
   * Not part of the hourly alert allowance, but limited itself: one every 10 s and 10 an hour per phone.
   */
  private async onPushTest(dev: DeviceRecord, data: unknown): Promise<void> {
    const r = PushTestData.safeParse(data);
    if (!r.success) { this.store.audit('pushtest_rejected', { device: dev.id.slice(0, 8) }); return; }
    const n = r.data.n; const t = this.now();
    const log = (this.testLog.get(dev.id) ?? []).filter((x) => t - x < 3_600_000);
    if (log.length >= 10 || (log.length > 0 && t - log[log.length - 1]! < 10_000)) { this.testLog.set(dev.id, log); return this.testAck(dev, { n, stage: 'failed', why: 'rate_limited' }); }
    log.push(t); this.testLog.set(dev.id, log);
    await this.testAck(dev, { n, stage: 'received' });
    if (!dev.push) return this.testAck(dev, { n, stage: 'failed', why: 'no_subscription' });
    if (!this.store.config().alerts.enabled) return this.testAck(dev, { n, stage: 'failed', why: 'alerts_off' });
    if (!this.conn?.online) return this.testAck(dev, { n, stage: 'failed', why: 'relay_off' });
    let body: Buffer;
    try { body = sealTestAlert(dev.push, n); } catch { this.store.audit('alert_not_sealed', { device: dev.id.slice(0, 8) }); return this.testAck(dev, { n, stage: 'failed', why: 'not_sent' }); }
    const q = `a${(this.alertQ = (this.alertQ + 1) % 1_000_000).toString(36)}`;
    const timer = setTimeout(() => { if (this.alertAsks.delete(q)) void this.testAck(dev, { n, stage: 'failed', why: 'not_sent' }); }, 20_000);
    timer.unref?.();
    this.rememberAsk(q, { dev: dev.id, test: n, timer });
    if (!this.conn.send({ t: 'push', q, ep: dev.push.endpoint, body: b64u(body), ttl: 120, urgency: 'high', topic: ALERT_TOPIC })) { this.alertAsks.delete(q); clearTimeout(timer); return this.testAck(dev, { n, stage: 'failed', why: 'relay_off' }); }
    this.store.audit('alert_test_sent', { device: dev.id.slice(0, 8) });
  }

  /** a phone turns alerts on or off (inside the encrypted channel) and is told what the computer now has */
  private async onPushReg(dev: DeviceRecord, data: unknown): Promise<void> {
    const r = PushRegData.safeParse(data);
    if (!r.success) { this.store.audit('push_rejected', { device: dev.id.slice(0, 8) }); await this.sendAck(dev, { on: false, why: 'rejected' }); return; }
    if (r.data.on && r.data.sub) {
      const changed = JSON.stringify(dev.push) !== JSON.stringify(r.data.sub);
      dev.push = r.data.sub;
      if (changed) { this.store.saveDevices(this.devices); this.store.audit('alerts_on', { device: dev.id.slice(0, 8) }); }
    } else if (dev.push) { delete dev.push; this.store.saveDevices(this.devices); this.store.audit('alerts_off', { device: dev.id.slice(0, 8) }); }
    await this.sendAck(dev);
    if (dev.push) this.checkAlerts(); // something may already be waiting
  }

  private async sendAck(dev: DeviceRecord, override?: PushAckData): Promise<void> {
    const ack: PushAckData = override ?? (dev.push ? { on: true, why: this.store.config().alerts.enabled ? 'ok' : 'host_off' } : { on: false, why: 'off' });
    await this.sendTo(dev, 'pushack', ack, STATE_TTL_MS, ACK_REPLACE_KEY).catch(() => undefined); // the newest answer supersedes an older one still queued
  }

  // ------------------------------------------------------------------ receiving
  private senderKey = (id: string): Uint8Array | null => { const d = this.devices.find((x) => x.id === id); return d ? unb64u(d.sig) : null; };

  private async onFrame(f: Frame): Promise<void> {
    const peek = peekHeader(f);
    const r = await openMessage(f, { me: { id: this.identity.id, ring: this.ring }, senderKey: this.senderKey, isRevoked: (id) => this.revoked.has(id), guard: this.guard, now: this.now() });
    if (peek) this.conn?.ack(peek.header.m);
    if (!r.ok) { this.store.audit('frame_rejected', { code: r.code }); return; }
    const st = this.store.state(); st.replay = this.guard.snapshot(); this.store.saveState(st);
    const dev = this.devices.find((d) => d.id === r.msg.from)!;
    dev.lastSeen = this.now(); this.store.saveDevices(this.devices);
    switch (r.msg.kind) {
      case 'sync': {
        const c = SyncData.safeParse(r.msg.data);
        const caps = c.success ? (c.data.caps ?? []) : [];
        if (JSON.stringify(caps) !== JSON.stringify(dev.caps ?? [])) { if (caps.length) dev.caps = caps; else delete dev.caps; this.store.saveDevices(this.devices); }
        await this.pushState(dev, true);
        return this.sendAck(dev);
      }
      case 'push': return this.onPushReg(dev, r.msg.data);
      case 'pushtest': return this.onPushTest(dev, r.msg.data);
      case 'keyupdate': {
        const k = KeyUpdateData.safeParse(r.msg.data);
        if (!k.success || k.data.ep <= dev.kemEpoch) return;
        dev.kem = k.data.kem; dev.kemEpoch = k.data.ep; this.store.saveDevices(this.devices);
        this.store.audit('device_rekey', { device: dev.id.slice(0, 8), epoch: k.data.ep });
        return;
      }
      case 'action': {
        const a = ActionData.safeParse(r.msg.data);
        if (!a.success) { this.store.audit('action_rejected', { why: 'schema' }); return; }
        return this.onAction(dev, a.data);
      }
      default: this.store.audit('frame_rejected', { code: 'unknown_kind' });
    }
  }

  // ------------------------------------------------------------------ actions
  private async onAction(dev: DeviceRecord, a: ActionData): Promise<void> {
    const cfg = this.store.config();
    const t = this.now();
    const result = async (outcome: 'applied' | 'denied' | 'expired' | 'stale' | 'rejected' | 'needs_local' | 'paused' | 'rate_limited' | 'failed', note?: string): Promise<void> => {
      this.store.audit('action', { device: dev.id.slice(0, 8), a: a.a, outcome, rid: a.rid });
      await this.sendTo(dev, 'result', { rid: a.rid, outcome, ...(note ? { note } : {}) }, ACTION_RESULT_TTL_MS).catch(() => undefined);
    };
    if (cfg.paused) return result('paused');
    this.limiter ??= new ActionLimiter(cfg.maxActionsPerMinute, cfg.maxActionsPerHour);
    if (!this.limiter.allow(t)) return result('rate_limited');
    const s = this.sessions.bySid(a.sid);
    const p = s?.pending;
    if (!s || !p || p.pub.rid !== a.rid) return result('stale');
    if (p.pub.bind !== a.bind) return result('stale');
    if (t > p.pub.expires) return result('expired');

    let text: string | undefined; let presetId: string | undefined;
    if (a.a === 'reply') {
      if (p.pub.kind === 'permission' || !p.can.reply) return result('rejected', 'cannot reply here');
      const preset = cfg.presets.find((x) => x.id === a.opt);
      const optText = a.opt ? p.optionText?.[a.opt] : undefined;
      if (preset) { text = preset.text; presetId = preset.id; } else if (optText) text = optText;
      else return result('rejected', 'unknown choice');
    } else if (p.pub.kind !== 'permission' || !p.can.approve) return result('rejected', 'cannot approve here');

    if (needsLocalConfirmation(cfg, { kind: a.a, tool: p.tool, presetId })) {
      await result('needs_local');
      const ok = await withTimeout(this.opts.confirmer({ kind: a.a === 'reply' ? 'reply' : 'approve', agent: s.agent, label: s.label, tool: p.tool, preview: a.a === 'reply' ? (text ?? '') : p.pub.preview, device: dev.name }), CONFIRM_TIMEOUT_MS);
      if (!ok) { // no or timeout: deny (permission) or drop (reply)
        if (a.a !== 'reply' && this.deliverPermission(s, 'deny', dev.name)) this.afterAnswer(s);
        return result('denied', 'not confirmed on the computer');
      }
      if (this.sessions.bySid(a.sid)?.pending?.pub.rid !== a.rid) return result('stale');
    }

    const delivered = a.a === 'reply' ? this.deliverText(s, text!, dev.name, presetId) : this.deliverPermission(s, a.a === 'approve' ? 'allow' : 'deny', dev.name);
    if (!delivered) return result('failed', 'the agent can no longer be reached');
    this.afterAnswer(s);
    return result(a.a === 'deny' ? 'denied' : 'applied');
  }

  private afterAnswer(s: Sess): void {
    delete s.pending;
    this.sessions.setStatus(s, 'working');
    this.schedulePush();
  }

  private deliverPermission(s: Sess, behavior: 'allow' | 'deny', device: string): boolean {
    const p = s.pending;
    if (!p) return false;
    if (p.route.hook) { p.route.hook.resolve({ behavior, ...(behavior === 'deny' ? { message: `Denied from "${device}" via Botwarren Companion` } : {}) }); p.route = {}; return true; }
    if (p.route.channelRequestId && s.channel) return s.channel.send({ ev: 'permission', request_id: p.route.channelRequestId, behavior });
    return false;
  }

  private deliverText(s: Sess, text: string, device: string, presetId?: string): boolean {
    if (!s.channel) return false;
    const safeName = device.replace(/[^A-Za-z0-9 _.-]/g, '').slice(0, 40);
    return s.channel.send({ ev: 'message', content: text, meta: { via: 'botwarren_companion', device: safeName.replace(/ /g, '_'), ...(presetId ? { preset: presetId.replace(/[^A-Za-z0-9_]/g, '_') } : { choice: 'agent_option' }) } });
  }

  // ------------------------------------------------------------------ housekeeping and rotation
  async housekeeping(): Promise<void> {
    const t = this.now();
    const before = JSON.stringify([...this.sessions.sessions.values()].map((s) => [s.sid, s.status, !!s.pending]));
    this.sessions.prune();
    if (this.ring.prune(t) > 0) await this.saveRing();
    await this.maybeRotate();
    if (JSON.stringify([...this.sessions.sessions.values()].map((s) => [s.sid, s.status, !!s.pending])) !== before) this.schedulePush();
    for (const [rid, p] of this.pairings) if (p.expires <= t) { this.pairings.delete(rid); this.store.audit('pairing_expired'); }
  }

  /** rotate the host encryption key every 7 days, but only if every paired device was seen in the last 24 hours */
  async maybeRotate(): Promise<boolean> {
    const t = this.now();
    if (!this.ring.rotationDue(t, ID_FIELDS.rotateEveryMs)) return false;
    if (this.devices.some((d) => d.lastSeen === null || t - d.lastSeen > ID_FIELDS.seenWithinMs)) return false;
    const e = await this.ring.rotate(t);
    await this.saveRing();
    this.store.audit('host_key_rotated', { epoch: e.epoch });
    for (const d of this.devices) await this.sendTo(d, 'keyupdate', { ep: e.epoch, kem: b64u(e.pair.pub) }, 24 * 3_600_000).catch(() => undefined);
    return true;
  }
}

async function withTimeout(p: Promise<boolean>, ms: number): Promise<boolean> {
  let t: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([p, new Promise<boolean>((ok) => { t = setTimeout(() => ok(false), ms); t.unref?.(); })]); } catch { return false; } finally { if (t) clearTimeout(t); }
}

export type { Signed };

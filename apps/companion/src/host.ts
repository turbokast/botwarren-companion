/**
 * The companion host: owns the host's keys, the paired devices, the relay connection, the session table, and decides every action.
 * The relay and the website only ever carry ciphertext. See docs/PROTOCOL.md.
 * Licence: Apache-2.0.
 */
import { z } from 'zod';
import {
  ActionData, KemKeyring, ReplayGuard, SendCounter, StateData as StateSchema, b64u, derivePairKeys, exportIdentityPkcs8, formatCode, generateIdentity, importIdentityPkcs8, idOf, newPairingSecret,
  openMessage, openRequest, peekHeader, sealMessage, sealOffer, sealResult, shortAuthString, signDeviceCert, signRevocation, unb64u, importKemPrivatePkcs8, exportKemPrivatePkcs8,
  KeyUpdateData, PAIR_TTL_MS, Ticket, type Frame, type Identity, type KemEntry, type Signed, type PairKeys, type StateData,
} from './protocol/index.ts';
import { RelayConnection, type ConnectionOptions, type ConnState } from './link/connection.ts';
import { ActionLimiter, needsLocalConfirmation, relayAllowed } from './policy.ts';
import { SessionTable, type Sess } from './sessions.ts';
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
}

export const MAX_DEVICES = 8;
const STATE_TTL_MS = 5 * 60_000;
const ACTION_RESULT_TTL_MS = 5 * 60_000;
const CONFIRM_TIMEOUT_MS = 60_000;
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
  private house: ReturnType<typeof setInterval> | null = null;
  private rev = 0;

  constructor(o: HostOptions) {
    this.opts = o; this.store = o.store; this.now = o.now ?? Date.now;
    this.sessions = new SessionTable(this.now, () => secretEnvValues(o.env ?? process.env));
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
      onState: (s) => { this.connState = s; this.opts.onState?.(s); if (s === 'killed') this.store.audit('relay_killed'); },
      onControl: (m) => { void this.onControl(m); },
      onReady: (send) => {
        for (const r of this.store.state().revocations) send({ t: 'revoke', rev: r });
        for (const [rid, p] of this.pairings) if (!p.done && p.expires > this.now()) void this.postOffer(rid, p);
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
  private async sendTo(d: DeviceRecord, kind: string, data: unknown, ttlMs: number): Promise<boolean> {
    if (!this.conn?.online) return false;
    let c = this.counters.get(d.id);
    if (!c) { c = this.counterFor(d.id, this.store.state().sendReserved[d.id] ?? 0); this.counters.set(d.id, c); }
    const frame = await sealMessage({ from: this.identity, to: { id: d.id, kemPub: unb64u(d.kem), epoch: d.kemEpoch }, seq: c.next(), now: this.now(), ttlMs, kind, data });
    return this.conn.sendFrame(frame);
  }

  buildState(): StateData {
    const cfg = this.store.config();
    const presets = cfg.presets.map((p) => ({ id: p.id, label: p.label }));
    let st = this.sessions.toState(this.rev, { name: cfg.name, paused: cfg.paused, confirm: cfg.confirm, devices: this.devices.map((d) => ({ id8: d.id.slice(0, 8), name: d.name, lastSeen: d.lastSeen })) }, presets);
    // stay inside one padded bucket: drop the oldest context first, then whole sessions
    const size = (s: StateData): number => new TextEncoder().encode(JSON.stringify(s)).length;
    if (size(st) > 7500) st = { ...st, sessions: st.sessions.map((s) => ({ ...s, recent: s.recent.slice(-1) })) };
    while (size(st) > 7500 && st.sessions.length > 1) st = { ...st, sessions: st.sessions.slice(0, -1) };
    return StateSchema.parse(st);
  }

  /** coalesced: many hook events become one state message */
  schedulePush(delayMs = 150): void {
    if (this.pushTimer) return;
    this.pushTimer = setTimeout(() => { this.pushTimer = null; void this.pushState(); }, delayMs);
    this.pushTimer.unref?.();
  }

  async pushState(only?: DeviceRecord): Promise<void> {
    if (!this.conn?.online) return;
    this.rev += 1;
    const st = this.store.state(); st.rev = this.rev; this.store.saveState(st);
    const data = this.buildState();
    for (const d of only ? [only] : this.devices) await this.sendTo(d, 'state', data, STATE_TTL_MS).catch(() => undefined);
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
      case 'sync': return this.pushState(dev);
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

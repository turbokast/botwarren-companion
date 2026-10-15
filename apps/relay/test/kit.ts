import { Relay, type RelayConfig } from '../src/relay.ts';
import {
  KemKeyring, ReplayGuard, b64u, generateIdentity, signDeviceCert, signTicket, peekHeader, type Frame, type Identity, type Signed,
} from '@botwarren/companion/protocol';
import { RelayConnection, type ConnState } from '../../companion/src/link/connection.ts';

export const ACCT = 'acct-aaaaaaaaaaaaaaaa';

export interface Party { id: Identity; ring: KemKeyring; ticket: Signed; cert?: Signed }

export async function makeWorld(over: Partial<RelayConfig> & { ticketTtlMs?: number } = {}) {
  const server = await generateIdentity(true);
  const logs: string[] = [];
  const relay = new Relay({ port: 0, host: '127.0.0.1', ticketKeys: [server.pub], adminToken: 'admintoken-for-tests', logSink: (l) => logs.push(l), ...over });
  const port = await relay.listen();
  relay.origin = `http://127.0.0.1:${port}`;
  const url = `ws://127.0.0.1:${port}/v1/ws`;
  const now = over.now ?? Date.now;

  const hostId = await generateIdentity(true);
  const hostRing = new KemKeyring(true); await hostRing.init(now());
  const ticket = await signTicket(server, { v: 1, acct: ACCT, host: hostId.id, hostSig: b64u(hostId.pub), iat: now(), exp: now() + (over.ticketTtlMs ?? 86_400_000) });
  const host: Party = { id: hostId, ring: hostRing, ticket };

  async function addDevice(name = 'phone', acct = ACCT): Promise<Party> {
    const id = await generateIdentity(false);
    const ring = new KemKeyring(false); const k = await ring.init(now());
    const cert = await signDeviceCert(hostId, { v: 1, acct, host: hostId.id, dev: id.id, sig: b64u(id.pub), kem: b64u(k.pair.pub), name, iat: now(), ctr: 1 });
    return { id, ring, ticket, cert };
  }

  const conns: RelayConnection[] = [];
  function connect(p: Party, role: 'host' | 'device', onFrame: (f: Frame) => void = () => {}, extra: Partial<ConstructorParameters<typeof RelayConnection>[0]> = {}) {
    const states: ConnState[] = [];
    const frames: Frame[] = [];
    const controls: Record<string, unknown>[] = [];
    const presence: boolean[] = [];
    const c = new RelayConnection({
      url, role, identity: p.id, ticket: p.ticket, ...(p.cert ? { cert: p.cert } : {}), reconnect: false,
      onFrame: (f) => { frames.push(f); onFrame(f); }, onState: (s) => states.push(s), onControl: (m) => controls.push(m), onPresence: (h) => presence.push(h), ...extra,
    });
    conns.push(c);
    c.start();
    return { conn: c, states, frames, controls, presence };
  }

  async function until(cond: () => boolean, ms = 4000): Promise<void> {
    const t0 = Date.now();
    while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timeout waiting for condition'); await new Promise((r) => setTimeout(r, 15)); }
  }

  async function close() { for (const c of conns) c.stop(); await relay.close(); }
  return { server, relay, port, url, logs, host, addDevice, connect, until, close, guard: () => new ReplayGuard(), peek: peekHeader, now };
}

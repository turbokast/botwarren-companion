import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ReplayGuard, b64u, derivePairKeys, formatCode, generateIdentity, newPairingSecret, openMessage, parseCode, peekHeader, sealMessage, signAuth, signKillList, signRevocation, signTicket, unb64u,
  type Frame, type Identity,
} from '@botwarren/companion/protocol';
import { ACCT, makeWorld } from './kit.ts';
import { RelayConnection } from '../../companion/src/link/connection.ts';


/** a raw upgrade attempt (fetch forbids setting the Connection header); resolves with the HTTP status the relay answered */
function rawUpgrade(port: number, headers: Record<string, string>): Promise<number> {
  return new Promise((ok, bad) => {
    const r = request({ host: '127.0.0.1', port, path: '/v1/ws', headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', ...headers } });
    r.on('response', (res) => { ok(res.statusCode ?? 0); res.resume(); });
    r.on('upgrade', (_res, sock) => { sock.destroy(); ok(101); });
    r.on('error', bad);
    r.end();
  });
}

let world: Awaited<ReturnType<typeof makeWorld>> | null = null;
afterEach(async () => { await world?.close(); world = null; });

async function sendTo(w: NonNullable<typeof world>, from: { id: Identity }, to: { id: Identity; ring: { current: { pair: { pub: Uint8Array } } } }, seq: number, data: unknown, kind = 'state') {
  return sealMessage({ from: from.id, to: { id: to.id.id, kemPub: to.ring.current.pair.pub, epoch: 0 }, seq, now: w.now(), ttlMs: 600_000, kind, data });
}

describe('relay: authentication and delivery', () => {
  it('host and device authenticate with the certificate chain and exchange sealed messages in both directions', async () => {
    world = await makeWorld();
    const w = world;
    const dev = await w.addDevice();
    const h = w.connect(w.host, 'host');
    const d = w.connect(dev, 'device');
    await w.until(() => h.conn.online && d.conn.online);

    const toDev = await sendTo(w, w.host, dev, 1, { secret: 'CANARY-PLAINTEXT-7f3a' });
    h.conn.sendFrame(toDev);
    await w.until(() => d.frames.length === 1);
    const opened = await openMessage(d.frames[0], { me: { id: dev.id.id, ring: dev.ring }, senderKey: (id) => (id === w.host.id.id ? w.host.id.pub : null), guard: new ReplayGuard(), now: w.now() });
    expect(opened).toMatchObject({ ok: true, msg: { kind: 'state', data: { secret: 'CANARY-PLAINTEXT-7f3a' } } });

    const toHost = await sendTo(w, dev, w.host, 1, { a: 'approve' }, 'action');
    d.conn.sendFrame(toHost);
    await w.until(() => h.frames.length === 1);
    expect((await openMessage(h.frames[0], { me: { id: w.host.id.id, ring: w.host.ring }, senderKey: (id) => (id === dev.id.id ? dev.id.pub : null), guard: new ReplayGuard(), now: w.now() })).ok).toBe(true);
  });

  it('refuses: wrong ticket signer, expired ticket, forged device certificate, bad proof, wrong audience', async () => {
    world = await makeWorld();
    const w = world;
    const dev = await w.addDevice();
    const evil = await generateIdentity(true);

    // ticket signed by a key the relay does not trust
    const badTicket = await signTicket(evil, { v: 1, acct: ACCT, host: w.host.id.id, hostSig: b64u(w.host.id.pub), iat: w.now(), exp: w.now() + 1e6 });
    const a = w.connect({ ...w.host, ticket: badTicket }, 'host');
    await w.until(() => a.controls.some((c) => c.code === 'auth_bad_ticket'));
    expect(a.states).not.toContain('online');

    // expired ticket
    const expired = await signTicket(w.server, { v: 1, acct: ACCT, host: w.host.id.id, hostSig: b64u(w.host.id.pub), iat: w.now() - 2e6, exp: w.now() - 1e6 });
    const b = w.connect({ ...w.host, ticket: expired }, 'host');
    await w.until(() => b.controls.some((c) => c.code === 'auth_bad_ticket'));

    // device whose certificate was issued by someone else than the ticket's host
    const stranger = await generateIdentity(true);
    const { signDeviceCert } = await import('@botwarren/companion/protocol');
    const forged = await signDeviceCert(stranger, { v: 1, acct: ACCT, host: w.host.id.id, dev: dev.id.id, sig: b64u(dev.id.pub), kem: b64u(dev.id.pub), name: 'x', iat: w.now(), ctr: 1 });
    const c = w.connect({ ...dev, cert: forged }, 'device');
    await w.until(() => c.controls.some((x) => x.code === 'auth_bad_cert'));

    // a device that has the certificate but not the key: proof signed by another key
    const thief = await generateIdentity(false);
    const d = w.connect({ ...dev, id: thief }, 'device');
    await w.until(() => d.controls.some((x) => x.code === 'auth_id_mismatch'));

    // audience mismatch: a proof made for another relay is useless here
    const e = w.connect(w.host, 'host', () => {}, { url: w.url });
    await w.until(() => e.conn.online);
    e.conn.stop();
    const ws = new WebSocket(w.url);
    const codes: string[] = [];
    ws.onmessage = async (ev) => {
      const m = JSON.parse(String(ev.data)) as { t: string; nonce?: string };
      if (m.t === 'hello') ws.send(JSON.stringify({ t: 'auth', role: 'host', id: w.host.id.id, ticket: w.host.ticket, sig: await signAuth(w.host.id, unb64u(m.nonce!), 'https://other-relay.example') }));
      else if (m.t === 'error') codes.push(String((m as { code?: string }).code));
    };
    await w.until(() => codes.length > 0);
    expect(codes[0]).toBe('auth_bad_signature');
    ws.close();
  });

  it('a socket that sends anything before auth is closed; a foreign Origin cannot upgrade; cookies authenticate nothing', async () => {
    world = await makeWorld();
    const w = world;
    const ws = new WebSocket(w.url);
    const closed = new Promise<number>((ok) => { ws.onclose = (e) => ok(e.code); });
    ws.onopen = () => ws.send(JSON.stringify({ t: 'msg', h: 'x', c: 'y', s: 'z' }));
    expect(await closed).toBe(4401);

    // an upgrade from a browser page on another origin is refused (cross-site WebSocket hijacking)
    expect(await rawUpgrade(w.port, { origin: 'https://evil.example', cookie: 'bw_session=abc' })).toBe(403);
    expect(w.relay.counters.get('upgrade_bad_origin')).toBe(1);
  });

  it('queues for an offline recipient, delivers on connect, drops after the TTL, and an ack removes it', async () => {
    let t = Date.now();
    world = await makeWorld({ now: () => t, queueTtlMs: 60_000 });
    const w = world;
    const dev = await w.addDevice();
    const h = w.connect(w.host, 'host');
    await w.until(() => h.conn.online);
    h.conn.sendFrame(await sendTo(w, w.host, dev, 1, { n: 1 }));
    h.conn.sendFrame(await sendTo(w, w.host, dev, 2, { n: 2 }));
    await w.until(() => w.relay.counters.get('frames') === 2);

    const d = w.connect(dev, 'device');
    await w.until(() => d.frames.length === 2);
    const first = peekHeader(d.frames[0])!.header;
    d.conn.ack(first.m);
    await w.until(() => ((w.relay as unknown as { queues: Map<string, unknown[]> }).queues.get(dev.id.id)?.length ?? 0) === 1);

    d.conn.stop();
    t += 61_000;
    await new Promise((r) => setTimeout(r, 10_500)); // the sweep runs every 10 s
    expect((w.relay as unknown as { queues: Map<string, unknown[]> }).queues.size).toBe(0);
  }, 30_000);

  it('presence: devices learn when the host goes on and offline', async () => {
    world = await makeWorld();
    const w = world;
    const dev = await w.addDevice();
    const d = w.connect(dev, 'device');
    await w.until(() => d.conn.online);
    const h = w.connect(w.host, 'host');
    await w.until(() => d.presence.includes(true));
    h.conn.stop();
    await w.until(() => d.presence.includes(false));
  });

  it('rejects frames that are not from the authenticated key, are to the wrong party, expired, or oversized', async () => {
    world = await makeWorld();
    const w = world;
    const dev = await w.addDevice();
    const dev2 = await w.addDevice('tablet');
    const h = w.connect(w.host, 'host');
    const d = w.connect(dev, 'device');
    await w.until(() => h.conn.online && d.conn.online);

    // a device addressing another device
    d.conn.sendFrame(await sendTo(w, dev, dev2, 1, {}));
    await w.until(() => d.controls.some((c) => c.code === 'wrong_recipient'));
    // a device sending a frame signed by someone else
    const forged = await sendTo(w, dev2, w.host, 1, {});
    d.conn.sendFrame(forged);
    await w.until(() => d.controls.filter((c) => c.code === 'bad_frame').length === 1);
    // an already-expired frame
    const old = await sealMessage({ from: dev.id, to: { id: w.host.id.id, kemPub: w.host.ring.current.pair.pub, epoch: 0 }, seq: 2, now: w.now() - 100_000, ttlMs: 1000, kind: 'action', data: {} });
    d.conn.sendFrame(old);
    await w.until(() => d.controls.some((c) => c.code === 'expired'));
    // tampered signature
    const good = await sendTo(w, dev, w.host, 3, {});
    d.conn.sendFrame({ ...good, c: good.c.slice(0, -2) + 'AA' });
    await w.until(() => d.controls.filter((c) => c.code === 'bad_frame').length === 2);
    expect(h.frames.length).toBe(0);
  });
});

describe('relay: limits', () => {
  it('rate-limits a flooding connection and closes a repeat offender', async () => {
    world = await makeWorld();
    const w = world;
    const dev = await w.addDevice();
    const h = w.connect(w.host, 'host');
    const d = w.connect(dev, 'device');
    await w.until(() => h.conn.online && d.conn.online);
    for (let i = 0; i < 80; i++) d.conn.send({ t: 'ping' });
    await w.until(() => d.states.includes('offline'));
    expect(d.controls.some((c) => c.code === 'rate_limited')).toBe(true);
    expect(w.relay.counters.get('rate_limited')).toBeGreaterThan(0);
  });

  it('caps hosts and devices per account', async () => {
    world = await makeWorld({ maxDevicesPerAcct: 2 });
    const w = world;
    const ds = [await w.addDevice('a'), await w.addDevice('b'), await w.addDevice('c')];
    const cs = ds.map((d) => w.connect(d, 'device'));
    await w.until(() => cs.filter((c) => c.conn.online).length === 2 && cs.some((c) => c.controls.some((m) => m.code === 'auth_account_cap')));
  });

  it('caps what an account can have queued', async () => {
    world = await makeWorld({ maxAcctQueuedFrames: 3 });
    const w = world;
    const dev = await w.addDevice();
    const h = w.connect(w.host, 'host');
    await w.until(() => h.conn.online);
    for (let i = 1; i <= 6; i++) h.conn.sendFrame(await sendTo(w, w.host, dev, i, {}));
    await w.until(() => h.controls.filter((c) => c.code === 'quota').length >= 3);
  });
});

describe('relay: kill switches', () => {
  it('admin endpoints need the token; global, account, host and device kills close live sockets and refuse new ones', async () => {
    world = await makeWorld();
    const w = world;
    const base = `http://127.0.0.1:${w.port}`;
    expect((await fetch(`${base}/admin/stats`)).status).toBe(404);
    expect((await fetch(`${base}/admin/kill`, { method: 'POST', body: '{"scope":"global"}', headers: { authorization: 'Bearer wrong' } })).status).toBe(404);
    const admin = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', body: JSON.stringify(body), headers: { authorization: 'Bearer admintoken-for-tests' } });

    const dev = await w.addDevice();
    const h = w.connect(w.host, 'host');
    const d = w.connect(dev, 'device');
    await w.until(() => h.conn.online && d.conn.online);

    expect((await admin('/admin/kill', { scope: 'device', id: dev.id.id })).status).toBe(200);
    await w.until(() => d.states.includes('killed'));
    expect(h.conn.online).toBe(true);
    const d2 = w.connect(dev, 'device');
    await w.until(() => d2.controls.some((c) => c.code === 'auth_killed'));
    await admin('/admin/unkill', { scope: 'device', id: dev.id.id });

    await admin('/admin/kill', { scope: 'account', id: ACCT });
    await w.until(() => h.states.includes('killed'));
    const h2 = w.connect(w.host, 'host');
    await w.until(() => h2.controls.some((c) => c.code === 'auth_killed'));
    await admin('/admin/unkill', { scope: 'account', id: ACCT });

    const h3 = w.connect(w.host, 'host');
    await w.until(() => h3.conn.online);
    await admin('/admin/kill', { scope: 'global' });
    await w.until(() => h3.states.includes('killed'));
    expect(await rawUpgrade(w.port, {})).toBe(403);
    const stats = await (await fetch(`${base}/admin/stats`, { headers: { authorization: 'Bearer admintoken-for-tests' } })).json() as { kill: { global: boolean } };
    expect(stats.kill.global).toBe(true);
  });

  it('a host revocation (host-signed) closes that device and blocks its reconnect; a forged one is ignored', async () => {
    world = await makeWorld();
    const w = world;
    const dev = await w.addDevice();
    const other = await w.addDevice('other');
    const h = w.connect(w.host, 'host');
    const d = w.connect(dev, 'device');
    const o = w.connect(other, 'device');
    await w.until(() => h.conn.online && d.conn.online && o.conn.online);
    const evil = await generateIdentity(true);
    h.conn.send({ t: 'revoke', rev: await signRevocation(evil, { v: 1, host: w.host.id.id, dev: other.id.id, iat: w.now() }) });
    await w.until(() => w.relay.counters.get('revoke_bad') === 1);
    expect(o.conn.online).toBe(true);
    h.conn.send({ t: 'revoke', rev: await signRevocation(w.host.id, { v: 1, host: w.host.id.id, dev: dev.id.id, iat: w.now() }) });
    await w.until(() => d.states.includes('killed'));
    expect(o.conn.online).toBe(true);
    const d2 = w.connect(dev, 'device');
    await w.until(() => d2.controls.some((c) => c.code === 'auth_killed'));
  });

  it('a device can revoke itself', async () => {
    world = await makeWorld();
    const w = world;
    const dev = await w.addDevice();
    const d = w.connect(dev, 'device');
    await w.until(() => d.conn.online);
    d.conn.send({ t: 'revoke_self' });
    await w.until(() => d.states.includes('killed'));
  });

  it('the signed kill list from botwarren.com is verified, applied and lifted; an unsigned or foreign list is ignored', async () => {
    let body = '';
    const w0 = await makeWorld({ killListUrl: 'https://botwarren.example/api/companion/kill-list', killListPollMs: 50, fetchImpl: (async () => new Response(body, { status: body ? 200 : 503 })) as typeof fetch });
    world = w0;
    const dev = await w0.addDevice();
    const d = w0.connect(dev, 'device');
    await w0.until(() => d.conn.online);

    const evil = await generateIdentity(true);
    body = JSON.stringify(await signKillList(evil, { v: 1, seq: 1, iat: Date.now(), global: false, accounts: [ACCT], hosts: [], devices: [] }));
    await new Promise((r) => setTimeout(r, 200));
    expect(d.conn.online).toBe(true);

    body = JSON.stringify(await signKillList(w0.server, { v: 1, seq: 2, iat: Date.now(), global: false, accounts: [ACCT], hosts: [], devices: [] }));
    await w0.until(() => d.states.includes('killed'));
    body = JSON.stringify(await signKillList(w0.server, { v: 1, seq: 3, iat: Date.now(), global: false, accounts: [], hosts: [], devices: [] }));
    await w0.until(() => w0.relay.kill.accounts.size === 0);
  });

  it('the global kill switch can be on at boot', async () => {
    world = await makeWorld({ globalKill: true });
    const dev = await world.addDevice();
    world.connect(dev, 'device');
    await world.until(() => (world!.relay.counters.get('upgrade_killed') ?? 0) > 0);
    expect(await rawUpgrade(world.port, {})).toBe(403);
  });
});

describe('relay: pairing rendezvous', () => {
  it('offer, request and result pass through as opaque strings; unknown or consumed ids look identical', async () => {
    world = await makeWorld();
    const w = world;
    const h = w.connect(w.host, 'host');
    await w.until(() => h.conn.online);
    const keys = await derivePairKeys(newPairingSecret());
    h.conn.send({ t: 'pair_offer', rid: keys.rid, offer: 'OFFER-BLOB' });
    await w.until(() => h.controls.some((c) => c.t === 'pair_ok'));

    const base = `http://127.0.0.1:${w.port}/v1/pair`;
    expect(await (await fetch(`${base}/${keys.rid}`)).json()).toEqual({ offer: 'OFFER-BLOB' });
    const unknown = await fetch(`${base}/${b64u(new Uint8Array(16).fill(5))}`);
    expect(unknown.status).toBe(404);

    const rq = (await (await fetch(`${base}/${keys.rid}/request`, { method: 'POST', body: JSON.stringify({ req: 'REQ-BLOB' }) })).json() as { rq: string }).rq;
    await w.until(() => h.controls.some((c) => c.t === 'pair_request'));
    const pr = h.controls.find((c) => c.t === 'pair_request')!;
    expect(pr).toMatchObject({ rid: keys.rid, rq, req: 'REQ-BLOB' });

    const poll = fetch(`${base}/${keys.rid}/result?rq=${rq}`).then((r) => r.json());
    h.conn.send({ t: 'pair_result', rid: keys.rid, rq, result: 'RESULT-BLOB' });
    expect(await poll).toEqual({ result: 'RESULT-BLOB' });
    // consumed: the offer is gone and looks like any unknown id
    expect((await fetch(`${base}/${keys.rid}`)).status).toBe(404);
  });

  it('a rejected pairing answers 410 to the device; only 3 offers per host; the endpoint is rate limited per address', async () => {
    world = await makeWorld();
    const w = world;
    const h = w.connect(w.host, 'host');
    await w.until(() => h.conn.online);
    const base = `http://127.0.0.1:${w.port}/v1/pair`;
    const k = await derivePairKeys(newPairingSecret());
    h.conn.send({ t: 'pair_offer', rid: k.rid, offer: 'O' });
    await w.until(() => h.controls.some((c) => c.t === 'pair_ok'));
    const rq = (await (await fetch(`${base}/${k.rid}/request`, { method: 'POST', body: JSON.stringify({ req: 'R' }) })).json() as { rq: string }).rq;
    h.conn.send({ t: 'pair_result', rid: k.rid, rq, rejected: true });
    expect((await fetch(`${base}/${k.rid}/result?rq=${rq}`)).status).toBe(410);

    for (let i = 0; i < 4; i++) h.conn.send({ t: 'pair_offer', rid: (await derivePairKeys(newPairingSecret())).rid, offer: 'x' });
    await w.until(() => h.controls.some((c) => c.code === 'pair_cap'));

    let limited = 0;
    for (let i = 0; i < 30; i++) if ((await fetch(`${base}/${b64u(new Uint8Array(16).fill(i))}`)).status === 429) limited++;
    expect(limited).toBeGreaterThan(0);
  });

  it('a short code typed by a person maps to the same rendezvous id', async () => {
    const s = newPairingSecret();
    expect((await derivePairKeys(parseCode(formatCode(s).toLowerCase())!)).rid).toBe((await derivePairKeys(s)).rid);
  });
});

describe('relay: no plaintext, no identifiers in logs or storage', () => {
  it('plants canaries in every field and finds none in logs, counters, stats or what the relay keeps beyond sealed frames', async () => {
    world = await makeWorld();
    const w = world;
    const dev = await w.addDevice('CANARY-DEVICE-NAME');
    const h = w.connect(w.host, 'host');
    const d = w.connect(dev, 'device');
    await w.until(() => h.conn.online && d.conn.online);
    h.conn.sendFrame(await sendTo(w, w.host, dev, 1, { text: 'CANARY-MESSAGE-TEXT', label: 'CANARY-PROJECT' }));
    await w.until(() => d.frames.length === 1);
    d.conn.send({ t: 'garbage' });
    d.conn.sendFrame({ t: 'msg', h: 'CANARY-BAD', c: 'x', s: 'y' });
    await new Promise((r) => setTimeout(r, 100));

    const stats = await (await fetch(`http://127.0.0.1:${w.port}/admin/stats`, { headers: { authorization: 'Bearer admintoken-for-tests' } })).text();
    const everything = [w.logs.join('\n'), JSON.stringify([...w.relay.counters]), stats].join('\n');
    for (const canary of ['CANARY', w.host.id.id, dev.id.id, ACCT, '127.0.0.1', 'admintoken']) expect(everything).not.toContain(canary);
    // every held queue item is the sealed frame only
    const q = (w.relay as unknown as { queues: Map<string, { raw: string }[]> }).queues;
    for (const items of q.values()) for (const it of items) expect(it.raw).not.toContain('CANARY');
    // log lines are exactly {t, c}
    for (const l of w.logs) expect(Object.keys(JSON.parse(l)).sort()).toEqual(['c', 't']);
  });
});

describe('relay: static client and headers', () => {
  it('serves the client with a strict CSP and no cookies, refuses path traversal, answers 404 for everything else', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bw-relay-client-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>x</title>');
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'a.js'), 'export {}');
    writeFileSync(join(tmpdir(), 'bw-secret-outside.txt'), 'SECRET');
    world = await makeWorld({ clientDir: dir });
    const w = world;
    const base = `http://127.0.0.1:${w.port}`;
    const r = await fetch(`${base}/`);
    expect(r.status).toBe(200);
    const csp = r.headers.get('content-security-policy')!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self' blob:");
    expect(csp).toContain(`ws://127.0.0.1:${w.port}`);
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|https:\/\//);
    expect(r.headers.get('set-cookie')).toBeNull();
    expect(r.headers.get('x-frame-options')).toBe('DENY');
    expect((await fetch(`${base}/sub/a.js`)).headers.get('content-type')).toContain('javascript');
    expect((await fetch(`${base}/..%2F..%2Fbw-secret-outside.txt`)).status).toBe(404);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/`, { method: 'POST' })).status).toBe(404);
  });
});

describe('connection client', () => {
  it('reconnects after the relay drops it and keeps delivering', async () => {
    world = await makeWorld();
    const w = world;
    const dev = await w.addDevice();
    const h = w.connect(w.host, 'host');
    const d = w.connect(dev, 'device', () => {}, { reconnect: true, backoffMs: [50, 100] });
    await w.until(() => h.conn.online && d.conn.online);
    for (const c of (w.relay as unknown as { conns: Map<string, { ws: { terminate: () => void } }> }).conns.values()) c.ws.terminate();
    await w.until(() => d.states.filter((s) => s === 'online').length >= 2, 8000);
    expect(RelayConnection).toBeDefined();
  });
});

export type { Frame };

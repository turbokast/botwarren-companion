import { describe, expect, it } from 'vitest';
import {
  KemKeyring, b64u, bindOf, derivePairKeys, formatCode, generateIdentity, hex, newPairingSecret, openOffer, openRequest, openResult, parseCode, sealOffer, sealRequest, sealResult,
  shortAuthString, signAuth, signDeviceCert, signKillList, signRevocation, signTicket, unhex, verifyAuth, verifyDeviceCert, verifyKillList, verifyRevocation, verifyTicket, idOf, unb64u,
  ActionData, type DeviceCert,
} from '../src/protocol/index.ts';

const NOW = 1_800_000_000_000;

describe('pairing codes and derivations', () => {
  it('known answers (independently recomputed with Python hashlib/hmac)', async () => {
    const s = unhex('00112233445566778899');
    expect(formatCode(s)).toBe('008J-4CT4-ANK7-F24S');
    const k = await derivePairKeys(s);
    expect(k.rid).toBe('fFw3KTTDNaMY2T_PgwATTw');
    expect(hex(k.key)).toBe('95c52a820af342c6f2d059442e6870fc9962c79cc4744972f885196b0f476385');
    const f = (n: number) => new Uint8Array(32).fill(n);
    expect(await shortAuthString(f(1), f(2), f(3), f(4))).toBe('900 523');
  });

  it('codes are 80 bits, forgiving to type, and round-trip', () => {
    const s = newPairingSecret();
    const code = formatCode(s);
    expect(code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/);
    expect(parseCode(code)).toEqual(s);
    expect(parseCode(code.toLowerCase().replace(/-/g, ' '))).toEqual(s);
    expect(parseCode('ABCD')).toBeNull();
    expect(parseCode('!!!!')).toBeNull();
  });
});

describe('pairing exchange', () => {
  async function setup() {
    const server = await generateIdentity(true);
    const host = await generateIdentity(true);
    const hostRing = new KemKeyring(true); await hostRing.init(NOW);
    const ticket = await signTicket(server, { v: 1, acct: 'acct-aaaaaaaaaaaaaaaa', host: host.id, hostSig: b64u(host.pub), iat: NOW, exp: NOW + 365 * 86_400_000 });
    return { server, host, hostRing, ticket };
  }

  it('full happy path: offer, request, SAS match, certificate, result', async () => {
    const { server, host, hostRing, ticket } = await setup();
    const secret = newPairingSecret();
    const hostKeys = await derivePairKeys(secret);
    const devKeys = await derivePairKeys(parseCode(formatCode(secret))!);
    expect(devKeys.rid).toBe(hostKeys.rid);

    const offerBlob = await sealOffer(hostKeys, { v: 1, hostSig: b64u(host.pub), hostKem: b64u(hostRing.current.pair.pub), hostEp: 0, hostName: 'Mia laptop', ticket, t: NOW });
    const offer = await openOffer(devKeys, offerBlob);
    expect(offer?.hostName).toBe('Mia laptop');

    const dev = await generateIdentity(false);
    const devRing = new KemKeyring(false); const dk = await devRing.init(NOW);
    const reqBlob = await sealRequest(devKeys, { v: 1, devSig: b64u(dev.pub), devKem: b64u(dk.pair.pub), devName: "Mia's phone" });
    const req = await openRequest(hostKeys, reqBlob);
    expect(req?.devName).toBe("Mia's phone");

    const sasHost = await shortAuthString(host.pub, hostRing.current.pair.pub, unb64u(req!.devSig), unb64u(req!.devKem));
    const sasDev = await shortAuthString(unb64u(offer!.hostSig), unb64u(offer!.hostKem), dev.pub, dk.pair.pub);
    expect(sasHost).toBe(sasDev);
    expect(sasHost).toMatch(/^\d{3} \d{3}$/);

    const cert = await signDeviceCert(host, { v: 1, acct: 'acct-aaaaaaaaaaaaaaaa', host: host.id, dev: dev.id, sig: b64u(dev.pub), kem: b64u(dk.pair.pub), name: "Mia's phone", iat: NOW, ctr: 1 });
    const resBlob = await sealResult(hostKeys, { v: 1, cert, hostEp: 0 });
    const res = await openResult(devKeys, resBlob);
    expect(res).not.toBeNull();
    const parsed = await verifyDeviceCert(res!.cert, unb64u(offer!.hostSig));
    expect(parsed?.dev).toBe(dev.id);
    expect(await verifyTicket(offer!.ticket, [server.pub], NOW + 1000)).toMatchObject({ host: host.id });
  });

  it('a relay or attacker without the code cannot read, forge or swap any step', async () => {
    const { host, hostRing, ticket } = await setup();
    const real = await derivePairKeys(newPairingSecret());
    const guess = await derivePairKeys(newPairingSecret());
    const blob = await sealOffer(real, { v: 1, hostSig: b64u(host.pub), hostKem: b64u(hostRing.current.pair.pub), hostEp: 0, hostName: 'x', ticket, t: NOW });
    expect(await openOffer(guess, blob)).toBeNull();
    // an offer sealed for one rid cannot be presented under another (the rid is bound as AAD)
    const swapped = { ...guess, key: real.key };
    expect(await openOffer(swapped, blob)).toBeNull();
    // a request cannot be opened as an offer (label is bound)
    const reqBlob = await sealRequest(real, { v: 1, devSig: b64u(host.pub), devKem: b64u(host.pub), devName: 'x' });
    expect(await openOffer(real, reqBlob)).toBeNull();
    // bit flip
    const raw = unb64u(blob); raw[raw.length - 1] = raw[raw.length - 1]! ^ 1;
    expect(await openOffer(real, b64u(raw))).toBeNull();
  });

  it('a different key pair gives a different SAS (a substituted device is visible to the human)', async () => {
    const a = new Uint8Array(32).fill(7);
    const s1 = await shortAuthString(a, a, a, new Uint8Array(32).fill(1));
    const s2 = await shortAuthString(a, a, a, new Uint8Array(32).fill(2));
    expect(s1).not.toBe(s2);
  });
});

describe('signed documents', () => {
  it('ticket: valid, expired, wrong signer, wrong host binding', async () => {
    const server = await generateIdentity(true); const evil = await generateIdentity(true); const host = await generateIdentity(true); const other = await generateIdentity(true);
    const t = { v: 1 as const, acct: 'acct-aaaaaaaaaaaaaaaa', host: host.id, hostSig: b64u(host.pub), iat: NOW, exp: NOW + 1000 };
    const good = await signTicket(server, t);
    expect(await verifyTicket(good, [server.pub], NOW + 10)).not.toBeNull();
    expect(await verifyTicket(good, [server.pub], NOW + 2000)).toBeNull();
    expect(await verifyTicket(good, [evil.pub], NOW + 10)).toBeNull();
    expect(await verifyTicket(await signTicket(evil, t), [server.pub], NOW + 10)).toBeNull();
    // a ticket that names a host id that does not match the key is refused even if the server signed it
    expect(await verifyTicket(await signTicket(server, { ...t, host: other.id }), [server.pub], NOW + 10)).toBeNull();
    // a ticket signature is not a cert/revocation/kill-list signature (domain separation)
    expect(await verifyKillList(good, [server.pub])).toBeNull();
  });

  it('device cert: only the host can issue; fields are bound; revocation and kill list verify', async () => {
    const host = await generateIdentity(true); const dev = await generateIdentity(false); const evil = await generateIdentity(true); const server = await generateIdentity(true);
    const cert: DeviceCert = { v: 1, acct: 'acct-aaaaaaaaaaaaaaaa', host: host.id, dev: dev.id, sig: b64u(dev.pub), kem: b64u(dev.pub), name: 'phone', iat: NOW, ctr: 0 };
    const signed = await signDeviceCert(host, cert);
    expect(await verifyDeviceCert(signed, host.pub)).toMatchObject({ dev: dev.id });
    expect(await verifyDeviceCert(await signDeviceCert(evil, cert), host.pub)).toBeNull();
    expect(await verifyDeviceCert(await signDeviceCert(host, { ...cert, dev: evil.id }), host.pub)).toBeNull(); // dev id must match its key
    const rev = await signRevocation(host, { v: 1, host: host.id, dev: dev.id, iat: NOW });
    expect(await verifyRevocation(rev, host.pub)).toMatchObject({ dev: dev.id });
    expect(await verifyRevocation(rev, evil.pub)).toBeNull();
    const kl = await signKillList(server, { v: 1, seq: 3, iat: NOW, global: false, accounts: ['acct-aaaaaaaaaaaaaaaa'], hosts: [], devices: [] });
    expect(await verifyKillList(kl, [server.pub])).toMatchObject({ seq: 3 });
    expect(await verifyKillList(kl, [evil.pub])).toBeNull();
  });

  it('auth proof is bound to the nonce, the relay audience and the id', async () => {
    const dev = await generateIdentity(false);
    const nonce = new Uint8Array(32).fill(9);
    const sig = await signAuth(dev, nonce, 'https://relay.example');
    expect(await verifyAuth(dev.pub, sig, nonce, 'https://relay.example', dev.id)).toBe(true);
    expect(await verifyAuth(dev.pub, sig, new Uint8Array(32).fill(8), 'https://relay.example', dev.id)).toBe(false);
    expect(await verifyAuth(dev.pub, sig, nonce, 'https://evil.example', dev.id)).toBe(false);
    expect(await verifyAuth(dev.pub, sig, nonce, 'https://relay.example', await idOf(new Uint8Array(32)))).toBe(false);
  });
});

describe('inner message schemas', () => {
  it('action is strict: no free text field exists', async () => {
    const bind = await bindOf({ rid: 'abcd-1', kind: 'permission', tool: 'Bash', summary: 's', preview: 'p' });
    const ok = { rid: 'abcd-1', sid: 'abcdef12', a: 'approve', bind, nonce: 'abcdefgh' };
    expect(ActionData.safeParse(ok).success).toBe(true);
    expect(ActionData.safeParse({ ...ok, text: 'rm -rf /' }).success).toBe(false);
    expect(ActionData.safeParse({ ...ok, a: 'type' }).success).toBe(false);
    expect(ActionData.safeParse({ ...ok, opt: 'has spaces and text' }).success).toBe(false);
  });

  it('bind changes with anything the user was shown', async () => {
    const base = { rid: 'abcd-1', kind: 'permission', tool: 'Bash', summary: 's', preview: 'npm publish' };
    const b0 = await bindOf(base);
    expect(await bindOf({ ...base, preview: 'npm publish --tag evil' })).not.toBe(b0);
    expect(await bindOf({ ...base, tool: 'Write' })).not.toBe(b0);
    expect(await bindOf({ ...base, rid: 'abcd-2' })).not.toBe(b0);
    expect(await bindOf(base)).toBe(b0);
  });
});

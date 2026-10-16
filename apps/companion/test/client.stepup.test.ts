import { afterEach, describe, expect, it } from 'vitest';
import { controlWorld, type ControlWorld } from './support/control-world.ts';
import type { VirtualAuthenticator } from './support/virtual-authenticator.ts';
import type { SimDevice } from './simdevice.ts';
import { assertionOptions, registerCredential, registrationOptions, stepUpForCommand, unlock, type CredentialsLike, type StepUpTransport } from '../client/src/stepup.ts';
import { b64u, newCid, unb64u } from '../src/protocol/index.ts';

/**
 * The client helper (client/src/stepup.ts) against the real host: the helper turns the host's messages into WebAuthn calls and the browser's answers back
 * into messages. A virtual authenticator stands in for `navigator.credentials`. (A real-browser run with Playwright's virtual authenticator belongs to the UI work, WP6.)
 */
let cw: ControlWorld | null = null;
afterEach(async () => { await cw?.close(); cw = null; });

const ab = (b64: string): ArrayBuffer => { const u = unb64u(b64); return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer; };
function transport(d: SimDevice): StepUpTransport {
  const lists = (): Record<string, unknown[]> => ({ su_challenge: d.suChallenges, su_result: d.suResults, su_regchallenge: d.suRegChallenges, su_regresult: d.suRegResults });
  return {
    send: (kind, data) => d.send(kind, data),
    next: (kind, ms) => { const n = lists()[kind]!.length; return d.waitFor(() => lists()[kind]![n], ms); },
  };
}
function credentials(auth: VirtualAuthenticator, calls: { create: unknown[]; get: unknown[] }, mode: { cancel?: boolean; nothing?: boolean } = {}): CredentialsLike {
  return {
    async create({ publicKey }) {
      calls.create.push(publicKey);
      if (mode.cancel) throw new Error('NotAllowedError');
      if (mode.nothing) return null;
      const m = auth.create(b64u(new Uint8Array(publicKey.challenge as ArrayBuffer)));
      return { rawId: ab(m.id), response: { attestationObject: ab(m.ao), clientDataJSON: ab(m.cd) } } as unknown as Credential;
    },
    async get({ publicKey }) {
      calls.get.push(publicKey);
      if (mode.cancel) throw new Error('NotAllowedError');
      if (mode.nothing) return null;
      const m = auth.get(b64u(new Uint8Array(publicKey.challenge as ArrayBuffer)));
      return { rawId: ab(m.id), response: { authenticatorData: ab(m.ad), clientDataJSON: ab(m.cd), signature: ab(m.sig) } } as unknown as Credential;
    },
  };
}

describe('client step-up helper', () => {
  it('registers a credential, unlocks, and steps up for a start, all against the real host', async () => {
    cw = await controlWorld(); const auth = cw.authenticator(); const calls = { create: [] as unknown[], get: [] as unknown[] };
    const t = transport(cw.phone); const creds = credentials(auth, calls);
    expect(await registerCredential(t, 'Sim phone', creds)).toEqual({ ok: true });
    expect(calls.create).toHaveLength(1);
    expect(calls.create[0]).toMatchObject({ rp: { id: cw.rp.rpId }, authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required' }, attestation: 'none' });
    const u = await unlock(t, creds);
    expect(u).toMatchObject({ for: 'unlock', ok: true }); expect(u.until).toBeGreaterThan(Date.now());
    expect(calls.get[0]).toMatchObject({ rpId: cw.rp.rpId, userVerification: 'required', allowCredentials: [{ type: 'public-key' }] });
    // a prompt inside the window needs nothing more; a start needs its own assertion over its own text
    const s = await cw.session('k-client');
    const p = await cw.phone.cmd('prompt', { sid: s.sid, bind: await s.bind(), text: 'hello from the client helper' });
    expect(await cw.phone.result(p)).toMatchObject({ outcome: 'applied' });
    const cid = newCid();
    const r = await stepUpForCommand(t, { kind: 'start', cid, target: 'dragons:default', text: 'start it' }, creds);
    expect(r).toMatchObject({ ok: true, for: 'cmd', cid });
    await cw.phone.cmd('start', { launchId: 'dragons', mode: 'default', text: 'start it' }, { cid });
    expect(await cw.phone.result(cid)).toMatchObject({ outcome: 'applied' });
    // the same helper with different text than is then sent is refused by the host
    const cid2 = newCid();
    await stepUpForCommand(t, { kind: 'start', cid: cid2, target: 'dragons:default', text: 'what I showed' }, creds);
    await cw.phone.cmd('start', { launchId: 'dragons', mode: 'default', text: 'something else' }, { cid: cid2 });
    expect(await cw.phone.result(cid2)).toMatchObject({ outcome: 'refused', why: 'stepup_invalid' });
  });

  it('reports a cancelled or empty WebAuthn prompt as a failure the page can show, and sends nothing to the host', async () => {
    cw = await controlWorld(); const auth = cw.authenticator(); const calls = { create: [] as unknown[], get: [] as unknown[] };
    const t = transport(cw.phone);
    expect(await registerCredential(t, 'Sim phone', credentials(auth, calls, { cancel: true }))).toMatchObject({ ok: false, why: 'declined' });
    expect(await registerCredential(t, 'Sim phone', credentials(auth, calls, { nothing: true }))).toMatchObject({ ok: false, why: 'declined' });
    expect(cw.w.daemon.host.listDevices()[0]!.cred).toBeUndefined();
    await registerCredential(t, 'Sim phone', credentials(auth, calls));
    expect(await unlock(t, credentials(auth, calls, { cancel: true }))).toMatchObject({ ok: false, why: 'user_verification' });
  });

  it('passes the host\'s refusal through (no credential registered, scope too low)', async () => {
    cw = await controlWorld(); const auth = cw.authenticator(); const calls = { create: [] as unknown[], get: [] as unknown[] };
    const t = transport(cw.phone); const creds = credentials(auth, calls);
    expect(await unlock(t, creds)).toMatchObject({ ok: false, why: 'no_credential' });
    expect(calls.get).toHaveLength(0);
    cw.w.daemon.host.setDeviceScope(cw.phone.id.id, 'answer');
    expect(await unlock(t, creds)).toMatchObject({ ok: false, why: 'scope' });
  });

  it('builds WebAuthn options from the host challenge exactly', () => {
    const ch = b64u(new Uint8Array(32).fill(5));
    const reg = registrationOptions({ ch, exp: 1, rp: 'relay.example.com', origin: 'https://relay.example.com', user: b64u(new Uint8Array(32).fill(1)), algs: [-7, -8, -257] }, 'My phone');
    expect(b64u(new Uint8Array(reg.challenge as ArrayBuffer))).toBe(ch);
    expect(reg.pubKeyCredParams.map((p) => p.alg)).toEqual([-7, -8, -257]);
    expect(reg.rp).toMatchObject({ id: 'relay.example.com' }); expect(reg.user.name).toBe('My phone');
    const get = assertionOptions({ ch, for: 'unlock', exp: 1, rp: 'relay.example.com', origin: 'https://relay.example.com', cred: b64u(new Uint8Array(32).fill(9)) });
    expect(get.rpId).toBe('relay.example.com'); expect(get.userVerification).toBe('required');
    expect(get.allowCredentials).toHaveLength(1);
  });
});

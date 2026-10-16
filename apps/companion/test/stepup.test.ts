import { describe, expect, it } from 'vitest';
import { decodeCbor, verifyAssertion, verifyRegistration, type Relying, type StoredCredential } from '../src/stepup.ts';
import { VirtualAuthenticator, type Alg } from './support/virtual-authenticator.ts';
import { b64u } from '../src/protocol/bytes.ts';
import { commandDigest, stepupChallenge } from '../src/protocol/index.ts';

const rp: Relying = { rpId: 'relay.example.com', origins: ['https://relay.example.com'] };
const mk = (alg: Alg = -7): VirtualAuthenticator => new VirtualAuthenticator({ alg, rpId: rp.rpId, origin: rp.origins[0]! });
const CH = b64u(new Uint8Array(32).fill(7));

function registered(a: VirtualAuthenticator): StoredCredential {
  const m = a.create(CH);
  const r = verifyRegistration({ expectedChallenge: CH, rp, ...m });
  if (!r.ok) throw new Error(`registration failed: ${r.why}`);
  return r.cred;
}
const assertion = (a: VirtualAuthenticator, cred: StoredCredential, o: Parameters<VirtualAuthenticator['get']>[1] = {}, expected = CH) =>
  verifyAssertion({ expectedChallenge: expected, rp, cred, response: a.get(CH, o) });

describe('step-up: registration (WebAuthn create) is verified by the host', () => {
  for (const alg of [-7, -8, -257] as const) {
    it(`accepts a fresh credential (alg ${alg}) and stores its public key`, () => {
      const a = mk(alg);
      const cred = registered(a);
      expect(cred.alg).toBe(alg);
      expect(cred.id).toBe(a.id);
      expect(cred.signCount).toBe(0);
      expect(JSON.stringify(cred)).not.toMatch(/"d"|private/); // public data only
    });
  }

  const bad = (o: Parameters<VirtualAuthenticator['create']>[1], why: string, expected = CH): void => {
    const a = mk();
    const r = verifyRegistration({ expectedChallenge: expected, rp, ...a.create(CH, o) });
    expect(r).toEqual({ ok: false, why });
  };
  it('refuses a tampered challenge', () => bad({ challenge: b64u(new Uint8Array(32).fill(9)) }, 'challenge'));
  it('refuses a wrong rpId', () => bad({ rpId: 'evil.example.com' }, 'rp'));
  it('refuses a wrong origin', () => bad({ origin: 'https://evil.example.com' }, 'origin'));
  it('refuses a cross-origin ceremony', () => bad({ crossOrigin: true }, 'origin'));
  it('refuses a missing user verification flag', () => bad({ uv: false }, 'user_verification'));
  it('refuses a missing user presence flag', () => bad({ up: false }, 'user_presence'));
  it('refuses the wrong ceremony type', () => bad({ type: 'webauthn.get' }, 'type'));
  it('refuses a credential id that differs from the attested one', () => {
    const a = mk(); const m = a.create(CH);
    expect(verifyRegistration({ expectedChallenge: CH, rp, ...m, id: b64u(new Uint8Array(32).fill(1)) })).toEqual({ ok: false, why: 'credential' });
  });
  it('refuses garbage as attestation, and an unsupported key algorithm', () => {
    const a = mk(); const m = a.create(CH);
    expect(verifyRegistration({ expectedChallenge: CH, rp, ...m, ao: b64u(new Uint8Array(40).fill(0xff)) })).toEqual({ ok: false, why: 'attestation' });
    expect(verifyRegistration({ expectedChallenge: CH, rp, ...m, id: 'not base64url!!' })).toEqual({ ok: false, why: 'malformed' });
  });
  it('refuses an RSA key below 2048 bits', () => {
    const small = new VirtualAuthenticator({ alg: -257, rpId: rp.rpId, origin: rp.origins[0]!, rsaBits: 1024 });
    expect(verifyRegistration({ expectedChallenge: CH, rp, ...small.create(CH) })).toEqual({ ok: false, why: 'key' });
  });
});

describe('step-up: assertion (WebAuthn get) is verified by the host', () => {
  for (const alg of [-7, -8, -257] as const) {
    it(`accepts a good assertion (alg ${alg}) and returns the new counter`, () => {
      const a = mk(alg); const cred = registered(a);
      const r = assertion(a, cred);
      expect(r).toEqual({ ok: true, signCount: 1 });
    });
  }

  it('refuses a tampered challenge', () => {
    const a = mk(); const cred = registered(a);
    expect(assertion(a, cred, {}, b64u(new Uint8Array(32).fill(1)))).toEqual({ ok: false, why: 'challenge' });
    expect(assertion(a, cred, { challenge: b64u(new Uint8Array(32).fill(2)) })).toEqual({ ok: false, why: 'challenge' });
  });
  it('refuses a wrong rpId (rpIdHash of another site)', () => { const a = mk(); expect(assertion(a, registered(a), { rpId: 'evil.example.com' })).toEqual({ ok: false, why: 'rp' }); });
  it('refuses a wrong origin', () => { const a = mk(); expect(assertion(a, registered(a), { origin: 'https://evil.example.com' })).toEqual({ ok: false, why: 'origin' }); });
  it('refuses when the user was not verified (no UV flag)', () => { const a = mk(); expect(assertion(a, registered(a), { uv: false })).toEqual({ ok: false, why: 'user_verification' }); });
  it('refuses when user presence is missing', () => { const a = mk(); expect(assertion(a, registered(a), { up: false })).toEqual({ ok: false, why: 'user_presence' }); });
  it('refuses a create ceremony presented as an assertion', () => { const a = mk(); expect(assertion(a, registered(a), { type: 'webauthn.create' })).toEqual({ ok: false, why: 'type' }); });
  it('refuses a signature from another key, and a corrupted signature', () => {
    const a = mk(); const cred = registered(a);
    expect(assertion(a, cred, { wrongKey: true })).toEqual({ ok: false, why: 'signature' });
    expect(assertion(a, cred, { badSignature: true })).toEqual({ ok: false, why: 'signature' });
  });
  it("refuses another device's credential id", () => {
    const a = mk(); const cred = registered(a); const b = mk();
    expect(verifyAssertion({ expectedChallenge: CH, rp, cred, response: b.get(CH) })).toEqual({ ok: false, why: 'credential' });
  });
  it('refuses a signCount rollback (a cloned authenticator) and a repeated counter', () => {
    const a = mk(); const cred = registered(a);
    const first = assertion(a, cred); expect(first.ok).toBe(true);
    const stored = { ...cred, signCount: first.ok ? first.signCount : 0 };
    expect(assertion(a, stored, { signCount: 0 })).toEqual({ ok: false, why: 'sign_count' });
    expect(assertion(a, stored, { signCount: stored.signCount })).toEqual({ ok: false, why: 'sign_count' });
    expect(assertion(a, stored, { signCount: stored.signCount + 5 }).ok).toBe(true);
  });
  it('accepts an authenticator that never counts (0 and 0)', () => {
    const a = mk(); a.neverCounts = true; const cred = registered(a);
    expect(assertion(a, cred)).toEqual({ ok: true, signCount: 0 });
    expect(assertion(a, cred)).toEqual({ ok: true, signCount: 0 });
  });
  it('refuses malformed fields without throwing', () => {
    const a = mk(); const cred = registered(a); const m = a.get(CH);
    expect(verifyAssertion({ expectedChallenge: CH, rp, cred, response: { ...m, ad: b64u(new Uint8Array(10)) } })).toEqual({ ok: false, why: 'malformed' });
    expect(verifyAssertion({ expectedChallenge: CH, rp, cred, response: { ...m, cd: b64u(new TextEncoder().encode('not json')) } })).toEqual({ ok: false, why: 'malformed' });
  });
});

describe('challenge derivation and command digests', () => {
  it('the challenge binds purpose, nonce and command digest', async () => {
    const n = new Uint8Array(32).fill(3); const d = await commandDigest('prompt', 'abc123def456', 'hello');
    const base = b64u(await stepupChallenge('cmd', n, d));
    expect(b64u(await stepupChallenge('cmd', n, d))).toBe(base);
    expect(b64u(await stepupChallenge('unlock', n, d))).not.toBe(base);
    expect(b64u(await stepupChallenge('cmd', new Uint8Array(32).fill(4), d))).not.toBe(base);
    expect(b64u(await stepupChallenge('cmd', n, await commandDigest('prompt', 'abc123def456', 'hello!')))).not.toBe(base);
  });
  it('digests are unambiguous (length-prefixed fields)', async () => {
    expect(await commandDigest('prompt', 'a', 'bc')).not.toBe(await commandDigest('prompt', 'ab', 'c'));
    expect(await commandDigest('prompt', 'abcdef', 'x')).not.toBe(await commandDigest('start', 'abcdef', 'x'));
  });
});

describe('CBOR decoder (the subset WebAuthn needs) refuses what it does not understand', () => {
  it('decodes maps, ints, bytes and text', () => {
    const r = decodeCbor(Uint8Array.from([0xa2, 0x01, 0x02, 0x20, 0x41, 0xff]));
    expect(r.value).toEqual(new Map<number | string, unknown>([[1, 2], [-1, Uint8Array.from([0xff])]]));
  });
  it('refuses indefinite lengths, tags, floats, truncation and absurd nesting', () => {
    expect(() => decodeCbor(Uint8Array.from([0x5f, 0x41, 0x00, 0xff]))).toThrow();
    expect(() => decodeCbor(Uint8Array.from([0xc1, 0x01]))).toThrow();
    expect(() => decodeCbor(Uint8Array.from([0xf9, 0x3c, 0x00]))).toThrow();
    expect(() => decodeCbor(Uint8Array.from([0x42, 0x01]))).toThrow();
    expect(() => decodeCbor(Uint8Array.from(new Array(20).fill(0x81)))).toThrow();
  });
});

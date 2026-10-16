/**
 * Step-up for remote control, device side (protocol 3, WP2). API only: no screens. The computer verifies every assertion itself (docs/PROTOCOL3.md
 * section 4); this file turns the host's challenge messages into WebAuthn calls and the browser's answers into the messages the host expects.
 *
 * The page supplies a `StepUpTransport` (how to send an inner message to the computer and how to wait for its next message of a kind: `Link` in link.ts is
 * the natural place to implement it). `credentials` defaults to `navigator.credentials` and is a parameter so tests can pass a virtual authenticator.
 * Licence: Apache-2.0.
 */
import {
  SuAssertData, SuChallengeData, SuRegChallengeData, SuRegData, SuRegResultData, SuResultData, b64u, commandDigest, newCid, unb64u,
  type CommandKind, type SuBeginData,
} from '../../src/protocol/index.ts';

export interface StepUpTransport {
  /** seal and send one inner message to the computer (`su_begin`, `su_assert`, `su_regbegin`, `su_reg`); false/rejects when it could not be sent */
  send(kind: string, data: unknown): Promise<unknown>;
  /** resolves with the data of the next message of `kind` from the computer; rejects after `ms` */
  next(kind: string, ms: number): Promise<unknown>;
}

export interface CredentialsLike {
  create(o: { publicKey: PublicKeyCredentialCreationOptions }): Promise<Credential | null>;
  get(o: { publicKey: PublicKeyCredentialRequestOptions }): Promise<Credential | null>;
}

/** can this browser do it at all? (a secure context with WebAuthn and a user-verifying platform authenticator is checked separately by `platformAuthenticatorAvailable`) */
export function stepupSupported(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext === true && typeof navigator !== 'undefined' && !!navigator.credentials && typeof PublicKeyCredential !== 'undefined';
}
export async function platformAuthenticatorAvailable(): Promise<boolean> {
  try { return stepupSupported() && (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()); } catch { return false; }
}

const WAIT_MS = 20_000;
const buf = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

/** the options for `navigator.credentials.create` from the host's registration challenge */
export function registrationOptions(c: SuRegChallengeData, deviceName: string): PublicKeyCredentialCreationOptions {
  return {
    challenge: buf(unb64u(c.ch)),
    rp: { id: c.rp, name: 'Botwarren Companion' },
    user: { id: buf(unb64u(c.user)), name: deviceName, displayName: deviceName },
    pubKeyCredParams: c.algs.map((alg) => ({ type: 'public-key' as const, alg })),
    authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
    attestation: 'none',
    timeout: 60_000,
  };
}

/** the options for `navigator.credentials.get` from the host's challenge: only the registered credential, user verification required */
export function assertionOptions(c: SuChallengeData): PublicKeyCredentialRequestOptions {
  return { challenge: buf(unb64u(c.ch)), rpId: c.rp, allowCredentials: [{ type: 'public-key', id: buf(unb64u(c.cred)) }], userVerification: 'required', timeout: 60_000 };
}

/** what the browser returned from `create`, as the `su_reg` message */
export function registrationMessage(ch: string, cred: Credential): SuRegData {
  const pk = cred as PublicKeyCredential; const r = pk.response as AuthenticatorAttestationResponse;
  return SuRegData.parse({ ch, id: b64u(new Uint8Array(pk.rawId)), ao: b64u(new Uint8Array(r.attestationObject)), cd: b64u(new Uint8Array(r.clientDataJSON)) });
}

/** what the browser returned from `get`, as the `su_assert` message */
export function assertionMessage(ch: string, cred: Credential): SuAssertData {
  const pk = cred as PublicKeyCredential; const r = pk.response as AuthenticatorAssertionResponse;
  return SuAssertData.parse({ ch, id: b64u(new Uint8Array(pk.rawId)), ad: b64u(new Uint8Array(r.authenticatorData)), cd: b64u(new Uint8Array(r.clientDataJSON)), sig: b64u(new Uint8Array(r.signature)) });
}

/**
 * Register this device's fingerprint or face lock with the computer. The computer first asks its owner at the keyboard (so this can take up to a minute);
 * a refusal or a cancelled prompt comes back as `{ok:false, why}`.
 */
export async function registerCredential(t: StepUpTransport, deviceName: string, credentials: CredentialsLike = navigator.credentials as CredentialsLike): Promise<SuRegResultData> {
  const challenge = t.next('su_regchallenge', 75_000);
  const early = t.next('su_regresult', 75_000); // a refusal ("declined") arrives instead of a challenge
  early.catch(() => undefined); challenge.catch(() => undefined);
  await t.send('su_regbegin', {});
  const first = await Promise.race([challenge.then((d) => ({ c: d })), early.then((d) => ({ r: d }))]);
  if ('r' in first) return SuRegResultData.parse(first.r);
  const c = SuRegChallengeData.parse(first.c);
  const result = t.next('su_regresult', WAIT_MS + 60_000);
  result.catch(() => undefined);
  let cred: Credential | null;
  try { cred = await credentials.create({ publicKey: registrationOptions(c, deviceName) }); } catch { return { ok: false, why: 'declined' }; }
  if (!cred) return { ok: false, why: 'declined' };
  await t.send('su_reg', registrationMessage(c.ch, cred));
  return SuRegResultData.parse(await result);
}

/** one begin, assertion, result round trip; the host answers `su_challenge` then `su_result` */
async function round(t: StepUpTransport, begin: SuBeginData, credentials: CredentialsLike): Promise<ReturnType<typeof SuResultData.parse>> {
  const challenge = t.next('su_challenge', WAIT_MS);
  const early = t.next('su_result', WAIT_MS); // a refusal (`no_credential`, `scope`, `rate`...) arrives instead of a challenge
  early.catch(() => undefined); challenge.catch(() => undefined);
  await t.send('su_begin', begin);
  const first = await Promise.race([challenge.then((d) => ({ c: d })), early.then((d) => ({ r: d }))]);
  if ('r' in first) return SuResultData.parse(first.r);
  const c = SuChallengeData.parse(first.c);
  const result = t.next('su_result', WAIT_MS);
  result.catch(() => undefined);
  let cred: Credential | null;
  try { cred = await credentials.get({ publicKey: assertionOptions(c) }); } catch { return { for: begin.for, ...(begin.cid ? { cid: begin.cid } : {}), ok: false, why: 'user_verification' }; }
  if (!cred) return { for: begin.for, ...(begin.cid ? { cid: begin.cid } : {}), ok: false, why: 'user_verification' };
  await t.send('su_assert', assertionMessage(c.ch, cred));
  return SuResultData.parse(await result);
}

/** opens the unlock window (15 minutes by default) for `prompt` and free-text `answer`; `until` in the result is when it ends */
export function unlock(t: StepUpTransport, credentials: CredentialsLike = navigator.credentials as CredentialsLike) {
  return round(t, { for: 'unlock' }, credentials);
}

/**
 * A fresh assertion for ONE command (always needed for `start`). Pass the same `cid` and the exact text you are about to send with `prompt`, `answer` or
 * `start`; `target` is the session id (`prompt`, `answer`) or `launchId + ":" + mode` (`start`).
 */
export async function stepUpForCommand(t: StepUpTransport, c: { kind: Exclude<CommandKind, 'interrupt'>; cid?: string; target: string; text?: string }, credentials: CredentialsLike = navigator.credentials as CredentialsLike) {
  const cid = c.cid ?? newCid();
  const digest = await commandDigest(c.kind, c.target, c.text ?? '');
  const r = await round(t, { for: 'cmd', cid, kind: c.kind, digest }, credentials);
  return { ...r, cid };
}

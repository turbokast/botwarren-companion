import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { controlWorld, sleep, type ControlWorld } from './support/control-world.ts';
import type { VirtualAuthenticator } from './support/virtual-authenticator.ts';
import type { SimDevice } from './simdevice.ts';
import { CAP_LONG, commandDigest, newCid, type CommandKind, type SuResultData } from '../src/protocol/index.ts';

/**
 * Step-up (WebAuthn) through the whole path: relay, host, protocol messages, a virtual authenticator. The host verifies every assertion itself and a command's
 * assertion is bound to its exact text and target. See docs/PROTOCOL3.md section 4.
 */
let cw: ControlWorld | null = null;
let offset = 0;
afterEach(async () => { await cw?.close(); cw = null; offset = 0; });
const make = async (o: Parameters<typeof controlWorld>[0] = {}): Promise<ControlWorld> => { cw = await controlWorld({ world: { now: () => Date.now() + offset }, ...o }); return cw; };

/** one su_begin; resolves with the challenge, or with the host's immediate refusal */
async function begin(d: SimDevice, data: Record<string, unknown>): Promise<{ ch?: string; fail?: SuResultData }> {
  const nc = d.suChallenges.length; const nr = d.suResults.length;
  await d.send('su_begin', data);
  const got = await d.waitFor(() => d.suChallenges[nc] ?? d.suResults[nr]);
  return 'ch' in got ? { ch: got.ch } : { fail: got };
}
/** begin + assert with `o` applied to the authenticator's answer */
async function stepUp(d: SimDevice, auth: VirtualAuthenticator, data: Record<string, unknown>, o: Parameters<VirtualAuthenticator['get']>[1] = {}, tweak: (m: Record<string, string>) => Record<string, string> = (m) => m): Promise<SuResultData> {
  const nr = d.suResults.length;
  const b = await begin(d, data);
  if (b.fail) return b.fail;
  await d.send('su_assert', tweak({ ch: b.ch!, ...auth.get(b.ch!, o) }));
  return d.waitFor(() => d.suResults[nr]);
}
const cmdStep = async (d: SimDevice, auth: VirtualAuthenticator, kind: Exclude<CommandKind, 'interrupt'>, cid: string, target: string, text: string, o: Parameters<VirtualAuthenticator['get']>[1] = {}): Promise<SuResultData> =>
  stepUp(d, auth, { for: 'cmd', cid, kind, digest: await commandDigest(kind, target, text) }, o);

describe('step-up registration', () => {
  it('stores only the public key, after the owner says yes at the computer, and the state then says webauthn', async () => {
    const w = await make(); const auth = w.authenticator();
    expect((await begin(w.phone, { for: 'unlock' })).fail).toMatchObject({ ok: false, why: 'no_credential' });
    await w.register(auth);
    expect(w.asked.at(-1)).toMatchObject({ kind: 'stepup_add', device: 'Sim phone' });
    const stored = readFileSync(join(w.w.daemon.store.dir, 'devices.json'), 'utf8');
    expect(JSON.parse(stored)[0].cred).toMatchObject({ id: auth.id, alg: -7, signCount: 0 });
    expect(stored).not.toMatch(/"d":|PRIVATE|"priv/i);
    await w.phone.waitFor(() => w.phone.latest?.host.ctl?.stepup === 'webauthn');
  });

  it('is refused when the owner declines, and a registration with a tampered or reused challenge is refused', async () => {
    const w = await make(); const auth = w.authenticator();
    w.person.answer = false;
    await w.phone.send('su_regbegin', {});
    expect(await w.phone.waitFor(() => w.phone.suRegResults[0])).toEqual({ ok: false, why: 'declined' });
    w.person.answer = true;
    // tampered challenge
    await w.phone.send('su_regbegin', {});
    const c = await w.phone.waitFor(() => w.phone.suRegChallenges[0]);
    await w.phone.send('su_reg', { ch: c.ch.slice(0, -1) + (c.ch.endsWith('A') ? 'B' : 'A'), ...auth.create(c.ch) });
    expect(await w.phone.waitFor(() => w.phone.suRegResults[1])).toMatchObject({ ok: false, why: 'challenge' });
    // a credential made for another challenge, wrong rpId, no UV: each consumes its challenge
    const attempts: [Parameters<VirtualAuthenticator['create']>[1], string][] = [[{ challenge: 'Zm9v' }, 'challenge'], [{ rpId: 'evil.example' }, 'rp'], [{ uv: false }, 'user_verification'], [{ origin: 'https://evil.example' }, 'origin']];
    for (const [o, why] of attempts) {
      const n = w.phone.suRegResults.length; const nc = w.phone.suRegChallenges.length;
      await w.phone.send('su_regbegin', {});
      const ch = await w.phone.waitFor(() => w.phone.suRegChallenges[nc]);
      await w.phone.send('su_reg', { ch: ch.ch, ...auth.create(ch.ch, o) });
      expect(await w.phone.waitFor(() => w.phone.suRegResults[n]), why).toMatchObject({ ok: false, why });
    }
    // none of them registered anything; and the challenge is single use
    expect(JSON.parse(readFileSync(join(w.w.daemon.store.dir, 'devices.json'), 'utf8'))[0].cred).toBeUndefined();
    const n = w.phone.suRegResults.length;
    await w.phone.send('su_reg', { ch: c.ch, ...auth.create(c.ch) });
    expect(await w.phone.waitFor(() => w.phone.suRegResults[n])).toMatchObject({ ok: false, why: 'no_challenge' });
  });

  it('limits registrations to 6 an hour per device', async () => {
    const w = await make(); const auth = w.authenticator();
    for (let i = 0; i < 6; i++) await w.register(auth);
    const n = w.phone.suRegResults.length;
    await w.phone.send('su_regbegin', {});
    expect(await w.phone.waitFor(() => w.phone.suRegResults[n])).toMatchObject({ ok: false, why: 'rate' });
  });
});

describe('step-up for commands', () => {
  const setup = async (o: Parameters<typeof controlWorld>[0] = {}): Promise<{ w: ControlWorld; auth: VirtualAuthenticator; sid: string; bind: () => Promise<string> }> => {
    const w = await make(o); const auth = w.authenticator();
    await w.register(auth);
    const s = await w.session('k-su');
    return { w, auth, sid: s.sid, bind: s.bind };
  };
  const prompt = async (w: ControlWorld, sid: string, bind: string, text: string, cid = newCid()) => { await w.phone.cmd('prompt', { sid, bind, text }, { cid }); return w.phone.result(cid); };

  it('asks for a step-up first (nothing delivered, nobody asked at the computer), then delivers after an unlock', async () => {
    const { w, auth, sid, bind } = await setup();
    const asked = w.asked.length;
    expect(await prompt(w, sid, await bind(), 'needs a step-up')).toMatchObject({ outcome: 'needs_stepup' });
    expect(w.fake.received.prompts).toHaveLength(0);
    const u = await w.unlock(auth);
    expect(u).toMatchObject({ for: 'unlock', ok: true });
    expect(u.until! - Date.now()).toBeGreaterThan(14 * 60_000);
    expect(u.until! - Date.now()).toBeLessThanOrEqual(15 * 60_000);
    expect(await prompt(w, sid, await bind(), 'inside the window')).toMatchObject({ outcome: 'applied' });
    expect(w.fake.received.prompts.map((p) => p.text)).toEqual(['inside the window']);
    expect(w.asked.length).toBe(asked); // a credential replaces the local confirmation
    expect(JSON.parse(readFileSync(join(w.w.daemon.store.dir, 'devices.json'), 'utf8'))[0].cred.signCount).toBe(1);
  });

  it('the unlock window ends: after it, a prompt needs a step-up again', async () => {
    const { w, auth, sid, bind } = await setup({ control: { unlockMinutes: 1 } });
    await w.unlock(auth);
    expect(await prompt(w, sid, await bind(), 'in the window')).toMatchObject({ outcome: 'applied' });
    offset = 70_000; // the computer's clock moves on past the 1-minute window (devices and the relay keep the real time)
    const cid = newCid();
    await w.phone.cmd('prompt', { sid, bind: await bind(), text: 'after the window', x: Date.now() + 100_000 }, { cid }); // (a fresh command would itself have expired by now)
    expect(await w.phone.result(cid)).toMatchObject({ outcome: 'needs_stepup' });
    expect(w.fake.received.prompts).toHaveLength(1);
  });

  it('start always needs a fresh assertion, even inside the unlock window, and a grant is for that command only', async () => {
    const { w, auth } = await setup();
    await w.unlock(auth);
    const cid = newCid();
    await w.phone.cmd('start', { launchId: 'dragons', mode: 'default', text: 'go' }, { cid });
    expect(await w.phone.result(cid)).toMatchObject({ outcome: 'needs_stepup' });
    expect(await cmdStep(w.phone, auth, 'start', cid, 'dragons:default', 'go')).toMatchObject({ for: 'cmd', cid, ok: true });
    await w.phone.cmd('start', { launchId: 'dragons', mode: 'default', text: 'go' }, { cid });
    expect(await w.phone.result(cid)).toMatchObject({ outcome: 'applied' });
    expect(w.fake.received.starts).toHaveLength(1);
    // the grant was used up: a second start (new id) needs its own
    const cid2 = newCid();
    await w.phone.cmd('start', { launchId: 'dragons', mode: 'default', text: 'go' }, { cid: cid2 });
    expect(await w.phone.result(cid2)).toMatchObject({ outcome: 'needs_stepup' });
    expect(w.fake.received.starts).toHaveLength(1);
  });

  it('refuses a command whose text or target differs from what was asserted (stepup_invalid)', async () => {
    const { w, auth, sid, bind } = await setup();
    const b = await bind(); const cid = newCid();
    expect(await cmdStep(w.phone, auth, 'prompt', cid, sid, 'the text the person confirmed')).toMatchObject({ ok: true });
    expect(await prompt(w, sid, b, 'a different text sent afterwards', cid)).toMatchObject({ outcome: 'refused', why: 'stepup_invalid' });
    expect(w.fake.received.prompts).toHaveLength(0);
    // the exact text (same id) is then accepted: the grant was not burnt by the mismatch
    expect(await prompt(w, sid, b, 'the text the person confirmed', cid)).toMatchObject({ outcome: 'applied' });
    // a kind mismatch is also refused: an assertion for a prompt does not authorise a start
    const cid2 = newCid();
    expect(await cmdStep(w.phone, auth, 'prompt', cid2, 'dragons:default', 'go')).toMatchObject({ ok: true });
    await w.phone.cmd('start', { launchId: 'dragons', mode: 'default', text: 'go' }, { cid: cid2 });
    expect(await w.phone.result(cid2)).toMatchObject({ outcome: 'refused', why: 'stepup_invalid' });
    expect(w.fake.received.starts).toHaveLength(0);
  });

  it('refuses a tampered or reused challenge, an expired one, and answers nothing for an assertion nobody asked for', async () => {
    const { w, auth } = await setup({ control: { unlockMinutes: 1 } });
    // an assertion made over another challenge
    expect(await stepUp(w.phone, auth, { for: 'unlock' }, { challenge: 'Zm9vYmFy' })).toMatchObject({ ok: false, why: 'challenge' });
    // the `ch` field changed after the host issued it
    expect(await stepUp(w.phone, auth, { for: 'unlock' }, {}, (m) => ({ ...m, ch: m.ch!.slice(0, -1) + (m.ch!.endsWith('A') ? 'B' : 'A') }))).toMatchObject({ ok: false, why: 'challenge' });
    // single use: the same assertion again
    const nr = w.phone.suResults.length;
    const b = await begin(w.phone, { for: 'unlock' });
    const m = auth.get(b.ch!);
    await w.phone.send('su_assert', { ch: b.ch!, ...m });
    await w.phone.waitFor(() => w.phone.suResults[nr]);
    await w.phone.send('su_assert', { ch: b.ch!, ...m });
    expect(await w.phone.waitFor(() => w.phone.suResults[nr + 1])).toMatchObject({ ok: false, why: 'no_challenge' });
    // expired
    const b2 = await begin(w.phone, { for: 'unlock' });
    offset = 70_000;
    await w.phone.send('su_assert', { ch: b2.ch!, ...auth.get(b2.ch!) });
    expect(await w.phone.waitFor(() => w.phone.suResults[nr + 2])).toMatchObject({ ok: false, why: 'expired' });
  });

  it('refuses a wrong rpId, a wrong origin, no user verification, a bad signature and a signCount rollback', async () => {
    const { w, auth } = await setup();
    const cases: [Parameters<VirtualAuthenticator['get']>[1], string][] = [[{ rpId: 'evil.example' }, 'rp'], [{ origin: 'https://evil.example' }, 'origin'], [{ uv: false }, 'user_verification'], [{ up: false }, 'user_presence'], [{ wrongKey: true }, 'signature'], [{ badSignature: true }, 'signature'], [{ type: 'webauthn.create' }, 'type']];
    for (const [o, why] of cases) expect(await stepUp(w.phone, auth, { for: 'unlock' }, o), why).toMatchObject({ ok: false, why });
    // two good ones raise the counter; then a replayed lower counter (a cloned authenticator) is refused
    expect(await stepUp(w.phone, auth, { for: 'unlock' })).toMatchObject({ ok: true });
    expect(await stepUp(w.phone, auth, { for: 'unlock' })).toMatchObject({ ok: true });
    const stored = (): number => (JSON.parse(readFileSync(join(w.w.daemon.store.dir, 'devices.json'), 'utf8'))[0].cred as { signCount: number }).signCount;
    const now = stored();
    expect(await stepUp(w.phone, auth, { for: 'unlock' }, { signCount: 1 })).toMatchObject({ ok: false, why: 'sign_count' });
    expect(await stepUp(w.phone, auth, { for: 'unlock' }, { signCount: now })).toMatchObject({ ok: false, why: 'sign_count' });
    expect(await stepUp(w.phone, auth, { for: 'unlock' }, { signCount: 50 })).toMatchObject({ ok: true });
    // none of the failures opened a window or burnt a good counter
    expect(JSON.parse(readFileSync(join(w.w.daemon.store.dir, 'devices.json'), 'utf8'))[0].cred.signCount).toBe(50);
  });

  it('accepts an authenticator that never counts (always 0)', async () => {
    const w = await make(); const auth = w.authenticator(); auth.neverCounts = true;
    await w.register(auth);
    expect(await stepUp(w.phone, auth, { for: 'unlock' })).toMatchObject({ ok: true });
    expect(await stepUp(w.phone, auth, { for: 'unlock' })).toMatchObject({ ok: true });
  });

  it('works with EdDSA and RS256 credentials too', async () => {
    for (const alg of [-8, -257] as const) {
      const w = await make(); const auth = w.authenticator(alg);
      await w.register(auth);
      expect(await stepUp(w.phone, auth, { for: 'unlock' }), String(alg)).toMatchObject({ ok: true });
      await w.close(); cw = null;
    }
  });

  it('limits step-up attempts to 20 a minute per device', async () => {
    const { w } = await setup();
    let last: SuResultData | undefined;
    for (let i = 0; i < 21; i++) { const r = await begin(w.phone, { for: 'unlock' }); if (r.fail) last = r.fail; }
    expect(last).toMatchObject({ ok: false, why: 'rate' });
  });

  it('is refused for a device without scope control, and while remote control is off', async () => {
    const { w, auth } = await setup();
    w.w.daemon.host.setDeviceScope(w.phone.id.id, 'answer');
    expect((await begin(w.phone, { for: 'unlock' })).fail).toMatchObject({ ok: false, why: 'scope' });
    w.w.daemon.host.setDeviceScope(w.phone.id.id, 'control');
    w.setControl({ mode: 'off' });
    expect((await begin(w.phone, { for: 'unlock' })).fail).toMatchObject({ ok: false, why: 'control_off' });
    void auth;
  });

  it('refuses a malformed step-up message and a command-step-up without cid, kind and digest', async () => {
    const { w } = await setup();
    expect((await begin(w.phone, { for: 'cmd' })).fail).toMatchObject({ ok: false, why: 'malformed' });
    expect((await begin(w.phone, { for: 'unlock', extra: true })).fail).toMatchObject({ ok: false, why: 'malformed' });
  });

  it("another device's step-up is worth nothing to this one (grants, unlocks and challenges are per device)", async () => {
    const { w, auth, sid, bind } = await setup();
    const other = await w.w.pairDevice('Second', { caps: [CAP_LONG], proto: 3 });
    w.w.daemon.host.setDeviceScope(other.id.id, 'control');
    const authB = w.authenticator();
    await w.register(authB, other);
    const b = await bind();
    // A unlocks and gets a grant for a command id; B sends a command with that id
    await w.unlock(auth);
    const cid = newCid();
    await cmdStep(w.phone, auth, 'prompt', cid, sid, 'hello');
    await other.cmd('prompt', { sid, bind: b, text: 'hello' }, { cid });
    expect(await other.result(cid)).toMatchObject({ outcome: 'needs_stepup' });
    expect(w.fake.received.prompts).toHaveLength(0);
    // B cannot answer a challenge with A's authenticator (not its credential), nor assert a challenge A was given
    expect(await stepUp(other, auth, { for: 'unlock' })).toMatchObject({ ok: false, why: 'credential' });
    const nr = other.suResults.length;
    await other.send('su_assert', { ch: 'A'.repeat(43), ...auth.get('A'.repeat(43)) });
    expect(await other.waitFor(() => other.suResults[nr])).toMatchObject({ ok: false, why: 'no_challenge' });
    // and A's own grant still works for A
    await w.phone.cmd('prompt', { sid, bind: b, text: 'hello' }, { cid });
    expect(await w.phone.result(cid)).toMatchObject({ outcome: 'applied' });
  });

  it('with "confirm every command" on, a credential is not enough: the owner is asked, and the real text is shown', async () => {
    const { w, auth, sid, bind } = await setup();
    w.w.daemon.host.setDeviceConfirm(w.phone.id.id, true);
    await w.unlock(auth);
    const before = w.asked.length;
    expect(await prompt(w, sid, await bind(), 'show me this exact text')).toMatchObject({ outcome: 'applied' });
    expect(w.asked.slice(before)).toMatchObject([{ kind: 'prompt', preview: 'show me this exact text' }]);
    w.person.answer = false;
    expect(await prompt(w, sid, await bind(), 'and this one')).toMatchObject({ outcome: 'refused', why: 'local_declined' });
    expect(w.fake.received.prompts.map((p) => p.text)).toEqual(['show me this exact text']);
  });

  it('a stop never needs a step-up', async () => {
    const { w, sid, bind } = await setup();
    const cid = await w.phone.cmd('interrupt', { sid, bind: await bind() });
    expect(await w.phone.result(cid)).toMatchObject({ outcome: expect.stringMatching(/applied|sent/) });
    await sleep(10);
  });
});

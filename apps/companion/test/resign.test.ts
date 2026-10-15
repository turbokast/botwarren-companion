/**
 * The scheduled re-sign: renewing the CURRENT component manifest (same release, same bundle bytes, counter + 1, fresh 90 days) before it lapses.
 * Everything runs with a throw-away key injected for the pinned set; the real component key never signs anything in a test.
 */
import { createHash, generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { writeZip } from '../vendor/agent/src/update/archive.ts';
import { signComponentBytes, verifyComponentManifest } from '../vendor/agent/src/component/verify.ts';
// @ts-expect-error plain JS modules without types
import { checkResigned, planResign, prepareResign } from '../scripts/resign-component-manifest.mjs';

const DAY = 86_400_000;
const script = join(import.meta.dirname, '..', 'scripts', 'resign-component-manifest.mjs');
const tmp: string[] = [];
const mk = (): string => { const d = mkdtempSync(join(tmpdir(), 'bw-resign-')); tmp.push(d); return d; };
afterAll(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });

const pair = () => { const k = generateKeyPairSync('ed25519'); return { pem: k.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), spki: k.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') }; };
const KEY = pair(); const OTHER = pair();
const keys = [{ id: 'test-comp', spki: KEY.spki, dev: false, role: 'component' as const }];
const T0 = new Date('2026-10-15T12:00:00.000Z');

const bundle = (version: string, over: Record<string, string> = {}): Buffer => writeZip(Object.entries({ 'companion.mjs': 'x\n', VERSION: `${version}\n`, LICENSE: 'l\n', NOTICE: 'n\n', ...over }).map(([name, data]) => ({ name, data: Buffer.from(data), mode: 0o644 })));

/** a published manifest (signed `ageDays` days before `now`) and its bundle */
function published(o: { version?: string; manifestVersion?: number; issuedAt?: Date; blocked?: string[]; signer?: { pem: string } } = {}) {
  const version = o.version ?? '0.1.1';
  const zip = bundle(version);
  const issued = o.issuedAt ?? T0;
  const doc = {
    schema: 1, kind: 'botwarren-component', component: 'companion', epoch: 1, manifestVersion: o.manifestVersion ?? 7, issued: issued.toISOString(), expires: new Date(issued.getTime() + 90 * DAY).toISOString(),
    channels: { stable: version }, blocked: o.blocked ?? ['0.0.9'],
    releases: { [version]: { commit: 'abcdef1', protocol: { min: 1, max: 1 }, bundle: { url: `companion-${version}.zip`, sha256: createHash('sha256').update(zip).digest('hex'), size: zip.length }, minAgent: '0.7.0', minRuntime: '22.13.0' } },
  };
  const bytes = Buffer.from(JSON.stringify(doc, null, 2) + '\n');
  return { bytes, sig: signComponentBytes(bytes, (o.signer ?? KEY).pem, 'test-comp'), zip, doc };
}
const at = (days: number): Date => new Date(T0.getTime() + days * DAY);

describe('plan: when does the published manifest need renewing', () => {
  it('counts the days left and renews inside the window (or when forced)', () => {
    const p = published();
    expect(planResign({ ...p, now: at(10), keys })).toMatchObject({ version: '0.1.1', manifestVersion: 7, daysLeft: 80, needed: false });
    expect(planResign({ ...p, now: at(46), keys })).toMatchObject({ daysLeft: 44, needed: true });
    expect(planResign({ ...p, now: at(10), keys, force: true }).needed).toBe(true);
    expect(planResign({ ...p, now: at(10), keys, withinDays: 90 }).needed).toBe(true);
  });
  it('still reads an expired manifest (renewing it is the point) but never one it cannot verify', () => {
    const p = published();
    expect(planResign({ ...p, now: at(100), keys })).toMatchObject({ needed: true });
    expect(planResign({ ...p, now: at(100), keys }).daysLeft).toBeLessThan(0);
    const wrong = published({ signer: OTHER });
    expect(() => planResign({ ...wrong, now: at(10), keys })).toThrow(/does not verify against the pinned component keys \(bad_signature\)/);
    expect(() => planResign({ ...p, sig: 'nope', now: at(10), keys })).toThrow(/bad_signature_file/);
    expect(() => planResign({ bytes: Buffer.from('{'), sig: p.sig, now: at(10), keys })).toThrow(/not JSON/);
  });
});

describe('prepare: the new manifest can change only the counter and the dates', () => {
  it('keeps the same channels, releases, hashes and blocked list; counter + 1; fresh 90 days', () => {
    const p = published();
    const now = at(50);
    const r = prepareResign({ bytes: p.bytes, sig: p.sig, zip: p.zip, now, keys });
    expect(r.manifest).toMatchObject({ manifestVersion: 8, epoch: 1, issued: now.toISOString(), expires: new Date(now.getTime() + 90 * DAY).toISOString(), channels: p.doc.channels, blocked: ['0.0.9'] });
    expect(r.manifest.releases).toEqual(p.doc.releases);
    expect(JSON.parse(r.bytes.toString('utf8'))).toEqual(r.manifest);
    // a trust epoch may be raised by the owner, never lowered
    expect(prepareResign({ bytes: p.bytes, sig: p.sig, zip: p.zip, now, keys, epoch: 2 }).manifest.epoch).toBe(2);
    const e2 = prepareResign({ bytes: p.bytes, sig: p.sig, zip: p.zip, now, keys, epoch: 2 });
    const p2 = { bytes: e2.bytes, sig: signComponentBytes(e2.bytes, KEY.pem, 'test-comp'), zip: p.zip };
    expect(() => prepareResign({ ...p2, now: at(60), keys, epoch: 1 })).toThrow(/lower than/);
  });

  it('works on an already expired manifest', () => {
    const p = published();
    expect(prepareResign({ bytes: p.bytes, sig: p.sig, zip: p.zip, now: at(120), keys }).manifest.manifestVersion).toBe(8);
  });

  it('refuses a bundle that is not exactly what the manifest says, a blocked stable version, and a manifest it cannot verify', () => {
    const p = published();
    const tampered = Buffer.from(p.zip); tampered[tampered.length - 30]! ^= 1;
    expect(() => prepareResign({ bytes: p.bytes, sig: p.sig, zip: tampered, now: at(50), keys })).toThrow(/does not match the manifest/);
    expect(() => prepareResign({ bytes: p.bytes, sig: p.sig, zip: Buffer.concat([p.zip, Buffer.from('x')]), now: at(50), keys })).toThrow(/does not match the manifest/);
    const blocked = published({ blocked: ['0.1.1'] });
    expect(() => prepareResign({ bytes: blocked.bytes, sig: blocked.sig, zip: blocked.zip, now: at(50), keys })).toThrow(/blocked/);
    const wrong = published({ signer: OTHER });
    expect(() => prepareResign({ bytes: wrong.bytes, sig: wrong.sig, zip: wrong.zip, now: at(50), keys })).toThrow(/refusing to renew/);
    // a bundle whose VERSION disagrees (re-signing must not paper over that), made consistent with its hash
    const odd = bundle('0.1.1', { VERSION: '9.9.9\n' });
    const doc = { ...p.doc, releases: { '0.1.1': { ...p.doc.releases['0.1.1'], bundle: { url: 'companion-0.1.1.zip', sha256: createHash('sha256').update(odd).digest('hex'), size: odd.length } } } };
    const bytes = Buffer.from(JSON.stringify(doc)); const sig = signComponentBytes(bytes, KEY.pem, 'test-comp');
    expect(() => prepareResign({ bytes, sig, zip: odd, now: at(50), keys })).toThrow(/VERSION/);
  });
});

describe('check: the signed result is verified against the published manifest it renews', () => {
  const renew = (p: ReturnType<typeof published>, now: Date, signer = KEY) => { const r = prepareResign({ bytes: p.bytes, sig: p.sig, zip: p.zip, now, keys }); return { bytes: r.bytes, sig: signComponentBytes(r.bytes, signer.pem, 'test-comp'), manifest: r.manifest }; };

  it('passes for the honest result, and the agent\'s own verifier accepts it as newer than the old one', () => {
    const p = published(); const now = at(50);
    const n = renew(p, now);
    expect(checkResigned({ previous: p.bytes, previousSig: p.sig, bytes: n.bytes, sig: n.sig, now, keys })).toEqual([]);
    // exactly what an installed agent does: highestSeen is the old counter, the new one is accepted, the old one is not newer
    expect(verifyComponentManifest(n.bytes, n.sig, { component: 'companion', keys, now, highestSeen: 7, epoch: 1 })).toMatchObject({ ok: true });
    expect(verifyComponentManifest(p.bytes, p.sig, { component: 'companion', keys, now, highestSeen: 8, epoch: 1 })).toMatchObject({ ok: false, code: 'rollback' });
  });

  it('fails for a changed hash, a changed version, a skipped or repeated counter, a short validity and a wrong signer', () => {
    const p = published(); const now = at(50);
    const base = renew(p, now).manifest;
    const sign = (m: unknown, signer = KEY) => { const bytes = Buffer.from(JSON.stringify(m, null, 2) + '\n'); return { bytes, sig: signComponentBytes(bytes, signer.pem, 'test-comp') }; };
    const check = (m: unknown, opts: { signer?: typeof KEY; now?: Date } = {}) => { const s = sign(m, opts.signer); return checkResigned({ previous: p.bytes, previousSig: p.sig, bytes: s.bytes, sig: s.sig, now: opts.now ?? now, keys }); };
    const swapped = { ...base, releases: { '0.1.1': { ...base.releases['0.1.1'], bundle: { ...base.releases['0.1.1'].bundle, sha256: 'b'.repeat(64) } } } };
    expect(check(swapped).join()).toMatch(/releases changed/);
    const newer = { ...base, channels: { stable: '0.1.2' }, releases: { ...base.releases, '0.1.2': base.releases['0.1.1'] } };
    expect(check(newer).join()).toMatch(/stable channel changed/);
    expect(check({ ...base, blocked: [] }).join()).toMatch(/blocked list changed/);
    expect(check({ ...base, manifestVersion: 9 }).join()).toMatch(/counter is 9, expected 8/);
    expect(check({ ...base, manifestVersion: 7 }).join()).toMatch(/counter is 7, expected 8/);
    expect(check({ ...base, expires: new Date(now.getTime() + 30 * DAY).toISOString() }).join()).toMatch(/fewer than 80 days/);
    expect(check({ ...base, issued: new Date(now.getTime() + DAY).toISOString() }).join()).toMatch(/in the future/);
    expect(check(base, { signer: OTHER }).join()).toMatch(/does not verify/);
    expect(check({ ...base, extra: 1 }).join()).toMatch(/does not verify/);
  });
});

describe('the command line', () => {
  const run = (args: string[]) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', script, ...args], { encoding: 'utf8' });
  it('refuses a manifest signed by anything but the pinned production key, and says how to use it', () => {
    const d = mk(); const p = published();
    writeFileSync(join(d, 'm.json'), p.bytes); writeFileSync(join(d, 'm.json.sig'), p.sig); writeFileSync(join(d, 'z.zip'), p.zip);
    const plan = run(['plan', '--manifest', join(d, 'm.json'), '--sig', join(d, 'm.json.sig')]);
    expect(plan.status).toBe(1); expect(plan.stderr).toMatch(/does not verify against the pinned component keys/);
    const prep = run(['prepare', '--manifest', join(d, 'm.json'), '--sig', join(d, 'm.json.sig'), '--zip', join(d, 'z.zip'), '--out', join(d, 'out')]);
    expect(prep.status).toBe(1);
    expect(() => readFileSync(join(d, 'out', 'manifest.json'))).toThrow();
    expect(run([]).status).toBe(2);
    expect(run(['plan']).status).toBe(2);
  });
});

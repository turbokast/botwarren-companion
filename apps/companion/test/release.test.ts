/**
 * The release chain's own tooling, with a DEV key and nothing mocked: build the component, finalise its manifest (counter, epoch, blocked list), sign it,
 * verify it the way the ship agent does; package the relay image inputs around a signed client. Production signing (Cloud KMS) happens in the gated
 * release workflow and is not exercised here.
 */
import { createHash, generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { readTarGz, readZip } from '../vendor/agent/src/update/archive.ts';
import { verifyComponentManifest } from '../vendor/agent/src/component/verify.ts';
// @ts-expect-error plain JS modules without types
import { buildClient, releaseKeys, signClient } from '../client/scripts/lib.mjs';
// @ts-expect-error plain JS modules without types
import { assembleComponentManifest } from '../scripts/assemble-component-manifest.mjs';
// @ts-expect-error plain JS modules without types
import { makeRelayContext } from '../scripts/make-relay-context.mjs';
// @ts-expect-error plain JS modules without types
import { stageRelease } from '../scripts/stage-release.mjs';
// @ts-expect-error plain JS modules without types
import { verifyReleaseDir } from '../scripts/lib/release-verify.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const buildScript = join(root, 'scripts', 'build-component.mjs');
const signScript = fileURLToPath(new URL('../vendor/agent/scripts/component-sign.mjs', import.meta.url));
const tmp: string[] = [];
const mk = () => { const d = mkdtempSync(join(tmpdir(), 'bw-comp-release-')); tmp.push(d); return d; };
afterAll(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });

const devKey = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { pem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), spki: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
};
const nodeArgs = ['--disable-warning=ExperimentalWarning'];
const NOW = new Date('2026-11-01T12:00:00Z');

function build(): string {
  const out = join(mk(), 'component');
  const r = spawnSync(process.execPath, [...nodeArgs, buildScript, '--out', out], { encoding: 'utf8', env: { ...process.env, SOURCE_DATE_EPOCH: '1793534400', GIT_COMMIT: 'abcdef0123456789abcdef0123456789abcdef01' } });
  expect(r.status, r.stderr).toBe(0);
  return out;
}
function sign(file: string, k: { pem: string }, id: string): string {
  const dir = mk(); const pem = join(dir, 'k.pem'); writeFileSync(pem, k.pem); chmodSync(pem, 0o600);
  const r = spawnSync(process.execPath, [...nodeArgs, signScript, '--key', pem, '--key-id', id, file], { encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  return readFileSync(`${file}.sig`, 'utf8');
}

describe('component release tooling', () => {
  it('the bundle holds exactly companion.mjs, VERSION, LICENSE and NOTICE, and is reproducible', () => {
    const a = build(); const b = build();
    const zip = (d: string) => readFileSync(join(d, 'companion-0.1.1.zip'));
    expect(zip(a).equals(zip(b))).toBe(true);
    expect(readZip(zip(a)).map((e) => e.name).sort()).toEqual(['LICENSE', 'NOTICE', 'VERSION', 'companion.mjs']);
    expect(readFileSync(join(a, 'manifest.json')).equals(readFileSync(join(b, 'manifest.json')))).toBe(true);
  }, 60_000);

  it('assembles the manifest from the build output (counter, epoch, validity), signs it and verifies it like the agent', () => {
    const dir = build(); const k = devKey(); const pinned = [{ id: 'dev-rel', spki: k.spki, dev: true, role: 'component' as const }];
    const first = assembleComponentManifest({ dir, epoch: 1, validDays: 90, now: NOW });
    expect(first.manifest).toMatchObject({ manifestVersion: 1, epoch: 1, issued: NOW.toISOString(), expires: new Date(NOW.getTime() + 90 * 86_400_000).toISOString(), channels: { stable: '0.1.1' }, blocked: [] });
    expect(first.manifest.releases['0.1.1'].minAgent).toBe('0.7.0');
    const out = mk(); const f1 = join(out, 'manifest.json'); writeFileSync(f1, first.bytes);
    const sig1 = sign(f1, k, 'dev-rel');
    expect(verifyComponentManifest(first.bytes, sig1, { component: 'companion', keys: pinned, now: NOW, allowDev: true, highestSeen: 0, epoch: 1 })).toMatchObject({ ok: true });

    // the next release: counter + 1, the previous manifest's blocked versions stay blocked, the epoch is the one given
    const prevTemplate = JSON.parse(first.bytes.toString('utf8')); prevTemplate.blocked = ['0.0.9'];
    const prevBytes = Buffer.from(JSON.stringify(prevTemplate, null, 2) + '\n'); const f2 = join(out, 'prev.json'); writeFileSync(f2, prevBytes);
    const sig2 = sign(f2, k, 'dev-rel');
    const second = assembleComponentManifest({ dir, previous: { bytes: prevBytes, sig: sig2 }, epoch: 1, block: ['0.0.8'], now: new Date(NOW.getTime() + 86_400_000), keys: pinned, allowDev: true });
    expect(second.manifest).toMatchObject({ manifestVersion: 2, blocked: ['0.0.8', '0.0.9'] });
    expect(() => assembleComponentManifest({ dir, block: ['0.1.1'], now: NOW })).toThrow(/stable version/);
    expect(second.previousVersion).toBe(1);
  }, 60_000);

  it('refuses a previous manifest that does not verify, a lower epoch, and a build output that was changed after the template was written', () => {
    const dir = build(); const k = devKey(); const pinned = [{ id: 'dev-rel', spki: k.spki, dev: true, role: 'component' as const }];
    const tpl = assembleComponentManifest({ dir, now: NOW });
    const out = mk(); const f = join(out, 'prev.json'); writeFileSync(f, tpl.bytes);
    const sig = sign(f, k, 'dev-rel');
    const tampered = Buffer.from(tpl.bytes.toString('utf8').replace('"manifestVersion": 1', '"manifestVersion": 900'));
    expect(() => assembleComponentManifest({ dir, previous: { bytes: tampered, sig }, now: NOW, keys: pinned, allowDev: true })).toThrow(/does not verify/);
    // a dev-signed previous manifest is refused unless dev keys are allowed (production keys only)
    expect(() => assembleComponentManifest({ dir, previous: { bytes: tpl.bytes, sig }, now: NOW, keys: pinned })).toThrow(/does not verify/);
    // a lower epoch than the previous manifest's is a mistake, not a rollback we sign
    const e3 = JSON.parse(tpl.bytes.toString('utf8')); e3.epoch = 3; const e3b = Buffer.from(JSON.stringify(e3, null, 2) + '\n'); const f3 = join(out, 'e3.json'); writeFileSync(f3, e3b);
    const sig3 = sign(f3, k, 'dev-rel');
    expect(() => assembleComponentManifest({ dir, previous: { bytes: e3b, sig: sig3 }, epoch: 2, now: NOW, keys: pinned, allowDev: true })).toThrow(/lower than/);
    // the zip no longer matches the template
    const z = join(dir, 'companion-0.1.1.zip'); const zb = readFileSync(z); zb[zb.length - 30] = zb[zb.length - 30]! ^ 1; writeFileSync(z, zb);
    expect(() => assembleComponentManifest({ dir, now: NOW })).toThrow(/does not match/);
  }, 60_000);
});

const fakeRoot = (): string => {
  const r = mk();
  const put = (rel: string, text: string) => { mkdirSync(dirname(join(r, rel)), { recursive: true }); writeFileSync(join(r, rel), text); };
  put('package.json', '{"name":"x","private":true}\n'); put('pnpm-lock.yaml', 'lockfileVersion: 9\n'); put('pnpm-workspace.yaml', 'packages:\n  - apps/*\n'); put('tsconfig.base.json', '{}\n');
  put('deploy/Dockerfile.relay', 'FROM scratch\n');
  put('apps/relay/package.json', '{"name":"@botwarren/relay"}\n'); put('apps/relay/tsconfig.json', '{}\n'); put('apps/relay/src/main.ts', 'export {};\n'); put('apps/relay/test/x.test.ts', 'export {};\n');
  put('apps/companion/package.json', '{"name":"@botwarren/companion"}\n'); put('apps/companion/src/protocol/index.ts', 'export {};\n'); put('apps/companion/src/cli.ts', 'export {};\n');
  return r;
};
const builtClient = async (k: { spki: string }) => {
  const out = join(mk(), 'client'); const keys = [{ id: 'dev-rel', spki: k.spki }];
  await buildClient({ outDir: out, keys, version: '0.1.1', now: NOW.getTime() });
  return { out, keys };
};

describe('relay image inputs', () => {
  it('packages the SIGNED client with the relay sources only, deterministically; an unsigned or tampered client is refused', async () => {
    const k = devKey(); const { out, keys } = await builtClient(k); const rootDir = fakeRoot();
    await expect(makeRelayContext({ root: rootDir, clientDir: out, keys })).rejects.toThrow(/SIGNED client/);
    signClient({ outDir: out, privateKeyPem: k.pem, keyId: 'dev-rel', keys });
    const a = await makeRelayContext({ root: rootDir, clientDir: out, keys }); const b = await makeRelayContext({ root: rootDir, clientDir: out, keys });
    expect(a.bytes.equals(b.bytes)).toBe(true);
    const names = readTarGz(a.bytes).map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(['Dockerfile.relay', 'CONTEXT.json', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'apps/relay/src/main.ts', 'apps/companion/src/protocol/index.ts', 'client/manifest.json', 'client/manifest.json.sig', 'client/loader.js', 'client/index.html']));
    // nothing else of the repository: not the tests, not the daemon, not the CLI
    expect(names.filter((n) => /test|cli\.ts/.test(n))).toEqual([]);
    const ctx = JSON.parse(readTarGz(a.bytes).find((e) => e.name === 'CONTEXT.json')!.data.toString('utf8'));
    expect(ctx).toMatchObject({ kind: 'botwarren-relay-context', version: '0.1.1' });
    // a key that is not the signer: refused
    const other = devKey();
    await expect(makeRelayContext({ root: rootDir, clientDir: out, keys: [{ id: 'dev-rel', spki: other.spki }] })).rejects.toThrow(/does not verify/);
    // a changed file after signing: refused
    const js = readFileSync(join(out, 'loader.js')); writeFileSync(join(out, 'loader.js'), Buffer.concat([js, Buffer.from('\n//x')]));
    await expect(makeRelayContext({ root: rootDir, clientDir: out, keys })).rejects.toThrow(/does not match the signed manifest/);
  }, 60_000);
});

describe('staging and verifying a whole release (dev key)', () => {
  const stage = async () => {
    const k = devKey();
    const { out: client, keys } = await builtClient(k);
    signClient({ outDir: client, privateKeyPem: k.pem, keyId: 'dev-rel', keys });
    const comp = build();
    const a = assembleComponentManifest({ dir: comp, now: NOW });
    const work = mk(); const manifest = join(work, 'manifest.json'); writeFileSync(manifest, a.bytes);
    sign(manifest, k, 'dev-rel');
    const out = join(mk(), 'release');
    // the component zip was built for the same version the client manifest names (0.1.1)
    const r = await stageRelease({ clientDir: client, componentZip: join(comp, 'companion-0.1.1.zip'), componentManifest: manifest, out, allowDev: true, root: fakeRoot(), keys });
    return { r, out, keys };
  };

  it('stages every file, lists it in SHA256SUMS and verifies as a downloader would', async () => {
    const { r, out, keys } = await stage();
    expect(r.version).toBe('0.1.1');
    const v = await verifyReleaseDir({ dir: out, allowDev: true, keys });
    expect(v).toEqual({ ok: true, problems: [], version: '0.1.1' });
    expect(readFileSync(join(out, 'SHA256SUMS'), 'utf8').trim().split('\n').map((l) => l.split('  ')[1])).toEqual(['client-0.1.1.tar.gz', 'client-manifest.json', 'client-manifest.json.sig', 'companion-0.1.1.zip', 'component-manifest.json', 'component-manifest.json.sig', 'install.ps1', 'install.sh', 'relay-context-0.1.1.tar.gz']);
  }, 120_000);

  it('stages the manual installers and refuses a release whose installers do not embed the pinned production key', async () => {
    const { out, keys } = await stage();
    expect(readFileSync(join(out, 'install.sh'), 'utf8')).toBe(readFileSync(join(root, 'install', 'install.sh'), 'utf8'));
    const resum = (): void => {
      const sums = readdirSync(out).filter((f) => f !== 'SHA256SUMS').sort().map((f) => `${createHash('sha256').update(readFileSync(join(out, f))).digest('hex')}  ${f}`).join('\n') + '\n';
      writeFileSync(join(out, 'SHA256SUMS'), sums);
    };
    const prod = (await releaseKeys({ allowDev: false })).map((k: { id: string; spki: string }) => k);
    expect(prod.length).toBeGreaterThan(0);
    // an installer that trusts a different key (hashes updated, so only the installer check can catch it)
    const sh = readFileSync(join(out, 'install.sh'), 'utf8');
    writeFileSync(join(out, 'install.sh'), sh.replace(prod[0].spki, devKey().spki)); resum();
    expect((await verifyReleaseDir({ dir: out, allowDev: true, keys })).problems.join()).toMatch(/install\.sh does not embed the pinned component key/);
    writeFileSync(join(out, 'install.sh'), sh); resum();
    expect((await verifyReleaseDir({ dir: out, allowDev: true, keys })).ok).toBe(true);
    // a missing installer is an unexpected file list
    rmSync(join(out, 'install.ps1')); resum();
    expect((await verifyReleaseDir({ dir: out, allowDev: true, keys })).problems.join()).toMatch(/unexpected release files/);
  }, 120_000);

  it('rejects a release with a changed file, a wrong key, an extra file or a dev signature under production keys', async () => {
    const { out, keys } = await stage();
    const clean = readFileSync(join(out, 'companion-0.1.1.zip'));
    // wrong key: neither signature verifies
    const other = devKey();
    expect((await verifyReleaseDir({ dir: out, allowDev: true, keys: [{ id: 'dev-rel', spki: other.spki }] })).problems.join()).toMatch(/does not verify/);
    // an extra file is not silently ignored
    writeFileSync(join(out, 'extra.txt'), 'x');
    expect((await verifyReleaseDir({ dir: out, allowDev: true, keys })).problems.join()).toMatch(/SHA256SUMS lists/);
    rmSync(join(out, 'extra.txt'));
    // a changed byte in the zip: the hash list no longer matches
    const bad = Buffer.from(clean); bad[bad.length - 30] = bad[bad.length - 30]! ^ 1; writeFileSync(join(out, 'companion-0.1.1.zip'), bad);
    expect((await verifyReleaseDir({ dir: out, allowDev: true, keys })).problems.join()).toMatch(/companion-0\.1\.1\.zip: hash does not match/);
    // production keys only (the pinned set, no dev key): the dev-signed release is refused
    writeFileSync(join(out, 'companion-0.1.1.zip'), clean);
    expect((await verifyReleaseDir({ dir: out })).ok).toBe(false);
  }, 120_000);
});

describe('the Companion pins the COMPONENT signing key, never the ship agent\'s update key', () => {
  it('the pinned set for the client loader, the manifest assembly and the release verification has only component keys', async () => {
    // @ts-expect-error plain JS module without types
    const { releaseKeys } = await import('../client/scripts/lib.mjs');
    expect((await releaseKeys({})).map((k: { id: string }) => k.id)).toEqual(['kms-comp-2026a']);
    expect((await releaseKeys({ allowDev: true })).map((k: { id: string }) => k.id).sort()).toEqual(['dev-comp-1', 'kms-comp-2026a']);
    for (const k of await releaseKeys({ allowDev: true })) expect(['kms-2026a', 'dev-1', 'recovery-1', 'recovery-2', 'recovery-3']).not.toContain(k.id);
  });

  it('client/scripts/sign.mjs refuses the agent-update key id and, until the real public key is pasted, the placeholder component key', () => {
    const sign = fileURLToPath(new URL('../client/scripts/sign.mjs', import.meta.url));
    const KMS = 'projects/botwarren-release/locations/europe-west2/keyRings/botwarren-release/cryptoKeys/component-signing/cryptoKeyVersions/1';
    const run = (id: string) => spawnSync(process.execPath, [...nodeArgs, sign, '--kms', KMS, '--key-id', id, '--dir', mk()], { encoding: 'utf8', env: { ...process.env, GOOGLE_OAUTH_ACCESS_TOKEN: 'x'.repeat(40), BOTWARREN_KMS_ENDPOINT: 'http://127.0.0.1:1' } });
    for (const id of ['kms-2026a', 'dev-1', 'recovery-1']) { const r = run(id); expect(r.status, id).toBe(2); expect(r.stderr).toMatch(/not a pinned, non-dev COMPONENT key/); }
    const r = run('kms-comp-2026a');
    // while the public key is a placeholder it must refuse before reaching the network; once the real key is pinned it gets as far as the (unreachable) test endpoint
    expect(r.stderr).toMatch(/PLACEHOLDER|manifest|ENOENT|fetch|KMS/i);
    expect(r.status).not.toBe(0);
  });
});

describe('release notes from the CHANGELOG', () => {
  const log = '# Changelog\n\n## [Unreleased]\n\n## [0.2.0] - 2026-12-01\n\n### Added\n\n- a thing\n\n## [0.1.0]\n\n- undated\n\n## [0.0.1] - 2026-10-15\n\n### Added\n\n';
  it('takes the dated section of the version and fails closed on a missing, undated or empty one', async () => {
    // @ts-expect-error plain JS module without types
    const { extractNotes } = await import('../scripts/changelog-notes.mjs');
    expect(extractNotes(log, '0.2.0')).toMatchObject({ date: '2026-12-01' });
    expect(extractNotes(log, '0.2.0').body).toContain('- a thing');
    expect(() => extractNotes(log, '0.3.0')).toThrow(/no section/);
    expect(() => extractNotes(log, '0.1.0')).toThrow(/no release date/);
    expect(() => extractNotes(log, '0.0.1')).toThrow(/is empty/);
  });
});

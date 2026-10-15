/**
 * The manual install path (apps/companion/install: install.sh, install.ps1, installer.mjs) for a computer without a ship agent. It must be just as safe as
 * the agent's install gate: nothing is installed or run unless the manifest signature (pinned component key, own signature domain), the bundle's size and
 * SHA-256 and the archive contents all check out. Everything here runs against signed fixtures with a throw-away key; the real component key never signs
 * anything in a test (and its private half is not in the repository).
 */
import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { writeZip } from '../vendor/agent/src/update/archive.ts';
import { COMPONENT_PUBLIC_KEYS } from '../vendor/agent/src/update/keys.ts';
import { signManifestBytes } from '../vendor/agent/src/update/verify.ts';
import { signComponentBytes, verifyComponentManifest } from '../vendor/agent/src/component/verify.ts';
// @ts-expect-error plain JS modules without types
import { PINNED_KEYS, Refused, defaultPaths, install, parseArgs, readBundle, serviceText, servicePaths, shimText, uninstall, verifyManifest, SHIM_MARKER } from '../install/installer.mjs';
// @ts-expect-error plain JS modules without types
import { buildInstallers, checkPinnedKeys } from '../scripts/build-installers.mjs';

const root = join(import.meta.dirname, '..');
const NOW = new Date('2026-10-20T12:00:00.000Z');
const tmp: string[] = [];
const mk = (): string => { const d = mkdtempSync(join(tmpdir(), 'bw-comp-inst-')); tmp.push(d); return d; };
afterAll(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });

// ---------------------------------------------------------------- fixtures: a throw-away component key and signed releases
const keyPair = (): { pem: string; spki: string; priv: KeyObject } => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { pem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), spki: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), priv: privateKey };
};
const KEY = keyPair(); const OTHER = keyPair();
const WIN = process.platform === 'win32';
/** the command name the installer writes on this platform */
const SHIM = WIN ? 'botwarren-companion.cmd' : 'botwarren-companion';
const pinned = [{ id: 'test-comp', spki: KEY.spki, dev: false }];

const companionSource = (version: string): string => `if (process.argv[2] === 'version') process.stdout.write('${version}\\n'); else { process.stdout.write('ran ' + process.argv.slice(2).join(' ') + '\\n'); }\n`;
const bundleOf = (version: string, extra: Record<string, string> = {}, drop: string[] = []): Buffer => {
  const files: Record<string, string> = { 'companion.mjs': companionSource(version), VERSION: `${version}\n`, LICENSE: 'Apache-2.0\n', NOTICE: 'notice\n', ...extra };
  for (const d of drop) delete files[d];
  return writeZip(Object.entries(files).map(([name, data]) => ({ name, data: Buffer.from(data), mode: 0o644 })));
};
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/** the zip writer refuses unsafe names, so an attacker's archive is made by patching the name bytes (same length) in both headers */
const renamed = (zip: Buffer, from: string, to: string): Buffer => { const b = Buffer.from(zip); let i = b.indexOf(from); while (i >= 0) { b.write(to, i); i = b.indexOf(from, i + 1); } return b; };

interface Fx { version?: string; manifestVersion?: number; expires?: string; epoch?: number; blocked?: string[]; component?: string; bundle?: Buffer; manifest?: Record<string, unknown>; release?: Record<string, unknown>; signer?: { pem: string }; keyId?: string; domain?: 'component' | 'agent'; serve?: (zip: Buffer) => Buffer }
function fixture(o: Fx = {}): Map<string, Buffer> {
  const version = o.version ?? '0.1.1';
  const bundle = o.bundle ?? bundleOf(version);
  const doc = {
    schema: 1, kind: 'botwarren-component', component: o.component ?? 'companion', epoch: o.epoch ?? 1, manifestVersion: o.manifestVersion ?? 5,
    issued: '2026-10-19T00:00:00.000Z', expires: o.expires ?? '2027-01-17T00:00:00.000Z', channels: { stable: version }, blocked: o.blocked ?? [],
    releases: { [version]: { protocol: { min: 1, max: 1 }, bundle: { url: `companion-${version}.zip`, sha256: sha(bundle), size: bundle.length }, minAgent: '0.7.0', minRuntime: '22.13.0', ...o.release } },
    ...o.manifest,
  };
  const bytes = Buffer.from(JSON.stringify(doc, null, 2) + '\n');
  const sign = o.domain === 'agent' ? signManifestBytes : signComponentBytes;
  const sig = sign(bytes, (o.signer ?? KEY).pem, o.keyId ?? 'test-comp');
  return new Map<string, Buffer>([['manifest.json', bytes], ['manifest.json.sig', Buffer.from(sig)], [`companion-${version}.zip`, o.serve ? o.serve(bundle) : bundle]]);
}

const fakeFetch = (files: Map<string, Buffer>, seen: string[] = []): typeof fetch => (async (url: string | URL | Request) => {
  const u = String(url); seen.push(u);
  const name = u.split('/companion/')[1] ?? '';
  const body = files.get(name);
  return body ? new Response(new Uint8Array(body), { status: 200 }) : new Response('not found', { status: 404 });
}) as typeof fetch;

interface World { dir: string; bin: string; logs: string[]; seen: string[]; selftests: number; opts: Record<string, unknown> }
function world(files: Map<string, Buffer>, extra: Record<string, unknown> = {}): World {
  const home = mk();
  const w: World = { dir: join(home, 'app'), bin: join(home, 'bin'), logs: [], seen: [], selftests: 0, opts: {} };
  w.opts = { dir: w.dir, bin: w.bin, os: process.platform, base: 'https://downloads.test', fetchImpl: fakeFetch(files, w.seen), keys: pinned, now: () => NOW, log: (m: string) => w.logs.push(m), home, env: { PATH: process.env.PATH, HOME: home }, ...extra };
  return w;
}
const nothingInstalled = (w: World): void => {
  expect(existsSync(w.dir) ? readdirSync(w.dir).filter((n) => n !== 'staging') : []).toEqual([]);
  expect(existsSync(w.bin) ? readdirSync(w.bin) : []).toEqual([]);
};
const refused = async (w: World): Promise<string> => { try { await install(w.opts); } catch (e) { if (e instanceof Refused) return (e as Error).message; throw e; } throw new Error('expected a refusal'); };

// ---------------------------------------------------------------- the happy path
describe('manual install: the happy path', () => {
  it('verifies, extracts only the allowlisted files, self-tests last, records state and adds a working botwarren-companion command', async () => {
    const w = world(fixture());
    const r = await install(w.opts);
    expect(r).toMatchObject({ status: 'installed', version: '0.1.1', shim: 'written' });
    const v = join(w.dir, 'versions', '0.1.1');
    expect(readdirSync(v).sort()).toEqual(['LICENSE', 'NOTICE', 'VERSION', 'companion.mjs']);
    expect(JSON.parse(readFileSync(join(w.dir, 'state.json'), 'utf8'))).toEqual({ highestManifestVersion: 5, epoch: 1 });
    expect(JSON.parse(readFileSync(join(w.dir, 'install.json'), 'utf8'))).toMatchObject({ how: 'manual', version: '0.1.1', keyId: 'test-comp', manifestVersion: 5 });
    expect(readdirSync(w.dir).sort()).toEqual(['install.json', 'state.json', 'versions']); // the staging directory is gone
    expect(w.logs.join('\n')).toMatch(/signature OK \(key test-comp\)/);
    if (process.platform !== 'win32') {
      const shim = join(w.bin, SHIM);
      expect(readFileSync(shim, 'utf8')).toContain(SHIM_MARKER);
      const out = spawnSync(shim, ['version'], { encoding: 'utf8' });
      expect(out.stdout.trim()).toBe('0.1.1');
      expect(spawnSync(shim, ['pair', 'two words'], { encoding: 'utf8' }).stdout.trim()).toBe('ran pair two words');
    }
    // again: same version, same state
    expect(await install(w.opts)).toMatchObject({ status: 'reinstalled', version: '0.1.1' });
  });

  it('an upgrade keeps the previous version directory (hooks may point at it) and moves the counter forward', async () => {
    const w = world(fixture({ version: '0.1.0', manifestVersion: 3 }));
    await install(w.opts);
    const w2 = { ...w, opts: { ...w.opts, fetchImpl: fakeFetch(fixture({ version: '0.1.1', manifestVersion: 4 })) } };
    expect(await install(w2.opts)).toMatchObject({ status: 'installed', version: '0.1.1' });
    expect(readdirSync(join(w.dir, 'versions')).sort()).toEqual(['0.1.0', '0.1.1']);
    expect(JSON.parse(readFileSync(join(w.dir, 'state.json'), 'utf8')).highestManifestVersion).toBe(4);
    expect(w.logs.join('\n')).toContain('claude install-hooks');
  });

  it('--dry-run verifies everything and writes nothing', async () => {
    const w = world(fixture(), { dryRun: true });
    expect(await install(w.opts)).toMatchObject({ status: 'dry_run', version: '0.1.1' });
    expect(existsSync(w.dir)).toBe(false); expect(existsSync(w.bin)).toBe(false);
  });
});

// ---------------------------------------------------------------- nothing is installed or run unless every check passes
describe('manual install: refusals leave nothing behind and run nothing', () => {
  const selftestSpy = (w: World) => { w.opts.selftest = () => { w.selftests++; return true; }; };
  const cases: [string, Fx, RegExp][] = [
    ['a manifest signed by another key id', { keyId: 'someone-else' }, /manifest_refused: unknown_key/],
    ['a manifest signed by a key with the right id but other key material', { signer: OTHER }, /manifest_refused: bad_signature/],
    ['an agent-update signature (the other signature domain) on a component manifest', { domain: 'agent' }, /manifest_refused: bad_signature/],
    ['an expired manifest', { expires: '2026-10-01T00:00:00.000Z' }, /manifest_refused: expired/],
    ['a manifest for another component', { component: 'other' }, /manifest_refused: malformed/],
    ['unknown fields in the manifest', { manifest: { extra: 1 } }, /manifest_refused: malformed/],
    ['a bundle url that is not a plain file name', { release: { bundle: { url: 'https://evil.example/x.zip', sha256: 'a'.repeat(64), size: 10 } } }, /manifest_refused: malformed/],
    ['a blocked version', { blocked: ['0.1.1'] }, /version_not_installable/],
    ['a protocol range that does not include 1', { release: { protocol: { min: 2, max: 2 } } }, /version_not_installable/],
    ['a runtime that is too old', { release: { minRuntime: '99.0.0' } }, /runtime_too_old/],
    ['a bundle with the right size but other bytes (hash)', { serve: (z) => { const b = Buffer.from(z); b[b.length - 30]! ^= 1; return b; } }, /hash_mismatch/],
    ['a bundle with another size', { serve: (z) => Buffer.concat([z, Buffer.from('x')]) }, /size_mismatch/],
    ['an extra file in the archive', { bundle: bundleOf('0.1.1', { 'evil.sh': 'rm -rf ~' }, ['NOTICE']) }, /bad_bundle: file not allowed/],
    ['a path-traversal name in the archive', { bundle: renamed(bundleOf('0.1.1', { aaaaaaa: 'x' }, ['NOTICE']), 'aaaaaaa', '../evil') }, /bad_bundle: file not allowed/],
    ['a missing companion.mjs', { bundle: bundleOf('0.1.1', {}, ['companion.mjs']) }, /bad_bundle/],
    ['a VERSION that is not the signed version', { bundle: bundleOf('0.1.1', { VERSION: '9.9.9\n' }) }, /bad_bundle: VERSION/],
  ];
  for (const [name, fx, re] of cases) {
    it(name, async () => {
      const w = world(fixture(fx)); selftestSpy(w);
      expect(await refused(w)).toMatch(re);
      expect(w.selftests).toBe(0);
      nothingInstalled(w);
    });
  }

  it('a manifest older than one already accepted is a rollback; a huge jump is refused too', async () => {
    const w = world(fixture({ manifestVersion: 4 })); selftestSpy(w);
    mkdirSync(w.dir, { recursive: true }); writeFileSync(join(w.dir, 'state.json'), JSON.stringify({ highestManifestVersion: 9, epoch: 1 }));
    expect(await refused(w)).toMatch(/rollback/);
    const w2 = world(fixture({ manifestVersion: 5000 })); selftestSpy(w2);
    mkdirSync(w2.dir, { recursive: true }); writeFileSync(join(w2.dir, 'state.json'), JSON.stringify({ highestManifestVersion: 9, epoch: 1 }));
    expect(await refused(w2)).toMatch(/version_jump/);
    expect(w.selftests + w2.selftests).toBe(0);
  });

  it('a lower trust epoch than one accepted before is refused', async () => {
    const w = world(fixture({ epoch: 1 }));
    mkdirSync(w.dir, { recursive: true }); writeFileSync(join(w.dir, 'state.json'), JSON.stringify({ highestManifestVersion: 1, epoch: 2 }));
    expect(await refused(w)).toMatch(/epoch_rollback/);
  });

  it('a self-test that fails removes the version and records nothing', async () => {
    const w = world(fixture({ bundle: bundleOf('0.1.1', { 'companion.mjs': 'process.exit(3)\n' }) }));
    expect(await refused(w)).toMatch(/selftest_failed/);
    expect(existsSync(join(w.dir, 'versions', '0.1.1'))).toBe(false);
    expect(existsSync(join(w.dir, 'state.json'))).toBe(false);
    expect(existsSync(join(w.dir, 'install.json'))).toBe(false);
    nothingInstalled({ ...w, dir: join(w.dir, 'x') });
  });

  it('the signature is checked before the manifest is even parsed, and a development key never verifies anything from a real host', async () => {
    // the real pinned dev key id is refused unless a test allows it, and only for an address on this computer
    const dev = [{ id: 'dev-comp-1', spki: KEY.spki, dev: true }];
    const f = fixture({ keyId: 'dev-comp-1' });
    const w = world(f, { keys: dev });
    expect(await refused(w)).toMatch(/dev_key_refused/);
    const w2 = world(f, { keys: dev, allowDev: true });
    expect(await refused(w2)).toMatch(/dev_key_refused: a development key is only ever accepted for a download address on this computer/);
    expect(w2.seen).toEqual([]); // refused before a single download
    const w3 = world(f, { keys: dev, allowDev: true, base: 'http://127.0.0.1:9' });
    expect(await install(w3.opts)).toMatchObject({ status: 'installed' });
  });

  it('refuses plain http to a real host, and a failed or oversized download', async () => {
    expect(await refused(world(fixture(), { base: 'http://downloads.botwarren.com' }))).toMatch(/insecure_url/);
    expect(await refused(world(fixture(), { base: 'https://downloads.test/\nx' }))).toMatch(/insecure_url/);
    expect(await refused(world(new Map()))).toMatch(/download_failed/);
    const big = fixture(); big.set('manifest.json', Buffer.alloc(300 * 1024, 32));
    expect(await refused(world(big))).toMatch(/too_large/);
  });
});

// ---------------------------------------------------------------- the same verdicts as the ship agent's installer
describe('manual install: the same verdicts as the ship agent\'s component verifier', () => {
  const cases: [string, Fx, { highestSeen?: number; now?: Date }][] = [
    ['valid', {}, {}], ['wrong key id', { keyId: 'nope' }, {}], ['other key material', { signer: OTHER }, {}], ['agent domain', { domain: 'agent' }, {}],
    ['expired', { expires: '2026-10-01T00:00:00.000Z' }, {}], ['wrong component', { component: 'x' }, {}], ['unknown field', { manifest: { extra: 1 } }, {}],
    ['rollback', {}, { highestSeen: 99 }], ['jump', { manifestVersion: 3000 }, { highestSeen: 10 }], ['same counter again', { manifestVersion: 10 }, { highestSeen: 10 }],
  ];
  for (const [name, fx, o] of cases) {
    it(name, () => {
      const f = fixture(fx); const bytes = f.get('manifest.json')!; const sig = f.get('manifest.json.sig')!.toString('utf8');
      const mine = verifyManifest(bytes, sig, { keys: pinned, now: NOW, highestSeen: o.highestSeen ?? 0, epochFloor: 1 });
      const agent = verifyComponentManifest(bytes, sig, { component: 'companion', keys: [{ id: 'test-comp', spki: KEY.spki, role: 'component', dev: false }], now: NOW, highestSeen: o.highestSeen ?? 0, epoch: 1 });
      expect(mine.ok).toBe(agent.ok);
      if (!mine.ok && !agent.ok) expect(mine.code).toBe(agent.code);
    });
  }
  it('a tampered signature file and a truncated one', () => {
    const f = fixture(); const bytes = f.get('manifest.json')!;
    for (const sig of ['', '{}', 'not json', JSON.stringify({ alg: 'rsa', keyId: 'test-comp', sig: 'A'.repeat(86) + '==' })]) {
      const mine = verifyManifest(bytes, sig, { keys: pinned, now: NOW });
      const agent = verifyComponentManifest(bytes, sig, { component: 'companion', keys: [{ id: 'test-comp', spki: KEY.spki, role: 'component', dev: false }], now: NOW, highestSeen: 0, epoch: 1 });
      expect(mine).toEqual({ ok: false, code: 'bad_signature_file' }); expect(agent).toMatchObject({ ok: false, code: 'bad_signature_file' });
    }
  });
});

// ---------------------------------------------------------------- the strict archive reader
describe('manual install: the archive reader', () => {
  it('reads what the release writes and refuses a zip comment, encryption flags and symlink entries', () => {
    const z = bundleOf('0.1.1');
    expect([...readBundle(z, '0.1.1').keys()].sort()).toEqual(['LICENSE', 'NOTICE', 'VERSION', 'companion.mjs']);
    expect(() => readBundle(Buffer.concat([z, Buffer.from('c')]), '0.1.1')).toThrow(/bad_bundle|not a zip/);
    const enc = Buffer.from(z); const cd = enc.readUInt32LE(enc.length - 6); enc.writeUInt16LE(1, cd + 8);
    expect(() => readBundle(enc, '0.1.1')).toThrow(/encrypted/);
    const link = Buffer.from(z); link.writeUInt32LE((0o120777 << 16) >>> 0, cd + 38);
    expect(() => readBundle(link, '0.1.1')).toThrow(/special file/);
    expect(() => readBundle(Buffer.alloc(10), '0.1.1')).toThrow(Refused);
  });
});

// ---------------------------------------------------------------- the command, the service, uninstall
describe('manual install: command, service and uninstall', () => {
  it('never overwrites or removes a botwarren-companion it did not write (a foreign file, or the ship agent\'s launcher)', async () => {
    for (const [content, tag] of [['#!/bin/sh\necho mine\n', 'foreign'], ['#!/bin/sh\n# botwarren-companion shim (ship agent): x\n', 'agent']] as const) {
      const w = world(fixture());
      mkdirSync(w.bin, { recursive: true }); writeFileSync(join(w.bin, SHIM), content);
      const r = await install(w.opts);
      expect(r, tag).toMatchObject({ status: 'installed', shim: 'kept' });
      expect(readFileSync(join(w.bin, SHIM), 'utf8')).toBe(content);
      expect(w.logs.join('\n')).toContain('not changing');
    }
  });

  it('shim text quotes odd paths, and the Windows shim is a .cmd that passes the exit code', () => {
    const sh = shimText(false, "/opt/it's node/node", "/home/a b/.local/share/botwarren-companion/versions/0.1.1/companion.mjs");
    expect(sh).toContain(`exec '/opt/it'\\''s node/node' --disable-warning=ExperimentalWarning '/home/a b/`);
    expect(spawnSync('sh', ['-n'], { input: sh }).status).toBe(0); // parses
    const cmd = shimText(true, 'C:\\Program Files\\nodejs\\node.exe', 'C:\\Users\\a\\AppData\\Local\\Botwarren\\companion\\versions\\0.1.1\\companion.mjs');
    expect(cmd).toContain('"C:\\Program Files\\nodejs\\node.exe" --disable-warning=ExperimentalWarning "C:\\Users\\a');
    expect(cmd).toContain('%*'); expect(cmd).toContain('exit /b %ERRORLEVEL%');
  });

  it('--service writes the per-user service definition and starts it through the service manager (stubbed here)', async () => {
    const w = world(fixture(), { service: true });
    const calls: string[] = [];
    w.opts.runService = (cmd: string, args: string[]) => { calls.push([cmd, ...args].join(' ')); return true; };
    const r = await install(w.opts);
    const sp = servicePaths({ os: process.platform, home: w.opts.home, env: w.opts.env });
    // the Windows Startup-folder launcher runs at the next sign-in, it is not started now
    expect(r.service).toMatchObject({ file: sp.file, started: !WIN });
    expect(existsSync(sp.file)).toBe(true);
    const text = readFileSync(sp.file, 'utf8');
    expect(text).toContain('companion.mjs');
    expect(text).toContain('daemon');
    if (process.platform === 'linux') {
      expect(text).toMatch(/Restart=always/);
      expect(calls).toEqual(['systemctl --user daemon-reload', 'systemctl --user enable --now botwarren-companion.service']);
    }
    // uninstall: the companion's own uninstall first, then the service, the command and the files
    const companionCalls: string[][] = [];
    const u = { dir: w.dir, bin: w.bin, os: process.platform, home: w.opts.home, env: w.opts.env, log: (m: string) => w.logs.push(m), runService: w.opts.runService, runCompanion: (a: string[]) => { companionCalls.push(a); return true; } };
    expect(uninstall(u)).toEqual({ status: 'removed' });
    expect(companionCalls).toEqual([['uninstall', '--purge', '--yes']]);
    expect(existsSync(sp.file)).toBe(false); expect(existsSync(w.dir)).toBe(false); expect(existsSync(join(w.bin, SHIM))).toBe(false);
    expect(uninstall({ ...u })).toEqual({ status: 'none' });
    const keep: string[][] = [];
    const w3 = world(fixture()); await install(w3.opts);
    uninstall({ ...u, dir: w3.dir, bin: w3.bin, keepKeys: true, runCompanion: (a: string[]) => { keep.push(a); return true; } });
    expect(keep).toEqual([['uninstall', '--yes']]);
  });

  it('service definitions per platform', () => {
    const systemd = serviceText('systemd', '/usr/bin/node', '/h/a b/companion.mjs', '/x/log');
    expect(systemd).toContain('ExecStart="/usr/bin/node" --disable-warning=ExperimentalWarning "/h/a b/companion.mjs" daemon');
    expect(systemd).toContain('WantedBy=default.target');
    const launchd = serviceText('launchd', '/usr/local/bin/node', '/Users/a/x&y/companion.mjs', '/x/log');
    expect(launchd).toContain('<string>/Users/a/x&amp;y/companion.mjs</string>');
    expect(launchd).toContain('<key>KeepAlive</key><true/>');
    const vbs = serviceText('startup', 'C:\\n\\node.exe', 'C:\\a\\companion.mjs', 'x');
    expect(vbs).toContain('WScript.Shell'); expect(vbs).toContain('daemon", 0, False');
    expect(servicePaths({ os: 'win32', home: 'C:\\Users\\a', env: { APPDATA: 'C:\\Users\\a\\AppData\\Roaming' } }).file).toContain('Startup');
    expect(servicePaths({ os: 'darwin', home: '/Users/a', env: {} }).file).toBe(join('/Users/a', 'Library', 'LaunchAgents', 'com.botwarren.companion.plist'));
    expect(servicePaths({ os: 'linux', home: '/home/a', env: {} }).file).toBe(join('/home/a', '.config', 'systemd', 'user', 'botwarren-companion.service'));
  });

  it('default locations are per user (Linux and macOS ~/.local, Windows %LOCALAPPDATA%\\Botwarren), and the options are strict', () => {
    expect(defaultPaths({ os: 'linux', home: '/home/a', env: {} })).toMatchObject({ dir: join('/home/a', '.local', 'share', 'botwarren-companion'), bin: join('/home/a', '.local', 'bin') });
    expect(defaultPaths({ os: 'win32', home: 'C:\\Users\\a', env: { LOCALAPPDATA: 'C:\\L' } })).toMatchObject({ dir: join('C:\\L', 'Botwarren', 'companion'), bin: join('C:\\L', 'Botwarren', 'bin') });
    expect(parseArgs(['--service', '--dry-run', '--base-url', 'https://x.test'], {})).toMatchObject({ service: true, dryRun: true, base: 'https://x.test' });
    expect(() => parseArgs(['--nope'], {})).toThrow(/unknown option/);
    expect(() => parseArgs(['--dir'], {})).toThrow(/needs a value/);
    expect(parseArgs([], {}).base).toBe('https://downloads.botwarren.com');
  });
});

// ---------------------------------------------------------------- the scripts themselves
describe('install.sh and install.ps1', () => {
  it('are generated from installer.mjs, and the pinned keys are the ship agent\'s component keys', () => {
    expect(() => checkPinnedKeys()).not.toThrow();
    const { sh, ps1 } = buildInstallers();
    expect(readFileSync(join(root, 'install', 'install.sh'), 'utf8')).toBe(sh);
    expect(readFileSync(join(root, 'install', 'install.ps1'), 'utf8')).toBe(ps1);
    // the production key is the one in the script, the dev key is marked dev, and no private material is anywhere
    const realKey = COMPONENT_PUBLIC_KEYS.find((k) => k.id === 'kms-comp-2026a')!;
    expect(sh).toContain(realKey.spki); expect(ps1).toContain(realKey.spki);
    expect(PINNED_KEYS.filter((k: { dev: boolean }) => !k.dev).map((k: { id: string }) => k.id)).toEqual(['kms-comp-2026a']);
    expect(sh + ps1).not.toMatch(/PRIVATE KEY/);
  });

  it('are a thin wrapper: Node check, a private temp dir, the embedded program, and nothing else that touches the network or the system', () => {
    const sh = readFileSync(join(root, 'install', 'install.sh'), 'utf8');
    const before = sh.slice(0, sh.indexOf("<<'BOTWARREN_INSTALLER_JS'")).split('\n').filter((l) => !l.startsWith('#')).join('\n'); // code, not comments
    const after = sh.slice(sh.lastIndexOf('BOTWARREN_INSTALLER_JS'));
    expect(before).not.toMatch(/curl|wget|sudo|\beval\b|chmod|\bmv\b|\bcp\b/);
    expect(after).toBe('BOTWARREN_INSTALLER_JS\n\nnode --disable-warning=ExperimentalWarning "$TMP/installer.mjs" "$@"\n');
    expect(sh.split("'BOTWARREN_INSTALLER_JS'").length - 1).toBe(1);
    const ps1 = readFileSync(join(root, 'install', 'install.ps1'), 'utf8');
    expect(ps1.match(/^'@/gm)?.length).toBe(1);
    expect(ps1).not.toMatch(/Invoke-WebRequest\s+-|Invoke-Expression|\biex\b/); // the download happens inside the verified program, not in the wrapper
    expect(ps1).toContain("New-Object Text.UTF8Encoding($false)");
  });

  it.skipIf(spawnSync('shellcheck', ['--version']).error !== undefined)('install.sh passes shellcheck', () => {
    const r = spawnSync('shellcheck', [join(root, 'install', 'install.sh')], { encoding: 'utf8' });
    expect(r.stdout + r.stderr).toBe('');
    expect(r.status).toBe(0);
  });
});

// ---------------------------------------------------------------- install.sh end to end against a local, signed release
describe.skipIf(process.platform === 'win32')('install.sh against a locally served, signed release', () => {
  let server: Server | null = null;
  const stop = (): Promise<void> => new Promise((r) => { if (!server) return r(); server.close(() => r()); server.closeAllConnections?.(); server = null; });
  afterEach(stop);

  const serve = async (files: Map<string, Buffer>): Promise<string> => {
    server = createServer((req, res) => {
      const name = String(req.url).split('/companion/')[1] ?? '';
      const body = files.get(name);
      res.statusCode = body ? 200 : 404; res.end(body ?? 'nope');
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  };
  /** the real script with ONLY the dev key's public key swapped for the throw-away test key (the production key is untouched) */
  const testScript = (): string => {
    const dir = mk();
    const dev = PINNED_KEYS.find((k: { dev: boolean }) => k.dev) as { spki: string };
    const text = readFileSync(join(root, 'install', 'install.sh'), 'utf8').replace(dev.spki, KEY.spki);
    expect(text).not.toContain(dev.spki);
    const f = join(dir, 'install.sh'); writeFileSync(f, text); chmodSync(f, 0o755);
    return f;
  };
  const run = (script: string, args: string[], home: string, env: Record<string, string> = {}): Promise<{ code: number | null; out: string; err: string }> => new Promise((resolve) => {
    const p = spawn('sh', [script, ...args], { env: { PATH: process.env.PATH ?? '', HOME: home, TMPDIR: home, BOTWARREN_COMPANION_ALLOW_DEV_KEY: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    p.stdout.on('data', (c: Buffer) => { out += c.toString(); }); p.stderr.on('data', (c: Buffer) => { err += c.toString(); });
    const t = setTimeout(() => p.kill('SIGKILL'), 60_000);
    p.on('exit', (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
  const devFixture = (o: Fx = {}) => fixture({ keyId: 'dev-comp-1', ...o });

  it('installs a verified release per user, adds the command, and --uninstall removes it all again', async () => {
    const base = await serve(devFixture());
    const home = mk(); const script = testScript();
    const r = await run(script, ['--base-url', base], home);
    expect(r.err).toBe(''); expect(r.code).toBe(0);
    expect(r.out).toMatch(/signature OK \(key dev-comp-1\)/);
    expect(r.out).toContain('SHA-256 matches the signed manifest');
    const dir = join(home, '.local', 'share', 'botwarren-companion');
    expect(readdirSync(join(dir, 'versions', '0.1.1')).sort()).toEqual(['LICENSE', 'NOTICE', 'VERSION', 'companion.mjs']);
    const shim = join(home, '.local', 'bin', 'botwarren-companion');
    expect(spawnSync(shim, ['version'], { encoding: 'utf8' }).stdout.trim()).toBe('0.1.1');
    expect(readdirSync(home)).toEqual(['.local']); // the wrapper's private temporary directory is gone
    // --uninstall (the companion stub's own `uninstall` just prints; the real one revokes devices and removes the hooks)
    const u = await run(script, ['--uninstall'], home);
    expect(u.code).toBe(0);
    expect(existsSync(dir)).toBe(false); expect(existsSync(shim)).toBe(false);
  });

  it('refuses a tampered bundle, a wrong signature and an expired manifest: exit 1, nothing installed, nothing run', async () => {
    const script = testScript();
    const tampered = devFixture({ serve: (z) => { const b = Buffer.from(z); b[b.length - 30]! ^= 1; return b; } });
    for (const [files, re] of [[tampered, /hash_mismatch/], [devFixture({ signer: OTHER }), /bad_signature/], [devFixture({ expires: '2026-01-01T00:00:00.000Z' }), /expired/]] as const) {
      const base = await serve(files);
      const home = mk();
      const r = await run(script, ['--base-url', base], home);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(re); expect(r.err).toContain('Nothing was installed or run');
      expect(existsSync(join(home, '.local', 'share', 'botwarren-companion'))).toBe(false);
      expect(existsSync(join(home, '.local', 'bin', 'botwarren-companion'))).toBe(false);
      await stop();
    }
  });

  it('the UNMODIFIED script (production key only) refuses a release signed with any other key, development or not', async () => {
    const base = await serve(devFixture());
    const home = mk();
    const r = await run(join(root, 'install', 'install.sh'), ['--base-url', base], home);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/bad_signature/); // the dev key id is allowed on loopback in tests, but its pinned key material is not the test key
    expect(existsSync(join(home, '.local', 'share', 'botwarren-companion'))).toBe(false);
    await stop();
    const base2 = await serve(fixture({ keyId: 'test-comp' }));
    const r2 = await run(join(root, 'install', 'install.sh'), ['--base-url', base2], mk());
    expect(r2.code).toBe(1); expect(r2.err).toMatch(/unknown_key/);
    // and without the test switch, the dev key is refused outright
    const r3 = await run(join(root, 'install', 'install.sh'), ['--base-url', base2], mk(), { BOTWARREN_COMPANION_ALLOW_DEV_KEY: '0' });
    expect(r3.code).toBe(1);
  });

  it('runs when the temporary directory is reached through a symlink (macOS: /var is /private/var)', async () => {
    const d = mk(); mkdirSync(join(d, 'real')); symlinkSync(join(d, 'real'), join(d, 'link'));
    const h = await run(join(root, 'install', 'install.sh'), ['--help'], d, { TMPDIR: join(d, 'link') });
    expect(h.code).toBe(0); expect(h.out).toContain('--service');
    const bad = await run(join(root, 'install', 'install.sh'), ['--base-url', 'http://downloads.botwarren.com'], d, { TMPDIR: join(d, 'link') });
    expect(bad.code).toBe(1); expect(bad.err).toMatch(/insecure_url/);
  });

  it('refuses plain http to a real host and says --help without installing anything', async () => {
    const home = mk();
    const r = await run(join(root, 'install', 'install.sh'), ['--base-url', 'http://downloads.botwarren.com'], home);
    expect(r.code).toBe(1); expect(r.err).toMatch(/insecure_url/);
    const h = await run(join(root, 'install', 'install.sh'), ['--help'], home);
    expect(h.code).toBe(0); expect(h.out).toContain('--service');
    const bad = await run(join(root, 'install', 'install.sh'), ['--nope'], home);
    expect(bad.code).toBe(2);
  });
});

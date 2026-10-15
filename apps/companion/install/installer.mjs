#!/usr/bin/env node
/**
 * The Botwarren Companion installer program (Apache-2.0). It is the single source of the verified install that install.sh and install.ps1 embed
 * (scripts/build-installers.mjs writes both; a test fails if they are out of date), for a computer WITHOUT a Botwarren ship agent: for example a
 * development machine that runs from source. With a ship agent, the agent installs the same component through the same checks.
 *
 * NOTHING IS INSTALLED WITHOUT VERIFICATION. In this order, and each step refuses with a reason and leaves nothing behind:
 *  1. the signed component manifest and its signature are downloaded (size capped), and the SIGNATURE IS CHECKED FIRST, before the manifest is parsed:
 *     Ed25519 over "botwarren-component-v1\0" + the exact bytes, by a key pinned in this file (PINNED_KEYS below, the same component key the ship agent
 *     pins; the key that signs agent updates is a different key and is not accepted here). A development key is refused unless a test explicitly allows it
 *     AND the download address is this computer (never for the real host);
 *  2. the manifest must be for the component "companion", unexpired, not older than one this computer accepted before (anti-rollback), and name a version
 *     that is not blocked, speaks protocol 1 and runs on this Node;
 *  3. the bundle is downloaded (size capped) and its SIZE and SHA-256 must equal the signed manifest's, BEFORE the archive is opened;
 *  4. the archive is read by a strict reader (no encryption, no links, no paths, exactly the allowlisted names, checksums), and VERSION must equal the
 *     signed version;
 *  5. only then is anything extracted, into a private staging directory and then renamed into place, and only then is `companion.mjs version` run, as a
 *     self-test. Nothing from the download runs before this point.
 * It needs no administrator rights: per-user directories only, the same ones the ship agent's installers use. It never reads or sends anything about
 * you; it only downloads three public files.
 *
 *   node installer.mjs [--base-url URL] [--dir DIR] [--bin-dir DIR] [--service] [--dry-run] [--uninstall [--keep-keys]] [--help]
 *
 * The pinned keys below must equal the ship agent's COMPONENT_PUBLIC_KEYS (a test checks it). Runs on Node >= 22.13.
 */
import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { crc32, inflateRawSync } from 'node:zlib';

/** the pinned component signing keys (SPKI, base64). `dev` keys are for tests only. */
export const PINNED_KEYS = [
  { id: 'dev-comp-1', spki: 'MCowBQYDK2VwAyEAQeJ8wcLQu2JfaeXPKj7yZd5JDJP3oylaKpQihLK0Lio=', dev: true },
  { id: 'kms-comp-2026a', spki: 'MCowBQYDK2VwAyEARv4WZoMAzdHQbQkIvHZpgGD/Pa6GXtwXN1Ql66vUVD4=', dev: false },
];

export const DEFAULT_BASE = 'https://downloads.botwarren.com';
const DOMAIN = Buffer.from('botwarren-component-v1\0', 'utf8');
const MAX_MANIFEST = 256 * 1024;
const MAX_SIG = 4096;
export const MAX_BUNDLE = 8 * 1024 * 1024;
const MAX_VERSION_STEP = 1000;
const ALLOWED_FILES = ['companion.mjs', 'VERSION', 'LICENSE', 'NOTICE'];
const REQUIRED_FILES = ['companion.mjs', 'VERSION'];
export const SHIM_MARKER = 'botwarren-companion shim (manual install)';
const AGENT_SHIM_MARKER = 'botwarren-companion shim (ship agent)';

const VERSION_RE = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const ISO_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?(Z|[+-]\d\d:\d\d)$/;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const cmpVersions = (a, b) => { const x = a.split('.').map(Number); const y = b.split('.').map(Number); for (let i = 0; i < 3; i++) { if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1; } return 0; };
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

export class Refused extends Error {
  constructor(code, detail) { super(detail ? `${code}: ${detail}` : code); this.code = code; }
}

// ---------------------------------------------------------------- the signed manifest (mirrors the ship agent's component verifier)
/**
 * @param {Buffer} bytes @param {string} sigText
 * @param {{ keys?: readonly {id:string,spki:string,dev?:boolean}[], now: Date, allowDev?: boolean, highestSeen?: number, epochFloor?: number, revoked?: readonly string[] }} o
 * @returns {{ ok: true, manifest: any, keyId: string } | { ok: false, code: string }}
 */
export function verifyManifest(bytes, sigText, o) {
  if (bytes.length > MAX_MANIFEST) return { ok: false, code: 'too_large' };
  let sf;
  try {
    sf = JSON.parse(sigText);
    if (!isObj(sf) || Object.keys(sf).sort().join() !== 'alg,keyId,sig' || sf.alg !== 'ed25519' || typeof sf.keyId !== 'string' || sf.keyId.length < 1 || sf.keyId.length > 64 || typeof sf.sig !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(sf.sig)) throw new Error('shape');
  } catch { return { ok: false, code: 'bad_signature_file' }; }
  const key = (o.keys ?? PINNED_KEYS).find((k) => k.id === sf.keyId);
  if (!key) return { ok: false, code: 'unknown_key' };
  if (o.revoked?.includes(key.id)) return { ok: false, code: 'key_revoked' };
  if (key.dev && !o.allowDev) return { ok: false, code: 'dev_key_refused' };
  let valid = false;
  try { valid = edVerify(null, Buffer.concat([DOMAIN, bytes]), createPublicKey({ key: Buffer.from(key.spki, 'base64'), format: 'der', type: 'spki' }), Buffer.from(sf.sig, 'base64')); } catch { valid = false; }
  if (!valid) return { ok: false, code: 'bad_signature' };
  // only now is the document parsed
  let m;
  try { m = parseManifest(JSON.parse(bytes.toString('utf8'))); } catch { return { ok: false, code: 'malformed' }; }
  if (Date.parse(m.expires) <= o.now.getTime()) return { ok: false, code: 'expired' };
  if (m.epoch < (o.epochFloor ?? 1)) return { ok: false, code: 'epoch_rollback' };
  const high = o.highestSeen ?? 0;
  if (m.manifestVersion < high) return { ok: false, code: 'rollback' };
  if (high > 0 && m.manifestVersion > high + MAX_VERSION_STEP) return { ok: false, code: 'version_jump' };
  if (m.component !== 'companion') return { ok: false, code: 'wrong_component' };
  return { ok: true, manifest: m, keyId: key.id };
}

const only = (o, keys, what) => { const extra = Object.keys(o).filter((k) => !keys.includes(k)); if (extra.length) throw new Error(`${what}: unexpected ${extra[0]}`); };

/** the same strict shape the agent's schema enforces (unknown fields refused) */
function parseManifest(j) {
  if (!isObj(j)) throw new Error('not an object');
  only(j, ['schema', 'kind', 'component', 'epoch', 'manifestVersion', 'issued', 'expires', 'channels', 'blocked', 'releases'], 'manifest');
  if (j.schema !== 1 || j.kind !== 'botwarren-component' || j.component !== 'companion') throw new Error('schema/kind/component');
  const epoch = j.epoch === undefined ? 1 : j.epoch;
  if (!Number.isInteger(epoch) || epoch < 1 || epoch > 10_000) throw new Error('epoch');
  if (!Number.isInteger(j.manifestVersion) || j.manifestVersion < 1) throw new Error('manifestVersion');
  for (const f of ['issued', 'expires']) if (typeof j[f] !== 'string' || !ISO_RE.test(j[f]) || !Number.isFinite(Date.parse(j[f]))) throw new Error(f);
  if (!isObj(j.channels)) throw new Error('channels');
  only(j.channels, ['stable'], 'channels');
  if (typeof j.channels.stable !== 'string' || !VERSION_RE.test(j.channels.stable)) throw new Error('stable');
  const blocked = j.blocked === undefined ? [] : j.blocked;
  if (!Array.isArray(blocked) || blocked.length > 200 || blocked.some((v) => typeof v !== 'string' || !VERSION_RE.test(v))) throw new Error('blocked');
  if (!isObj(j.releases)) throw new Error('releases');
  const releases = {};
  for (const [v, r] of Object.entries(j.releases)) {
    if (!VERSION_RE.test(v) || !isObj(r)) throw new Error('release');
    only(r, ['commit', 'protocol', 'bundle', 'minRuntime', 'minAgent'], 'release');
    if (r.commit !== undefined && !/^[0-9a-f]{7,40}$/.test(String(r.commit))) throw new Error('commit');
    if (!isObj(r.protocol)) throw new Error('protocol');
    only(r.protocol, ['min', 'max'], 'protocol');
    if (!Number.isInteger(r.protocol.min) || r.protocol.min < 1 || !Number.isInteger(r.protocol.max) || r.protocol.max < 1) throw new Error('protocol range');
    if (!isObj(r.bundle)) throw new Error('bundle');
    only(r.bundle, ['url', 'sha256', 'size'], 'bundle');
    if (typeof r.bundle.url !== 'string' || !/^[A-Za-z0-9._-]{1,100}$/.test(r.bundle.url) || r.bundle.url.includes('..')) throw new Error('bundle url (a plain file name next to the manifest is required here)');
    if (typeof r.bundle.sha256 !== 'string' || !SHA_RE.test(r.bundle.sha256)) throw new Error('bundle sha256');
    if (!Number.isInteger(r.bundle.size) || r.bundle.size < 1 || r.bundle.size > MAX_BUNDLE) throw new Error('bundle size');
    if (r.minRuntime !== undefined && !/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(String(r.minRuntime))) throw new Error('minRuntime');
    if (r.minAgent !== undefined && !VERSION_RE.test(String(r.minAgent))) throw new Error('minAgent');
    releases[v] = r;
  }
  return { ...j, epoch, blocked, releases };
}

/** the release this computer may install, or the reason it may not */
export function pickRelease(manifest, nodeVersion) {
  const version = manifest.channels.stable;
  const rel = manifest.releases[version];
  if (!rel || manifest.blocked.includes(version) || !(rel.protocol.min <= 1 && 1 <= rel.protocol.max)) throw new Refused('version_not_installable', version);
  if (rel.minRuntime && cmpVersions(nodeVersion, rel.minRuntime) < 0) throw new Refused('runtime_too_old', `needs Node ${rel.minRuntime}, this is ${nodeVersion}`);
  return { version, release: rel };
}

// ---------------------------------------------------------------- the bundle (a strict zip reader)
/** @returns {Map<string, Buffer>} exactly the allowlisted files; anything else refuses the whole archive */
export function readBundle(buf, expectVersion) {
  const bad = (m) => new Refused('bad_bundle', m);
  const eocd = buf.length - 22;
  if (eocd < 0 || buf.readUInt32LE(eocd) !== 0x06054b50) throw bad('not a zip (or has a comment)');
  const count = buf.readUInt16LE(eocd + 10); const cdSize = buf.readUInt32LE(eocd + 12); const cdOff = buf.readUInt32LE(eocd + 16);
  if (count < 1 || count > ALLOWED_FILES.length || cdOff + cdSize > eocd) throw bad('bad directory');
  const files = new Map(); let p = cdOff;
  for (let i = 0; i < count; i++) {
    if (p + 46 > eocd || buf.readUInt32LE(p) !== 0x02014b50) throw bad('bad central header');
    const flags = buf.readUInt16LE(p + 8); const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16); const csize = buf.readUInt32LE(p + 20); const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28); const xlen = buf.readUInt16LE(p + 30); const clen = buf.readUInt16LE(p + 32);
    const attr = buf.readUInt32LE(p + 38) >>> 16; const lho = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    p += 46 + nlen + xlen + clen;
    if (flags & 1) throw bad('encrypted entry');
    const type = attr & 0o170000;
    if (type !== 0 && type !== 0o100000) throw bad('special file');
    if (!ALLOWED_FILES.includes(name)) throw bad(`file not allowed: ${name.slice(0, 40)}`);
    if (files.has(name)) throw bad('duplicate entry');
    if (usize > MAX_BUNDLE) throw bad('entry too large');
    if (lho + 30 > eocd || buf.readUInt32LE(lho) !== 0x04034b50) throw bad('bad local header');
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const raw = buf.subarray(start, start + csize);
    if (raw.length !== csize) throw bad('truncated entry');
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) { try { data = inflateRawSync(raw, { maxOutputLength: MAX_BUNDLE }); } catch { throw bad('cannot inflate'); } } else throw bad('unsupported compression');
    if (data.length !== usize || crc32(data) !== crc) throw bad('entry checksum mismatch');
    files.set(name, data);
  }
  if (!REQUIRED_FILES.every((n) => files.has(n))) throw bad('a required file is missing');
  if (files.get('VERSION').toString('utf8').trim() !== expectVersion) throw bad('VERSION is not the signed version');
  return files;
}

// ---------------------------------------------------------------- locations
export function defaultPaths(o = {}) {
  const env = o.env ?? process.env; const os = o.os ?? platform();
  const home = o.home ?? env.HOME ?? env.USERPROFILE ?? homedir();
  if (os === 'win32') {
    const base = join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Botwarren');
    return { os, home, dir: join(base, 'companion'), bin: join(base, 'bin') };
  }
  return { os, home, dir: join(env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'botwarren-companion'), bin: join(home, '.local', 'bin') };
}

const quoteSh = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;

export function shimText(win, node, entry) {
  if (win) return `@echo off\r\nrem ${SHIM_MARKER}\r\n"${node}" --disable-warning=ExperimentalWarning "${entry}" %*\r\nexit /b %ERRORLEVEL%\r\n`;
  return `#!/bin/sh\n# ${SHIM_MARKER}; written by the Botwarren Companion installer; removed by its --uninstall\nexec ${quoteSh(node)} --disable-warning=ExperimentalWarning ${quoteSh(entry)} "$@"\n`;
}

// ---------------------------------------------------------------- download
async function download(f, url, max, ms) {
  let res;
  try { res = await f(url, { redirect: 'follow', signal: AbortSignal.timeout(ms), headers: { 'user-agent': 'botwarren-companion-installer' } }); } catch { throw new Refused('download_failed', url); }
  if (!res.ok || !res.body) throw new Refused('download_failed', `${url} answered ${res.status}`);
  const chunks = []; let n = 0;
  try { for await (const c of res.body) { n += c.length; if (n > max) throw new Refused('too_large', url); chunks.push(Buffer.from(c)); } } catch (e) { if (e instanceof Refused) throw e; throw new Refused('download_failed', url); }
  return Buffer.concat(chunks);
}

const isLoopback = (u) => /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/.test(u);

/** the base must be https (or this computer, for tests): never plain http to a real host */
export function checkBase(base) {
  if (!/^https:\/\/[A-Za-z0-9.-]+(:\d+)?(\/[A-Za-z0-9._~/-]*)?$/.test(base) && !isLoopback(base)) throw new Refused('insecure_url', 'the download address must be https');
  return base.replace(/\/*$/, '/') + 'companion/';
}

// ---------------------------------------------------------------- state and files
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
function writeAtomic(p, text, mode = 0o600) {
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, text, { mode });
  renameSync(tmp, p);
}

/** @param {string} file */
function ownedShim(file) { try { const t = readFileSync(file, 'utf8'); return t.includes(SHIM_MARKER) ? 'manual' : t.includes(AGENT_SHIM_MARKER) ? 'agent' : 'foreign'; } catch { return 'none'; } }

// ---------------------------------------------------------------- install
/**
 * @param {{ dir: string, bin: string, os: string, base: string, now?: () => Date, fetchImpl?: typeof fetch, keys?: readonly {id:string,spki:string,dev?:boolean}[], allowDev?: boolean, dryRun?: boolean, service?: boolean, log: (m: string) => void, selftest?: (entry: string, version: string) => boolean, nodeVersion?: string, nodePath?: string, runService?: (spec: object) => void, home?: string }} o
 */
export async function install(o) {
  const log = o.log; const now = (o.now ?? (() => new Date()))();
  const win = o.os === 'win32';
  const base = checkBase(o.base);
  if (o.allowDev && !isLoopback(o.base)) throw new Refused('dev_key_refused', 'a development key is only ever accepted for a download address on this computer');
  const f = o.fetchImpl ?? fetch; const ms = 30_000;
  const nodeVersion = o.nodeVersion ?? process.versions.node;

  log(`==> Downloading the signed component manifest from ${base}`);
  const mBytes = await download(f, base + 'manifest.json', MAX_MANIFEST, ms);
  const sBytes = await download(f, base + 'manifest.json.sig', MAX_SIG, ms);

  // 1-2: signature first, then everything the manifest says
  const state = readJson(join(o.dir, 'state.json')) ?? {};
  const high = Number.isInteger(state.highestManifestVersion) ? state.highestManifestVersion : 0;
  const epochFloor = Number.isInteger(state.epoch) ? state.epoch : 1;
  const v = verifyManifest(mBytes, sBytes.toString('utf8'), { keys: o.keys ?? PINNED_KEYS, now, allowDev: o.allowDev === true, highestSeen: high, epochFloor });
  if (!v.ok) throw new Refused('manifest_refused', v.code);
  log(`    signature OK (key ${v.keyId}), manifest ${v.manifest.manifestVersion}, valid until ${v.manifest.expires.slice(0, 10)}`);
  const { version, release } = pickRelease(v.manifest, nodeVersion);

  // 3: the bundle, then its hash and size BEFORE it is opened
  log(`==> Downloading companion ${version}`);
  const zip = await download(f, base + release.bundle.url, Math.min(release.bundle.size + 1, MAX_BUNDLE), ms);
  if (zip.length !== release.bundle.size) throw new Refused('size_mismatch');
  const digest = sha256(zip);
  if (digest !== release.bundle.sha256) throw new Refused('hash_mismatch');
  log(`    SHA-256 matches the signed manifest (${digest.slice(0, 16)}...)`);
  // 4: strict reader, allowlisted names, VERSION agrees
  const files = readBundle(zip, version);
  log(`    archive holds exactly: ${[...files.keys()].sort().join(', ')}`);

  if (o.dryRun) { log('Dry run: everything verified; nothing was written.'); return { status: 'dry_run', version }; }

  // 5: extract into staging, rename into place, and only then run the self-test
  const versionDir = join(o.dir, 'versions', version);
  const staging = join(o.dir, 'staging', `${version}.${process.pid}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  try {
    for (const [name, data] of files) writeFileSync(join(staging, name), data, { mode: 0o644 });
    mkdirSync(join(o.dir, 'versions'), { recursive: true, mode: 0o755 });
    rmSync(versionDir, { recursive: true, force: true });
    renameSync(staging, versionDir);
  } catch (e) { rmSync(staging, { recursive: true, force: true }); throw new Refused('install_failed', e.code ?? e.message); }
  rmSync(join(o.dir, 'staging'), { recursive: true, force: true });
  const entry = join(versionDir, 'companion.mjs');
  const selftest = o.selftest ?? defaultSelftest(o.nodePath ?? process.execPath);
  if (!selftest(entry, version)) { rmSync(versionDir, { recursive: true, force: true }); throw new Refused('selftest_failed'); }

  const previous = readJson(join(o.dir, 'install.json'));
  writeAtomic(join(o.dir, 'state.json'), JSON.stringify({ highestManifestVersion: Math.max(high, v.manifest.manifestVersion), epoch: Math.max(epochFloor, v.manifest.epoch) }) + '\n');
  writeAtomic(join(o.dir, 'install.json'), JSON.stringify({ how: 'manual', version, sha256: digest, keyId: v.keyId, manifestVersion: v.manifest.manifestVersion, installedAt: now.toISOString() }, null, 2) + '\n', 0o644);
  log(`==> Installed companion ${version} in ${versionDir}${previous?.version && previous.version !== version ? ` (replaces ${previous.version}; if you installed Claude Code hooks, run "botwarren-companion claude install-hooks" again to point them at the new version)` : ''}`);

  const shim = writeShim(o, version, entry, win);
  let svc = null;
  if (o.service) svc = installService(o, entry);
  return { status: previous?.version === version ? 'reinstalled' : 'installed', version, shim, service: svc };
}

function defaultSelftest(node) {
  return (entry, version) => {
    const r = spawnSync(node, ['--disable-warning=ExperimentalWarning', entry, 'version'], { encoding: 'utf8', timeout: 15_000, windowsHide: true, env: { PATH: process.env.PATH ?? '' }, stdio: ['ignore', 'pipe', 'ignore'] });
    return r.status === 0 && String(r.stdout).trim() === version;
  };
}

function writeShim(o, version, entry, win) {
  const file = join(o.bin, win ? 'botwarren-companion.cmd' : 'botwarren-companion');
  const who = ownedShim(file);
  if (who === 'foreign' || who === 'agent') {
    o.log(`    not changing ${file}: ${who === 'agent' ? 'the Botwarren ship agent added it (it runs the companion the agent installed)' : 'a file of that name is already there and was not written by this installer'}. Run this one directly: ${entry}`);
    return 'kept';
  }
  mkdirSync(o.bin, { recursive: true, mode: 0o755 });
  writeFileSync(file, shimText(win, o.nodePath ?? process.execPath, entry), { mode: 0o755 });
  if (!win) chmodSync(file, 0o755);
  o.log(`    command: ${file}`);
  if (!(o.env ?? process.env).PATH?.split(win ? ';' : ':').includes(o.bin)) o.log(win ? `    note: add ${o.bin} to your user PATH (a new terminal may be needed), or run ${file}` : `    note: add ${o.bin} to your PATH, for example: echo 'export PATH="${o.bin}:$PATH"' >> ~/.profile`);
  return 'written';
}

// ---------------------------------------------------------------- the background service (opt-in: --service)
const SERVICE = { systemd: 'botwarren-companion.service', launchd: 'com.botwarren.companion', startupVbs: 'Botwarren Companion.vbs' };

export function servicePaths(o) {
  const env = o.env ?? process.env; const home = o.home ?? env.HOME ?? env.USERPROFILE ?? homedir();
  if (o.os === 'win32') return { kind: 'startup', file: join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', SERVICE.startupVbs) };
  if (o.os === 'darwin') return { kind: 'launchd', file: join(home, 'Library', 'LaunchAgents', `${SERVICE.launchd}.plist`) };
  return { kind: 'systemd', file: join(env.XDG_CONFIG_HOME ?? join(home, '.config'), 'systemd', 'user', SERVICE.systemd) };
}

export function serviceText(kind, node, entry, logFile) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  if (kind === 'systemd') {
    // %-specifiers and spaces: systemd quoting
    const q = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
    return `[Unit]\nDescription=Botwarren Companion (remote approvals for your coding agents; end-to-end encrypted)\nAfter=network-online.target\n\n[Service]\nExecStart=${q(node)} --disable-warning=ExperimentalWarning ${q(entry)} daemon\nRestart=always\nRestartSec=5\nNoNewPrivileges=yes\nPrivateTmp=no\n\n[Install]\nWantedBy=default.target\n`;
  }
  if (kind === 'launchd') {
    return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n  <key>Label</key><string>${SERVICE.launchd}</string>\n  <key>ProgramArguments</key><array><string>${esc(node)}</string><string>--disable-warning=ExperimentalWarning</string><string>${esc(entry)}</string><string>daemon</string></array>\n  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>\n  <key>ThrottleInterval</key><integer>10</integer>\n  <key>StandardOutPath</key><string>${esc(logFile)}</string>\n  <key>StandardErrorPath</key><string>${esc(logFile)}</string>\n</dict></plist>\n`;
  }
  // Windows: a hidden launcher in the user's Startup folder (no administrator rights, no scheduled-task privileges)
  const vq = (s) => String(s).replace(/"/g, '""');
  return `' ${SHIM_MARKER}: starts the companion daemon at sign-in, hidden\r\nCreateObject("WScript.Shell").Run """${vq(node)}"" --disable-warning=ExperimentalWarning ""${vq(entry)}"" daemon", 0, False\r\n`;
}

function installService(o, entry) {
  const sp = servicePaths(o);
  const node = o.nodePath ?? process.execPath;
  const logFile = join(o.dir, 'daemon.log');
  mkdirSync(dirname(sp.file), { recursive: true });
  writeFileSync(sp.file, serviceText(sp.kind, node, entry, logFile), { mode: 0o644 });
  o.log(`==> Background service: ${sp.file}`);
  const run = o.runService ?? ((cmd, args) => spawnSync(cmd, args, { stdio: 'ignore', timeout: 20_000 }).status === 0);
  let started = false;
  if (sp.kind === 'systemd') {
    run('systemctl', ['--user', 'daemon-reload']);
    started = run('systemctl', ['--user', 'enable', '--now', SERVICE.systemd]);
    if (!started) o.log('    could not start it with systemd --user here. Start the daemon yourself: botwarren-companion daemon (leave it running)');
    else o.log('    running. (To keep it running when you are logged out: loginctl enable-linger $USER)');
  } else if (sp.kind === 'launchd') {
    const uid = String(process.getuid?.() ?? '');
    started = run('launchctl', ['bootstrap', `gui/${uid}`, sp.file]) || run('launchctl', ['load', '-w', sp.file]);
    o.log(started ? '    running.' : '    could not start it with launchd here. Start the daemon yourself: botwarren-companion daemon (leave it running)');
  } else {
    o.log('    it starts the next time you sign in to Windows. To start it now: botwarren-companion daemon (leave the window open), or sign out and in.');
  }
  return { kind: sp.kind, file: sp.file, started };
}

// ---------------------------------------------------------------- uninstall
/** removes what this installer put on the computer; the companion's own `uninstall` revokes devices and removes the Claude Code hooks first */
export function uninstall(o) {
  const log = o.log; const win = o.os === 'win32';
  const node = o.nodePath ?? process.execPath;
  const inst = readJson(join(o.dir, 'install.json'));
  if (!inst?.version && !existsSync(join(o.dir, 'versions'))) { log('Nothing to remove: no manual companion install found in ' + o.dir); return { status: 'none' }; }
  const entry = inst?.version ? join(o.dir, 'versions', inst.version, 'companion.mjs') : null;
  if (entry && existsSync(entry)) {
    log('==> Revoking paired devices, stopping the daemon, removing the Claude Code hooks' + (o.keepKeys ? '' : ' and deleting this computer\'s keys'));
    const r = (o.runCompanion ?? ((args) => spawnSync(node, ['--disable-warning=ExperimentalWarning', entry, ...args], { stdio: 'inherit', timeout: 60_000 }).status === 0))(['uninstall', ...(o.keepKeys ? [] : ['--purge']), '--yes']);
    if (!r) log('    the companion\'s own uninstall did not finish cleanly; the files are removed anyway (revoke your devices in the phone page too)');
  }
  const sp = servicePaths(o);
  if (existsSync(sp.file)) {
    const run = o.runService ?? ((cmd, args) => spawnSync(cmd, args, { stdio: 'ignore', timeout: 20_000 }).status === 0);
    if (sp.kind === 'systemd') { run('systemctl', ['--user', 'disable', '--now', SERVICE.systemd]); }
    if (sp.kind === 'launchd') { run('launchctl', ['bootout', `gui/${process.getuid?.() ?? ''}/${SERVICE.launchd}`]); }
    rmSync(sp.file, { force: true });
    if (sp.kind === 'systemd') run('systemctl', ['--user', 'daemon-reload']);
    log(`    removed ${sp.file}`);
  }
  const shim = join(o.bin, win ? 'botwarren-companion.cmd' : 'botwarren-companion');
  if (ownedShim(shim) === 'manual') { rmSync(shim, { force: true }); log(`    removed ${shim}`); }
  rmSync(o.dir, { recursive: true, force: true });
  log(`==> Removed ${o.dir}`);
  return { status: 'removed' };
}

// ---------------------------------------------------------------- command line
const HELP = `Botwarren Companion installer (per user, no administrator rights)

  --service        also run the companion in the background (systemd --user, launchd, or the Windows Startup folder)
  --dry-run        download and verify everything, write nothing
  --uninstall      remove what this installer installed (devices are revoked and keys deleted first; --keep-keys keeps the keys)
  --base-url URL   where the signed files are (default ${DEFAULT_BASE}); https only
  --dir DIR        install directory (default: per user)
  --bin-dir DIR    where the botwarren-companion command goes (default: per user)

It installs only the companion, only after checking its Ed25519 signature against the key pinned in this script and its SHA-256, and it runs nothing from
the download before both checks pass. Only an account that the Botwarren team enabled and that agreed on https://botwarren.com/account can use it.
`;

export function parseArgs(argv, env = process.env) {
  const a = { service: false, dryRun: false, uninstall: false, keepKeys: false, help: false, base: env.BOTWARREN_BASE_URL || DEFAULT_BASE, dir: undefined, bin: undefined };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    const val = () => { const v = argv[++i]; if (!v || v.startsWith('--')) throw new Refused('usage', `${x} needs a value`); return v; };
    if (x === '--service') a.service = true;
    else if (x === '--dry-run') a.dryRun = true;
    else if (x === '--uninstall') a.uninstall = true;
    else if (x === '--keep-keys') a.keepKeys = true;
    else if (x === '--base-url') a.base = val();
    else if (x === '--dir') a.dir = val();
    else if (x === '--bin-dir') a.bin = val();
    else if (x === '-h' || x === '--help') a.help = true;
    else throw new Refused('usage', `unknown option ${x}`);
  }
  return a;
}

export async function main(argv, env = process.env) {
  const log = (m) => process.stdout.write(m + '\n');
  let a;
  try { a = parseArgs(argv, env); } catch (e) { process.stderr.write(`${e.message}\n\n${HELP}`); return 2; }
  if (a.help) { process.stdout.write(HELP); return 0; }
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj < 22 || (maj === 22 && min < 13)) { process.stderr.write(`Node ${process.versions.node} is too old: the companion needs Node 22.13 or newer.\n`); return 1; }
  const d = defaultPaths({ env });
  const o = { dir: a.dir ?? d.dir, bin: a.bin ?? d.bin, os: d.os, home: d.home, env, base: a.base, log, dryRun: a.dryRun, service: a.service, keepKeys: a.keepKeys, allowDev: env.BOTWARREN_COMPANION_ALLOW_DEV_KEY === '1' };
  try {
    if (a.uninstall) { uninstall(o); return 0; }
    const r = await install(o);
    if (r.status !== 'dry_run') {
      log('');
      log('Next (once): botwarren-companion enroll       then: botwarren-companion pair');
      log('  enroll shows this computer\'s public key and asks you to paste the enrolment from https://botwarren.com/account (Remote approvals > Enrol a computer).');
      log(r.service?.started ? '  The background service is running.' : '  Keep the daemon running: botwarren-companion daemon   (or re-run this installer with --service)');
      log('Remove it all again:    re-run this installer with --uninstall');
    }
    return 0;
  } catch (e) {
    if (e instanceof Refused) { process.stderr.write(`Refused: ${e.message}\nNothing was installed or run.\n`); return 1; }
    process.stderr.write(`Failed: ${e?.message ?? e}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));

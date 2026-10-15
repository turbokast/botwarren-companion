/**
 * Verification of a Companion RELEASE directory, shared by the release workflow (stage-release.mjs verifies what it just made, and the workflow checks
 * it again before anything is uploaded) and by anyone who downloaded a release (scripts/verify-release.mjs). It trusts nothing in the directory except
 * the pinned public component key:
 *
 *   SHA256SUMS                  lists exactly the other files, with their hashes
 *   client-manifest.json(.sig)  Ed25519 signature (domain botwarren-client-v1) by a pinned, non-dev component key; names the version and every client file
 *   client-<v>.tar.gz           holds exactly the files that manifest names (plus the manifest and its signature, byte-identical to the two above)
 *   component-manifest.json(.sig)  signed (domain botwarren-component-v1) with the agent's own verifier; its bundle hash and size equal the zip
 *   companion-<v>.zip           holds exactly companion.mjs, VERSION, LICENSE, NOTICE (the files the ship agent will extract), VERSION equals the release
 *   relay-context-<v>.tar.gz    its CONTEXT.json hashes match its files; its client/ is byte-identical to the signed client
 *
 * Licence: Apache-2.0.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readTarGz, readZip } from '../../vendor/agent/src/update/archive.ts';
import { BUNDLE_FILES, BUNDLE_REQUIRED } from '../../vendor/agent/src/component/manifest.ts';
import { verifyComponentManifest } from '../../vendor/agent/src/component/verify.ts';
import { releaseKeys, verifySig } from '../../client/scripts/lib.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const eq = (a, b) => Buffer.compare(a, b) === 0;

/** @returns {Promise<{ ok: boolean, problems: string[], version?: string }>} */
export async function verifyReleaseDir({ dir, allowDev = false, now = new Date(), keys, componentKeys }) {
  const problems = []; const bad = (m) => problems.push(m);
  const read = (n) => readFileSync(join(dir, n));
  const releaseKeySet = keys ?? await releaseKeys({ allowDev });
  const compKeys = componentKeys ?? releaseKeySet.map((k) => ({ ...k, dev: Boolean(allowDev && k.dev), role: 'component' }));

  // 1. SHA256SUMS lists exactly the files present
  if (!existsSync(join(dir, 'SHA256SUMS'))) return { ok: false, problems: ['no SHA256SUMS'] };
  const listed = new Map();
  for (const line of read('SHA256SUMS').toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    const m = /^([0-9a-f]{64}) [ *](\S+)$/.exec(line);
    if (!m) { bad(`bad SHA256SUMS line: ${line.slice(0, 80)}`); continue; }
    listed.set(m[2], m[1]);
  }
  const present = readdirSync(dir).filter((f) => f !== 'SHA256SUMS').sort();
  if (JSON.stringify([...listed.keys()].sort()) !== JSON.stringify(present)) bad(`SHA256SUMS lists ${[...listed.keys()].sort().join(', ')} but the directory holds ${present.join(', ')}`);
  for (const f of present) if (listed.has(f) && sha(read(f)) !== listed.get(f)) bad(`${f}: hash does not match SHA256SUMS`);
  if (problems.length) return { ok: false, problems };

  // 2. the signed client
  const cm = read('client-manifest.json'); const cs = read('client-manifest.json.sig').toString('utf8');
  let clientManifest;
  try { clientManifest = JSON.parse(cm.toString('utf8')); } catch { return { ok: false, problems: ['client-manifest.json is not JSON'] }; }
  let sigOk = false;
  try { sigOk = verifySig(cm, cs, releaseKeySet); } catch { sigOk = false; }
  if (!sigOk) bad('the client manifest signature does not verify against the pinned component keys');
  if (clientManifest.kind !== 'botwarren-companion-client' || clientManifest.schema !== 1) bad('the client manifest is not a Companion client manifest');
  const version = String(clientManifest.version);
  if (Date.parse(clientManifest.expires) <= now.getTime()) bad('the client manifest has expired');
  const expectNames = [`client-${version}.tar.gz`, 'client-manifest.json', 'client-manifest.json.sig', 'component-manifest.json', 'component-manifest.json.sig', `companion-${version}.zip`, `relay-context-${version}.tar.gz`].sort();
  if (JSON.stringify(present) !== JSON.stringify(expectNames)) bad(`unexpected release files: ${present.join(', ')} (expected ${expectNames.join(', ')})`);
  if (problems.length) return { ok: false, problems, version };

  const clientFiles = new Map(readTarGz(read(`client-${version}.tar.gz`)).map((e) => [e.name, e.data]));
  const named = [clientManifest.entry.js, clientManifest.entry.css, clientManifest.loader];
  for (const f of named) {
    const d = clientFiles.get(f.path);
    if (!d) bad(`the client archive lacks ${f.path}`);
    else if (d.length !== f.size || sha(d) !== f.sha256) bad(`client file ${f.path} does not match the signed manifest`);
  }
  if (!clientFiles.has('index.html')) bad('the client archive lacks index.html');
  if (!clientFiles.get('manifest.json') || !eq(clientFiles.get('manifest.json'), cm)) bad('the manifest inside the client archive differs from client-manifest.json');
  if (!clientFiles.get('manifest.json.sig') || clientFiles.get('manifest.json.sig').toString('utf8') !== cs) bad('the signature inside the client archive differs from client-manifest.json.sig');
  // the loader's SRI in index.html must be the hash of the signed loader (the page is the entry point of the verification chain)
  const html = clientFiles.get('index.html')?.toString('utf8') ?? '';
  const sri = `sha256-${createHash('sha256').update(clientFiles.get(clientManifest.loader.path) ?? Buffer.alloc(0)).digest('base64')}`;
  if (!html.includes(sri)) bad('index.html does not carry the SRI hash of the signed loader');

  // 3. the signed component manifest
  const mb = read('component-manifest.json'); const ms = read('component-manifest.json.sig').toString('utf8');
  let pm; try { pm = JSON.parse(mb.toString('utf8')); } catch { pm = null; }
  if (!pm) bad('component-manifest.json is not JSON');
  else {
    const r = verifyComponentManifest(mb, ms, { component: 'companion', keys: compKeys, now, allowDev, highestSeen: 0, epoch: Number(pm.epoch ?? 1) });
    if (!r.ok) bad(`the component manifest does not verify (${r.code})`);
    else {
      const rel = r.manifest.releases[version];
      if (r.manifest.channels.stable !== version) bad(`the component manifest's stable channel is ${r.manifest.channels.stable}, not ${version}`);
      if (!rel) bad(`the component manifest has no release ${version}`);
      else {
        const zip = read(`companion-${version}.zip`);
        if (rel.bundle.url !== `companion-${version}.zip` || rel.bundle.size !== zip.length || rel.bundle.sha256 !== sha(zip)) bad('the component manifest does not describe companion-<version>.zip');
        const entries = readZip(zip);
        const names = entries.map((e) => e.name).sort();
        if (names.some((n) => !BUNDLE_FILES.companion.includes(n)) || BUNDLE_REQUIRED.companion.some((n) => !names.includes(n))) bad(`the component bundle holds ${names.join(', ')}`);
        const v = entries.find((e) => e.name === 'VERSION')?.data.toString('utf8').trim();
        if (v !== version) bad(`the component bundle's VERSION is ${v}, not ${version}`);
      }
    }
  }

  // 4. the relay image inputs
  const ctxEntries = new Map(readTarGz(read(`relay-context-${version}.tar.gz`)).map((e) => [e.name, e.data]));
  const ctxRaw = ctxEntries.get('CONTEXT.json');
  if (!ctxRaw) bad('the relay context has no CONTEXT.json');
  else {
    const ctx = JSON.parse(ctxRaw.toString('utf8'));
    if (ctx.version !== version) bad('the relay context is for another version');
    const names = [...ctxEntries.keys()].filter((n) => n !== 'CONTEXT.json').sort();
    if (JSON.stringify(names) !== JSON.stringify(Object.keys(ctx.files).sort())) bad('CONTEXT.json does not list exactly the files of the relay context');
    for (const n of names) if (sha(ctxEntries.get(n)) !== ctx.files[n]) bad(`relay context file ${n} does not match CONTEXT.json`);
    for (const [n, d] of clientFiles) { const c = ctxEntries.get(`client/${n}`); if (!c || !eq(c, d)) bad(`the relay context's client/${n} differs from the signed client`); }
    for (const n of names.filter((x) => x.startsWith('client/'))) if (!clientFiles.has(n.slice('client/'.length))) bad(`the relay context has an extra client file ${n}`);
  }
  return { ok: problems.length === 0, problems, version };
}

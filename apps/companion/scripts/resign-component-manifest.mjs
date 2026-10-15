#!/usr/bin/env node
/**
 * Re-signing the CURRENT component manifest: the same release, the same bytes of the bundle, a new manifest counter and a fresh validity window.
 * A component manifest is valid for 90 days (the ship agent and the manual installer install nothing from an expired one). A release makes a new one, but a
 * quiet quarter would let the current one lapse; the scheduled workflow (.github/workflows/resign.yml) calls this to renew it, behind the same `release`
 * environment approvals as a release.
 *
 *   node scripts/resign-component-manifest.mjs plan    --manifest m.json --sig m.json.sig [--within-days 45] [--force] [--github-output]
 *   node scripts/resign-component-manifest.mjs prepare --manifest m.json --sig m.json.sig --zip companion-X.zip --out dir [--epoch N] [--valid-days 90]
 *   node scripts/resign-component-manifest.mjs check   --previous m.json --previous-sig m.json.sig --manifest new.json --sig new.json.sig [--min-days 80] [--epoch N]
 *
 *   plan     verifies the published manifest against the PINNED component keys (an expired one is still read: renewing it is the point) and says whether
 *            fewer than --within-days days remain. It writes nothing.
 *   prepare  verifies the published manifest and the published bundle (SIZE, SHA-256, the archive contents, VERSION) and writes <out>/manifest.json: the
 *            SAME channels, releases and blocked list, manifestVersion + 1 (anti-rollback needs it to rise), issued = now, expires = now + --valid-days.
 *            It can change nothing else: it never takes a version, a hash or a URL from anywhere but the verified manifest. Signing is separate
 *            (component-sign.mjs, Cloud KMS in the gated job).
 *   check    run on the SIGNED result: the signature verifies under the pinned key, the counter is exactly the previous + 1, everything but issued/expires/
 *            counter is identical to the previous manifest, and it is valid for at least --min-days.
 * Licence: Apache-2.0.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { COMPONENT_PUBLIC_KEYS, roleOf } from '../vendor/agent/src/update/keys.ts';
import { readZip } from '../vendor/agent/src/update/archive.ts';
import { BUNDLE_FILES, BUNDLE_REQUIRED, ComponentManifest } from '../vendor/agent/src/component/manifest.ts';
import { verifyComponentManifest } from '../vendor/agent/src/component/verify.ts';

const DAY = 86_400_000;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const prodKeys = () => COMPONENT_PUBLIC_KEYS.filter((k) => roleOf(k) === 'component' && !k.dev);

/** the published manifest, verified against the pinned keys; an expired one is accepted (its epoch is whatever it says: we only renew it) */
function readPublished({ bytes, sig, keys, allowDev, now }) {
  let raw;
  try { raw = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('the published manifest is not JSON'); }
  const r = verifyComponentManifest(bytes, sig, { component: 'companion', keys, now, allowDev, highestSeen: 0, epoch: Number(raw?.epoch ?? 1) });
  if (!r.ok && r.code !== 'expired') throw new Error(`the published manifest does not verify against the pinned component keys (${r.code}); refusing to renew it`);
  return { manifest: ComponentManifest.parse(raw), keyId: r.ok ? r.keyId : null, expired: !r.ok };
}

/** @returns {{ version: string, manifestVersion: number, expires: string, daysLeft: number, needed: boolean }} */
export function planResign({ bytes, sig, now = new Date(), withinDays = 45, force = false, keys = prodKeys(), allowDev = false }) {
  const { manifest } = readPublished({ bytes, sig, keys, allowDev, now });
  const daysLeft = Math.floor((Date.parse(manifest.expires) - now.getTime()) / DAY);
  return { version: manifest.channels.stable, manifestVersion: manifest.manifestVersion, expires: manifest.expires, daysLeft, needed: force || daysLeft < withinDays };
}

/** @returns {{ manifest: object, bytes: Buffer }} */
export function prepareResign({ bytes, sig, zip, now = new Date(), epoch, validDays = 90, keys = prodKeys(), allowDev = false }) {
  const { manifest: prev } = readPublished({ bytes, sig, keys, allowDev, now });
  const version = prev.channels.stable;
  const rel = prev.releases[version];
  if (!rel) throw new Error(`the published manifest has no release ${version}`);
  if (prev.blocked.includes(version)) throw new Error(`the stable version ${version} is blocked: re-signing would not help; make a release`);
  // the bundle must still be exactly what the manifest describes: re-signing vouches for these bytes again
  if (zip.length !== rel.bundle.size || sha(zip) !== rel.bundle.sha256) throw new Error(`the published bundle for ${version} does not match the manifest (size or SHA-256); refusing to sign it again`);
  const entries = readZip(zip);
  const names = entries.map((e) => e.name).sort();
  if (names.some((n) => !BUNDLE_FILES.companion.includes(n)) || BUNDLE_REQUIRED.companion.some((n) => !names.includes(n))) throw new Error(`the bundle holds ${names.join(', ')}`);
  if (entries.find((e) => e.name === 'VERSION')?.data.toString('utf8').trim() !== version) throw new Error('the bundle VERSION is not the manifest version');
  const nextEpoch = epoch ?? prev.epoch;
  if (nextEpoch < prev.epoch) throw new Error(`the trust epoch ${nextEpoch} is lower than the published manifest's ${prev.epoch}`);
  const next = ComponentManifest.parse({
    ...prev, epoch: nextEpoch, manifestVersion: prev.manifestVersion + 1, issued: now.toISOString(), expires: new Date(now.getTime() + validDays * DAY).toISOString(),
  });
  return { manifest: next, bytes: Buffer.from(JSON.stringify(next, null, 2) + '\n') };
}

/** verifies the SIGNED re-signed manifest against the published one it renews; returns a list of problems (empty = fine) */
export function checkResigned({ previous, previousSig, bytes, sig, now = new Date(), minDays = 80, epoch, keys = prodKeys(), allowDev = false }) {
  const problems = [];
  let prev;
  try { prev = readPublished({ bytes: previous, sig: previousSig, keys, allowDev, now }).manifest; } catch (e) { return [e.message]; }
  const v = verifyComponentManifest(bytes, sig, { component: 'companion', keys, now, allowDev, highestSeen: prev.manifestVersion, epoch: epoch ?? prev.epoch });
  if (!v.ok) return [`the new manifest does not verify against the pinned component keys (${v.code})`];
  const next = v.manifest;
  if (next.manifestVersion !== prev.manifestVersion + 1) problems.push(`the counter is ${next.manifestVersion}, expected ${prev.manifestVersion + 1}`);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (!same(next.channels, prev.channels)) problems.push('the stable channel changed');
  if (!same(next.releases, prev.releases)) problems.push('the releases changed (versions, hashes and addresses must be exactly the published ones)');
  if (!same([...next.blocked].sort(), [...prev.blocked].sort())) problems.push('the blocked list changed');
  if (next.epoch < prev.epoch) problems.push('the trust epoch went down');
  if (Date.parse(next.expires) - now.getTime() < minDays * DAY) problems.push(`the new manifest is valid for fewer than ${minDays} days`);
  if (Date.parse(next.issued) > now.getTime() + 5 * 60_000) problems.push('the new manifest is issued in the future');
  return problems;
}

function main(argv) {
  const mode = argv[0];
  const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const read = (n) => readFileSync(resolve(String(opt(n) ?? (console.error(`missing ${n}`), process.exit(2)))));
  const allowDev = argv.includes('--allow-dev-key');
  try {
    if (mode === 'plan') {
      const r = planResign({ bytes: read('--manifest'), sig: read('--sig').toString('utf8'), withinDays: Number(opt('--within-days') ?? 45), force: argv.includes('--force'), allowDev });
      console.log(`published component manifest ${r.manifestVersion} (companion ${r.version}) expires ${r.expires.slice(0, 10)}: ${r.daysLeft} day(s) left; ${r.needed ? 'RENEW it' : 'no renewal needed yet'}`);
      if (argv.includes('--github-output') && process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `needed=${r.needed}\ndays_left=${r.daysLeft}\nversion=${r.version}\nmanifest_version=${r.manifestVersion}\n`);
      return;
    }
    if (mode === 'prepare') {
      const out = opt('--out'); if (!out) { console.error('missing --out'); process.exit(2); }
      const r = prepareResign({ bytes: read('--manifest'), sig: read('--sig').toString('utf8'), zip: read('--zip'), ...(opt('--epoch') ? { epoch: Number(opt('--epoch')) } : {}), ...(opt('--valid-days') ? { validDays: Number(opt('--valid-days')) } : {}), allowDev });
      mkdirSync(resolve(out), { recursive: true });
      writeFileSync(resolve(out, 'manifest.json'), r.bytes);
      console.log(`prepared ${resolve(out, 'manifest.json')}: companion ${r.manifest.channels.stable}, manifestVersion ${r.manifest.manifestVersion}, epoch ${r.manifest.epoch}, expires ${r.manifest.expires}`);
      return;
    }
    if (mode === 'check') {
      const problems = checkResigned({ previous: read('--previous'), previousSig: read('--previous-sig').toString('utf8'), bytes: read('--manifest'), sig: read('--sig').toString('utf8'), ...(opt('--min-days') ? { minDays: Number(opt('--min-days')) } : {}), ...(opt('--epoch') ? { epoch: Number(opt('--epoch')) } : {}), allowDev });
      if (problems.length) { for (const p of problems) console.error(`  FAIL ${p}`); console.error('the re-signed manifest does NOT check out'); process.exit(1); }
      console.log('the re-signed manifest verifies and differs from the published one only in counter, issued and expires');
      return;
    }
    console.error('usage: resign-component-manifest.mjs plan|prepare|check ... (see the header of this file)'); process.exit(2);
  } catch (e) { console.error(`resign-component-manifest: ${e.message}`); process.exit(1); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2));

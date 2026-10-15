#!/usr/bin/env node
/**
 * Finalises the component manifest TEMPLATE that scripts/build-component.mjs wrote, WITHOUT rebuilding anything: it describes the exact
 * bytes of the reproducible build output. It sets the things that depend on the world rather than on the source:
 *
 *   manifestVersion   previous manifest's counter + 1 (the agent refuses a lower one: anti-rollback). The previous manifest is verified against
 *                     the pinned COMPONENT keys first, so a tampered or foreign "previous" can neither lower nor inflate the counter.
 *   blocked           versions the previous manifest blocked stay blocked
 *   epoch             the trust epoch (default 1; raised only by the owner after a recovery ceremony)
 *   issued / expires  now, and now + --valid-days (default 90)
 *
 *   node scripts/assemble-component-manifest.mjs --dir dist/component --out signed [--previous prev.json --previous-sig prev.json.sig]
 *        [--epoch N] [--valid-days 90] [--block <version>]... [--allow-dev-key]
 *
 * Writes <out>/manifest.json (and copies nothing else: the zip stays in --dir). Signing is separate (component-sign.mjs, Cloud KMS in the
 * gated release job). Licence: Apache-2.0.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { COMPONENT_PUBLIC_KEYS, roleOf } from '../vendor/agent/src/update/keys.ts';
import { ComponentManifest } from '../vendor/agent/src/component/manifest.ts';
import { verifyComponentManifest } from '../vendor/agent/src/component/verify.ts';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const DAY = 86_400_000;

/**
 * @param {{ dir: string, previous?: { bytes: Buffer, sig: string }, epoch?: number, validDays?: number, block?: string[], now?: Date, keys?: readonly object[], allowDev?: boolean }} o
 * @returns {{ manifest: object, bytes: Buffer, previousVersion: number }}
 */
export function assembleComponentManifest({ dir, previous, epoch = 1, validDays = 90, block = [], now = new Date(), keys = COMPONENT_PUBLIC_KEYS.filter((k) => roleOf(k) === 'component' && !k.dev), allowDev = false }) {
  const template = ComponentManifest.parse(JSON.parse(readFileSync(resolve(dir, 'manifest.json'), 'utf8')));
  // every artifact the manifest names must be present and match what the build wrote: this script describes the build, it never changes it
  for (const [v, r] of Object.entries(template.releases)) {
    const zip = readFileSync(resolve(dir, r.bundle.url));
    if (zip.length !== r.bundle.size || sha(zip) !== r.bundle.sha256) throw new Error(`the build output for ${v} does not match its manifest template (${r.bundle.url})`);
  }
  let previousVersion = 0; let blocked = [...new Set([...template.blocked, ...block])];
  if (previous) {
    // signature first: nothing from an unverified document is trusted. `expired` is fine here (the counter must survive an expiry);
    // the epoch of the previous document is whatever it says, because we only need its counter and blocked list.
    let pm;
    try { pm = JSON.parse(previous.bytes.toString('utf8')); } catch { throw new Error('the previous manifest is not JSON'); }
    const check = verifyComponentManifest(previous.bytes, previous.sig, { component: 'companion', keys, now, allowDev, highestSeen: 0, epoch: Number(pm?.epoch ?? 1) });
    if (!check.ok && check.code !== 'expired') throw new Error(`the previous manifest does not verify against the pinned component keys (${check.code}); refusing to guess a manifest counter`);
    const parsed = ComponentManifest.parse(pm);
    previousVersion = parsed.manifestVersion;
    blocked = [...new Set([...parsed.blocked, ...blocked])].sort();
    if (epoch < parsed.epoch) throw new Error(`the trust epoch ${epoch} is lower than the previous manifest's ${parsed.epoch}`);
  }
  const manifest = ComponentManifest.parse({
    ...template,
    epoch,
    manifestVersion: previousVersion + 1,
    issued: now.toISOString(),
    expires: new Date(now.getTime() + validDays * DAY).toISOString(),
    blocked: [...blocked].sort(),
  });
  if (manifest.blocked.includes(manifest.channels.stable)) throw new Error(`the stable version ${manifest.channels.stable} is in the blocked list`);
  return { manifest, bytes: Buffer.from(JSON.stringify(manifest, null, 2) + '\n'), previousVersion };
}

function main(argv) {
  const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const dir = opt('--dir'); const out = opt('--out');
  if (!dir || !out) { console.error('usage: assemble-component-manifest.mjs --dir <build output> --out <dir> [--previous <manifest> --previous-sig <sig>] [--epoch N] [--valid-days N]'); process.exit(2); }
  const prev = opt('--previous'); const prevSig = opt('--previous-sig');
  if (Boolean(prev) !== Boolean(prevSig)) { console.error('--previous and --previous-sig go together'); process.exit(2); }
  try {
    const r = assembleComponentManifest({
      dir,
      ...(prev ? { previous: { bytes: readFileSync(resolve(prev)), sig: readFileSync(resolve(prevSig), 'utf8') } } : {}),
      ...(opt('--epoch') ? { epoch: Number(opt('--epoch')) } : {}),
      ...(opt('--valid-days') ? { validDays: Number(opt('--valid-days')) } : {}),
      block: argv.flatMap((a, i) => (a === '--block' ? [argv[i + 1]] : [])),
      allowDev: argv.includes('--allow-dev-key'),
    });
    mkdirSync(resolve(out), { recursive: true });
    writeFileSync(resolve(out, 'manifest.json'), r.bytes);
    console.log(`assembled ${resolve(out, 'manifest.json')}: component ${r.manifest.component} ${r.manifest.channels.stable}, manifestVersion ${r.manifest.manifestVersion} (previous ${r.previousVersion}), epoch ${r.manifest.epoch}, expires ${r.manifest.expires}`);
  } catch (e) { console.error(`assemble-component-manifest: ${e.message}`); process.exit(1); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2));

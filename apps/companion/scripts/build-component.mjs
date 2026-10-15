#!/usr/bin/env node
/**
 * Builds the signed-component payload the ship agent installs: one bundled file, the version, the licence and the notice, in a deterministic
 * zip, plus the UNSIGNED component manifest TEMPLATE (manifest version 1). The release workflow then finalises the template with
 * scripts/assemble-component-manifest.mjs (manifest counter, trust epoch, blocked list, validity) and signs it with Cloud KMS.
 *
 *   node scripts/build-component.mjs [--out dist-component] [--manifest-version N] [--epoch N] [--valid-days 90]
 *
 * Reproducible: same source + esbuild version + SOURCE_DATE_EPOCH => same bytes. Licence: Apache-2.0.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { writeZip } from '../vendor/agent/src/update/archive.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const out = resolve(opt('--out', resolve(root, 'dist-component')));
const version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
const now = process.env.SOURCE_DATE_EPOCH ? Number(process.env.SOURCE_DATE_EPOCH) * 1000 : Date.now();
const sha = (b) => createHash('sha256').update(b).digest('hex');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const bundled = (await build({
  entryPoints: [resolve(root, 'src/cli.ts')], bundle: true, platform: 'node', format: 'esm', target: 'node22', minify: false, legalComments: 'none', write: false, logLevel: 'silent',
  banner: { js: '// Botwarren Companion (Apache-2.0). Bundled build; source: https://github.com/turbokast/botwarren-companion' },
})).outputFiles[0].contents;
const zip = writeZip([
  { name: 'companion.mjs', data: Buffer.from(bundled), mode: 0o644 },
  { name: 'VERSION', data: Buffer.from(`${version}\n`), mode: 0o644 },
  { name: 'LICENSE', data: readFileSync(resolve(root, 'LICENSE')), mode: 0o644 },
  { name: 'NOTICE', data: readFileSync(resolve(root, 'NOTICE')), mode: 0o644 },
]);
const zipName = `companion-${version}.zip`;
writeFileSync(resolve(out, zipName), zip);
const manifest = {
  schema: 1, kind: 'botwarren-component', component: 'companion', epoch: Number(opt('--epoch', '1')), manifestVersion: Number(opt('--manifest-version', '1')),
  issued: new Date(now).toISOString(), expires: new Date(now + Number(opt('--valid-days', '90')) * 86_400_000).toISOString(),
  channels: { stable: version }, blocked: [],
  releases: { [version]: { ...(process.env.GIT_COMMIT ? { commit: process.env.GIT_COMMIT } : {}), protocol: { min: 1, max: 1 }, bundle: { url: zipName, sha256: sha(zip), size: zip.length }, minAgent: '0.7.0', minRuntime: '22.13.0' } },
};
writeFileSync(resolve(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`built ${zipName} (${zip.length} bytes, sha256 ${sha(zip).slice(0, 16)}...) and the unsigned manifest in ${out}`);
console.log('next: scripts/assemble-component-manifest.mjs (counter, epoch, validity), then sign (vendor/agent/scripts/component-sign.mjs in the public repository, apps/shipagent/scripts/component-sign.mjs in the monorepo).');

#!/usr/bin/env node
/**
 * Stages the files of a release from the reproducible build output plus the two signatures, and verifies the result before it is handed on.
 *
 *   node apps/companion/scripts/stage-release.mjs --client <signed client dir> --component-zip <companion-X.zip> --component-manifest <manifest.json> --out <dir> [--allow-dev-key]
 *
 * The client directory must already hold manifest.json.sig (client/scripts/sign.mjs) and the component manifest its .sig (component-sign.mjs). Writes, to --out:
 *   companion-X.zip, component-manifest.json(.sig), client-X.tar.gz, client-manifest.json(.sig), relay-context-X.tar.gz, install.sh, install.ps1 and SHA256SUMS,
 * plus install.sh and install.ps1 (the manual installers, install/), then runs the same verification a downloader runs (lib/release-verify.mjs) and fails if
 * anything is off. Licence: Apache-2.0.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeTarGz } from '../vendor/agent/src/update/archive.ts';
import { makeRelayContext } from './make-relay-context.mjs';
import { verifyReleaseDir } from './lib/release-verify.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const defaultInstallDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'install');

export async function stageRelease({ clientDir, componentZip, componentManifest, out, allowDev = false, root, keys, installDir = defaultInstallDir, installerKeys }) {
  const outDir = resolve(out);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const cm = JSON.parse(readFileSync(join(clientDir, 'manifest.json'), 'utf8'));
  const version = String(cm.version);
  copyFileSync(componentZip, join(outDir, `companion-${version}.zip`));
  copyFileSync(componentManifest, join(outDir, 'component-manifest.json'));
  copyFileSync(`${componentManifest}.sig`, join(outDir, 'component-manifest.json.sig'));
  copyFileSync(join(clientDir, 'manifest.json'), join(outDir, 'client-manifest.json'));
  copyFileSync(join(clientDir, 'manifest.json.sig'), join(outDir, 'client-manifest.json.sig'));
  for (const n of ['install.sh', 'install.ps1']) copyFileSync(join(installDir, n), join(outDir, n));
  const entries = readdirSync(clientDir).sort().map((name) => ({ name, data: readFileSync(join(clientDir, name)), mode: 0o644 }));
  writeFileSync(join(outDir, `client-${version}.tar.gz`), writeTarGz(entries));
  const ctx = await makeRelayContext({ clientDir, allowDev, ...(root ? { root } : {}), ...(keys ? { keys } : {}) });
  writeFileSync(join(outDir, `relay-context-${version}.tar.gz`), ctx.bytes);
  const sums = readdirSync(outDir).sort().map((f) => `${sha(readFileSync(join(outDir, f)))}  ${f}`).join('\n') + '\n';
  writeFileSync(join(outDir, 'SHA256SUMS'), sums);
  const v = await verifyReleaseDir({ dir: outDir, allowDev, ...(keys ? { keys } : {}), ...(installerKeys ? { installerKeys } : {}) });
  if (!v.ok) throw new Error(`the staged release does not verify:\n  ${v.problems.join('\n  ')}`);
  return { out: outDir, version, sums };
}

async function main(argv) {
  const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const clientDir = opt('--client'); const componentZip = opt('--component-zip'); const componentManifest = opt('--component-manifest'); const out = opt('--out');
  if (!clientDir || !componentZip || !componentManifest || !out) { console.error('usage: stage-release.mjs --client <signed client dir> --component-zip <zip> --component-manifest <manifest.json> --out <dir> [--allow-dev-key]'); process.exit(2); }
  try {
    const r = await stageRelease({ clientDir: resolve(clientDir), componentZip: resolve(componentZip), componentManifest: resolve(componentManifest), out, allowDev: argv.includes('--allow-dev-key') });
    console.log(`staged ${r.version} in ${r.out} and verified it:\n${r.sums}`);
  } catch (e) { console.error(`stage-release: ${e.message}`); process.exit(1); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main(process.argv.slice(2));

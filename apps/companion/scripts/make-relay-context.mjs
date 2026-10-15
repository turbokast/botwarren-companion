#!/usr/bin/env node
/**
 * Builds the RELAY IMAGE INPUTS of a release: one deterministic tar.gz that holds everything `docker build -f Dockerfile.relay .` needs, including the
 * SIGNED web client the relay serves. The operator of the relay verifies the archive (hash, GitHub build attestation) and builds the image from it,
 * instead of building from a checkout. Run from the public repository (it expects its layout).
 *
 *   node apps/companion/scripts/make-relay-context.mjs --client <signed client dir> --out <relay-context-X.Y.Z.tar.gz> [--allow-dev-key]
 *
 * Refuses a client that is not signed, or whose signature does not verify against the pinned component keys. Contents (and nothing else):
 *   Dockerfile.relay, package.json, pnpm-lock.yaml, pnpm-workspace.yaml, tsconfig.base.json,
 *   apps/relay/{package.json,tsconfig.json,src/**}, apps/companion/{package.json,src/protocol/**}, client/** (the signed client), CONTEXT.json
 * Same inputs => same bytes (sorted entries, fixed timestamps, no owner). Licence: Apache-2.0.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeTarGz } from '../vendor/agent/src/update/archive.ts';
import { releaseKeys, verifySig } from '../client/scripts/lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const posix = (p) => p.split(/[\\/]/).join('/');

function walk(dir, base, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (['node_modules', 'dist', 'coverage'].includes(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, base, acc); else if (e.isFile()) acc.push(posix(relative(base, p)));
  }
  return acc;
}

/** @returns {{ bytes: Buffer, files: Record<string, string>, version: string }} */
export async function makeRelayContext({ root = resolve(here, '..', '..', '..'), clientDir, dockerfile = 'deploy/Dockerfile.relay', allowDev = false, keys }) {
  const client = resolve(clientDir);
  for (const f of ['manifest.json', 'manifest.json.sig', 'index.html', 'loader.js']) if (!existsSync(join(client, f))) throw new Error(`the client directory has no ${f}: the relay image must contain the SIGNED client`);
  const manifestBytes = readFileSync(join(client, 'manifest.json'));
  const pinned = keys ?? (await releaseKeys({ allowDev }));
  if (!verifySig(manifestBytes, readFileSync(join(client, 'manifest.json.sig'), 'utf8'), pinned)) throw new Error('the client signature does not verify against the pinned component keys; refusing to package it');
  const m = JSON.parse(manifestBytes.toString('utf8'));
  // every file the signed manifest lists must be there with the stated hash (the loader would refuse the client otherwise)
  for (const f of [m.entry.js, m.entry.css, m.loader]) if (sha(readFileSync(join(client, f.path))) !== f.sha256) throw new Error(`client file ${f.path} does not match the signed manifest`);

  /** @type {Map<string, Buffer>} */
  const files = new Map();
  const add = (name, data) => files.set(name, Buffer.isBuffer(data) ? data : Buffer.from(data));
  add('Dockerfile.relay', readFileSync(resolve(root, dockerfile)));
  for (const f of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json']) add(f, readFileSync(resolve(root, f)));
  for (const f of ['package.json', 'tsconfig.json']) add(`apps/relay/${f}`, readFileSync(resolve(root, 'apps/relay', f)));
  for (const f of walk(resolve(root, 'apps/relay/src'), resolve(root, 'apps/relay'))) add(`apps/relay/${f}`, readFileSync(resolve(root, 'apps/relay', f)));
  add('apps/companion/package.json', readFileSync(resolve(root, 'apps/companion/package.json')));
  for (const f of walk(resolve(root, 'apps/companion/src/protocol'), resolve(root, 'apps/companion'))) add(`apps/companion/${f}`, readFileSync(resolve(root, 'apps/companion', f)));
  for (const f of walk(client, client)) add(`client/${f}`, readFileSync(join(client, f)));

  const hashes = Object.fromEntries([...files].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, sha(v)]));
  const ctx = { schema: 1, kind: 'botwarren-relay-context', version: m.version, clientBuild: m.build, ...(m.commit ? { commit: m.commit } : {}), files: hashes };
  add('CONTEXT.json', JSON.stringify(ctx, null, 2) + '\n');
  const bytes = writeTarGz([...files].map(([name, data]) => ({ name, data, mode: 0o644 })));
  return { bytes, files: hashes, version: m.version };
}

async function main(argv) {
  const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const clientDir = opt('--client'); const out = opt('--out');
  if (!clientDir || !out) { console.error('usage: make-relay-context.mjs --client <signed client dir> --out <file.tar.gz> [--allow-dev-key]'); process.exit(2); }
  try {
    const r = await makeRelayContext({ clientDir, allowDev: argv.includes('--allow-dev-key') });
    writeFileSync(resolve(out), r.bytes);
    console.log(`wrote ${resolve(out)}: relay ${r.version}, ${Object.keys(r.files).length} files, sha256 ${sha(r.bytes)}`);
  } catch (e) { console.error(`make-relay-context: ${e.message}`); process.exit(1); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main(process.argv.slice(2));

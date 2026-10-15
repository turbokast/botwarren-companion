#!/usr/bin/env node
/**
 * node client/scripts/build.mjs [--out dist-client] [--allow-dev] [--extra-key id=spki-base64] [--sign-key <pem> --key-id <id>] [--kms <resource> --key-id <id>]
 *
 * Builds the web client and writes manifest.json. Signing is separate in production (the KMS key lives in the release workflow:
 * client/scripts/sign.mjs). `--sign-key` signs with a local DEV key (tests and rehearsals); the key must then also be given with --extra-key.
 */
import { createPublicKey } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildClient, clientRoot, releaseKeys, signClient } from './lib.mjs';

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const optAll = (n) => args.flatMap((a, i) => (a === n ? [args[i + 1]] : []));
const out = opt('--out') ?? resolve(clientRoot, '../dist-client');
const extra = optAll('--extra-key').map((a) => { const [id, spki] = a.split('='); return { id, spki }; });
const keys = await releaseKeys({ allowDev: args.includes('--allow-dev'), extra });
const version = JSON.parse(readFileSync(resolve(clientRoot, '../package.json'), 'utf8')).version;
const now = process.env.SOURCE_DATE_EPOCH ? Number(process.env.SOURCE_DATE_EPOCH) * 1000 : Date.now();
const { manifest } = await buildClient({ outDir: out, keys, version, commit: process.env.GIT_COMMIT ?? '', now });
console.log(`built ${out}: version ${manifest.version}, build ${manifest.build}, ${keys.length} pinned key(s): ${keys.map((k) => k.id).join(', ')}`);
if (opt('--sign-key')) {
  const p = resolve(opt('--sign-key'));
  if (process.platform !== 'win32' && (statSync(p).mode & 0o077) !== 0) { console.error('refusing: key file is readable by others'); process.exit(2); }
  const pem = readFileSync(p);
  const spki = createPublicKey(pem).export({ type: 'spki', format: 'der' }).toString('base64');
  if (!keys.some((k) => k.id === opt('--key-id') && k.spki === spki)) { console.error('refusing: that key is not among the pinned keys given to the loader'); process.exit(2); }
  signClient({ outDir: out, privateKeyPem: pem, keyId: opt('--key-id'), keys });
  console.log('signed with a local key file (DEV only).');
}

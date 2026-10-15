#!/usr/bin/env node
/**
 * VENDORED FILE: scripts/component-sign.mjs of the Botwarren ship agent (https://github.com/turbokast/botwarren-ship), copied verbatim when this repository was exported;
 * the only edit is this header. The Companion shares the agent's release trust chain (the pinned public release keys, the manifest schema and
 * verifier, the Cloud KMS signer) on purpose: one key, one verifier. Do not edit here: changes are made in the ship agent repository and re-vendored.
 * Copyright 2026 TurboKast Ltd. Licensed under the Apache License, Version 2.0 (see the LICENSE file at the repository root).
 */
/**
 * Signs a COMPONENT manifest (the optional Botwarren Companion) with the COMPONENT signing key (a different key from the one that signs agent updates), in its own signature domain
 * ("botwarren-component-v1\0": a signed agent manifest can never be replayed as a component manifest).
 *
 *   node scripts/component-sign.mjs --kms <key version resource> --key-id kms-comp-2026a <manifest.json>      writes <manifest.json>.sig
 *   node scripts/component-sign.mjs --key <private-key.pem> --key-id <id> <manifest.json>                DEV key file (tests, rehearsals)
 *
 * The manifest is parsed with the client's own schema first (a manifest the agent would refuse is never signed), the production key id must be a
 * pinned non-dev COMPONENT key (never the agent-update release key), and the fresh signature is re-verified against the PINNED public key before a file is written. Run by the release
 * workflow's gated sign step. NOT run as part of the change that added it.
 */
import { createPublicKey } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMPONENT_PUBLIC_KEYS, roleOf } from '../src/update/keys.ts';
import { COMPONENT_DOMAIN, ComponentManifest } from '../src/component/manifest.ts';
import { signComponentBytes, verifyComponentManifest } from '../src/component/verify.ts';
import { accessToken, kmsSign } from './lib/kms.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const fail = (m, code = 2) => { console.error(m); process.exit(code); };
const file = args.find((a, i) => !a.startsWith('--') && !['--kms', '--key', '--key-id'].includes(args[i - 1]));
const kms = opt('--kms'); const keyPath = opt('--key'); const keyId = opt('--key-id');
if (!file || !keyId || (!kms && !keyPath) || (kms && keyPath)) fail('usage: component-sign.mjs (--kms <key version resource> | --key <pem>) --key-id <id> <manifest.json>');

const bytes = readFileSync(file);
let m;
try { m = ComponentManifest.parse(JSON.parse(bytes.toString('utf8'))); } catch (e) { fail(`refusing: the manifest does not match the schema the agent enforces (${String(e.message).slice(0, 200)})`); }
if (bytes.length > 60_000) fail('refusing: the manifest is too large for the release key to sign');

let sigText; let keys;
if (kms) {
  const key = COMPONENT_PUBLIC_KEYS.find((k) => k.id === keyId);
  if (!key || key.dev || roleOf(key) !== 'component') fail(`refusing: ${keyId} is not a pinned, non-dev COMPONENT key (src/update/keys.ts COMPONENT_PUBLIC_KEYS; the agent-update release key never signs a component)`);
  if (key.placeholder) fail(`refusing: ${keyId} is still the PLACEHOLDER public key in src/update/keys.ts: paste the real public key of the component-signing KMS key first`);
  const sig = await kmsSign({ resource: kms, message: Buffer.concat([COMPONENT_DOMAIN, bytes]), token: accessToken() });
  sigText = JSON.stringify({ alg: 'ed25519', keyId, sig: sig.toString('base64') }) + '\n';
  keys = [key];
} else {
  const key = resolve(keyPath);
  if (key === repoRoot || key.startsWith(repoRoot + sep)) fail('refusing: the key path is inside the repository');
  if (process.platform !== 'win32' && (statSync(key).mode & 0o077) !== 0) fail(`refusing: ${key} is readable by others (chmod 600)`);
  const pem = readFileSync(key);
  sigText = signComponentBytes(bytes, pem, keyId);
  keys = [{ id: keyId, spki: createPublicKey(pem).export({ type: 'spki', format: 'der' }).toString('base64'), dev: true, role: 'component' }];
  console.log(`public key (SPKI, base64): ${keys[0].spki}`);
}
const check = verifyComponentManifest(bytes, sigText, { component: 'companion', keys, now: new Date(), allowDev: !kms, highestSeen: 0, epoch: m.epoch });
if (!check.ok && check.code !== 'expired') { console.error(`the fresh signature does not verify (${check.code}); nothing written`); process.exit(1); }
writeFileSync(`${file}.sig`, sigText);
console.log(`signed ${file} (component ${m.component}, version ${m.channels.stable}) with "${keyId}" -> ${file}.sig`);

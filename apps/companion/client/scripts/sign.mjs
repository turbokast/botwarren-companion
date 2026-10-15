#!/usr/bin/env node
/**
 * Production signing of the web client manifest with the COMPONENT signing key (Cloud KMS `component-signing`, pinned as `kms-comp-2026a`),
 * a DIFFERENT key from the one that signs the ship agent's updates (docs/RELEASING.md). Domain-separated: "botwarren-client-v1\0" || manifest bytes.
 *
 *   node client/scripts/sign.mjs --kms <key version resource> --key-id kms-comp-2026a [--dir dist-client]
 *
 * Reuses the ship agent's KMS client (apps/shipagent/scripts/lib/kms.mjs); the fresh signature is re-verified against the pinned
 * public key before anything is written. Run by the release workflow's gated sign step; NOT run in this change.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { accessToken, kmsSign } from '../../vendor/agent/scripts/lib/kms.mjs';
import { SIGNATURE_DOMAIN, clientRoot, placeholderKeyIds, releaseKeys, verifySig } from './lib.mjs';

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const kms = opt('--kms'); const keyId = opt('--key-id');
const dir = resolve(opt('--dir') ?? resolve(clientRoot, '../dist-client'));
if (!kms || !keyId) { console.error('usage: sign.mjs --kms <key version resource> --key-id <id> [--dir dist-client]'); process.exit(2); }
const keys = await releaseKeys({});
if (!keys.some((k) => k.id === keyId)) { console.error(`refusing: ${keyId} is not a pinned, non-dev COMPONENT key (the ship agent's update key never signs this client)`); process.exit(2); }
if ((await placeholderKeyIds()).includes(keyId)) { console.error(`refusing: ${keyId} is still the PLACEHOLDER public key (ship agent src/update/keys.ts): paste the real public key of the component-signing KMS key first`); process.exit(2); }
const bytes = readFileSync(resolve(dir, 'manifest.json'));
const m = JSON.parse(bytes.toString('utf8'));
if (m.schema !== 1 || m.kind !== 'botwarren-companion-client') { console.error('refusing: not a client manifest'); process.exit(2); }
const sig = await kmsSign({ resource: kms, message: Buffer.concat([SIGNATURE_DOMAIN, bytes]), token: accessToken() });
const sigText = JSON.stringify({ alg: 'ed25519', keyId, sig: sig.toString('base64') }) + '\n';
if (!verifySig(bytes, sigText, keys)) { console.error('the fresh signature does not verify against the pinned key; nothing written'); process.exit(1); }
writeFileSync(resolve(dir, 'manifest.json.sig'), sigText);
console.log(`signed ${resolve(dir, 'manifest.json')} with ${keyId} (Cloud KMS, verified against the pinned public key)`);

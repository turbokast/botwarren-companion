/**
 * VENDORED FILE: scripts/lib/kms.mjs of the Botwarren ship agent (https://github.com/turbokast/botwarren-ship), copied verbatim when this repository was exported;
 * the only edit is this header. The Companion shares the agent's release trust chain (the pinned public release keys, the manifest schema and
 * verifier, the Cloud KMS signer) on purpose: one key, one verifier. Do not edit here: changes are made in the ship agent repository and re-vendored.
 * Copyright 2026 TurboKast Ltd. Licensed under the Apache License, Version 2.0 (see the LICENSE file at the repository root).
 */
/**
 * Minimal Google Cloud KMS client (REST, global fetch, no dependencies) for signing a release manifest with a non-exportable
 * Ed25519 key (EC_SIGN_ED25519). Used by scripts/release-sign.mjs --kms, in the release workflow (token from the OIDC federation) and
 * by the owner's emergency run (token from `gcloud auth print-access-token`).
 *
 * Ed25519 in Cloud KMS is PureEdDSA over the `data` field (not a digest), limited to 64 KiB (65,536 bytes) per call. The signed
 * message is the 22-byte domain prefix plus the manifest, so a manifest must stay under MAX_SIGNABLE_MANIFEST_BYTES (manifest.ts).
 * Integrity: the request carries a CRC32C of the data and the response must confirm it and carry a matching CRC32C of the signature.
 */
import { execFileSync } from 'node:child_process';
import { roleOf } from '../../src/update/keys.ts';
import { MAX_SIGNABLE_MANIFEST_BYTES, Manifest } from '../../src/update/manifest.ts';
import { SIGNATURE_DOMAIN, verifyManifest } from '../../src/update/verify.ts';

const RESOURCE_RE = /^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/locations\/[a-z0-9-]+\/keyRings\/[A-Za-z0-9_-]{1,63}\/cryptoKeys\/[A-Za-z0-9_-]{1,63}\/cryptoKeyVersions\/\d{1,6}$/;
export const isKmsVersionResource = (s) => RESOURCE_RE.test(s);

const TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0x82f63b78 : c >>> 1; t[i] = c; }
  return t;
})();
/** CRC32C (Castagnoli) as an unsigned integer */
export function crc32c(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

const isLoopback = (h) => h === 'localhost' || h === '127.0.0.1' || h === '[::1]';

function endpointOf(env) {
  const e = env.BOTWARREN_KMS_ENDPOINT || 'https://cloudkms.googleapis.com';
  const u = new URL(e);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopback(u.hostname))) throw new Error('the KMS endpoint must be https (http only for loopback test servers)');
  return u.origin;
}

/** OAuth access token: from the environment (the workflow's federated token) or, for the owner's local emergency use, gcloud. Never printed. */
export function accessToken(env = process.env) {
  const t = env.GOOGLE_OAUTH_ACCESS_TOKEN || env.CLOUDSDK_AUTH_ACCESS_TOKEN;
  if (t) return t;
  try { return execFileSync(env.GCLOUD || 'gcloud', ['auth', 'print-access-token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { throw new Error('no access token: set GOOGLE_OAUTH_ACCESS_TOKEN (the workflow does) or run `gcloud auth login` as an account allowed to sign'); }
}

async function call(method, url, token, body) {
  const res = await fetch(url, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  if (!res.ok) { let reason = ''; try { reason = JSON.parse(text).error?.status ?? ''; } catch { /* not json */ } throw new Error(`Cloud KMS ${method} failed: HTTP ${res.status} ${reason}`.trim()); }
  return JSON.parse(text);
}

/** Signs `message` (Buffer, at most 65,536 bytes) with the key version. Returns the raw 64-byte Ed25519 signature as a Buffer. */
export async function kmsSign({ resource, message, token, env = process.env }) {
  if (!isKmsVersionResource(resource)) throw new Error('--kms must be a key VERSION resource: projects/<p>/locations/<l>/keyRings/<r>/cryptoKeys/<k>/cryptoKeyVersions/<n>');
  if (message.length > 65_536) throw new Error(`the message is ${message.length} bytes; Cloud KMS signs at most 65,536`);
  const r = await call('POST', `${endpointOf(env)}/v1/${resource}:asymmetricSign`, token, { data: message.toString('base64'), dataCrc32c: String(crc32c(message)) });
  if (r.name && r.name !== resource) throw new Error('Cloud KMS answered for a different key version than the one requested');
  if (r.verifiedDataCrc32c !== true) throw new Error('Cloud KMS did not confirm the request checksum; refusing the signature');
  const sig = Buffer.from(String(r.signature ?? ''), 'base64');
  if (sig.length !== 64) throw new Error(`unexpected signature length ${sig.length} (an Ed25519 signature is 64 bytes)`);
  if (r.signatureCrc32c !== undefined && String(r.signatureCrc32c) !== String(crc32c(sig))) throw new Error('signature checksum mismatch (corrupted in transit); refusing the signature');
  return sig;
}

/** SPKI (base64) of the key version's public key, via the REST API (PEM response). */
export async function kmsPublicKeySpki({ resource, token, env = process.env }) {
  if (!isKmsVersionResource(resource)) throw new Error('--kms must be a key VERSION resource');
  const r = await call('GET', `${endpointOf(env)}/v1/${resource}/publicKey`, token);
  if (r.algorithm !== 'EC_SIGN_ED25519') throw new Error(`the key version's algorithm is ${r.algorithm}, not EC_SIGN_ED25519`);
  const b64 = String(r.pem ?? '').replace(/-----(BEGIN|END) PUBLIC KEY-----/g, '').replace(/\s+/g, '');
  const der = Buffer.from(b64, 'base64');
  if (der.length !== 44) throw new Error('unexpected public key encoding');
  return der.toString('base64');
}

/**
 * The whole production signing step: refuse anything the agent would refuse or the key must not sign, sign with Cloud KMS, and verify the
 * fresh signature against the PINNED public key (`pinned` = src/update/keys.ts) before returning it. Returns the contents of manifest.json.sig.
 * `keyId` must be a pinned, non-dev RELEASE key: a typo or a wrong key can never produce a file.
 */
export async function signManifestKms({ bytes, resource, keyId, pinned, token, env = process.env }) {
  const key = pinned.find((k) => k.id === keyId);
  if (!key || key.dev || roleOf(key) !== 'release') throw new Error(`${keyId} is not a pinned, non-dev RELEASE key (src/update/keys.ts)`);
  if (bytes.length > MAX_SIGNABLE_MANIFEST_BYTES) throw new Error(`the manifest is ${bytes.length} bytes; the release key signs at most ${MAX_SIGNABLE_MANIFEST_BYTES} (Cloud KMS limit 64 KiB). Prune old releases (--keep-releases).`);
  let parsed;
  try { parsed = Manifest.parse(JSON.parse(bytes.toString('utf8'))); } catch (e) { throw new Error(`the manifest does not match the schema the client enforces (${String(e.message).slice(0, 200)})`, { cause: e }); }
  const sig = await kmsSign({ resource, message: Buffer.concat([SIGNATURE_DOMAIN, bytes]), token, env });
  const sigText = JSON.stringify({ alg: 'ed25519', keyId, sig: sig.toString('base64') }) + '\n';
  const check = verifyManifest(bytes, sigText, { keys: [key], now: new Date(), highestSeen: 0, epoch: parsed.epoch });
  if (!check.ok && check.code !== 'expired') throw new Error(`the fresh signature does not verify against the PINNED public key of ${keyId} (${check.code}); nothing written`);
  return sigText;
}

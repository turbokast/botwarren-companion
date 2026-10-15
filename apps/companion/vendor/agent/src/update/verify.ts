/**
 * VENDORED FILE: src/update/verify.ts of the Botwarren ship agent (https://github.com/turbokast/botwarren-ship), copied verbatim when this repository was exported;
 * the only edit is this header. The Companion shares the agent's release trust chain (the pinned public release keys, the manifest schema and
 * verifier, the Cloud KMS signer) on purpose: one key, one verifier. Do not edit here: changes are made in the ship agent repository and re-vendored.
 * Copyright 2026 TurboKast Ltd. Licensed under the Apache License, Version 2.0 (see the LICENSE file at the repository root).
 */
/**
 * Manifest signature verification. Ed25519, detached signature over the EXACT manifest bytes (no JSON canonicalisation),
 * domain-separated so a signature for some other purpose can never validate as a manifest.
 *
 *   manifest.json.sig = {"alg":"ed25519","keyId":"<id>","sig":"<base64>"}
 *   signed message    = "botwarren-manifest-v1\0" || manifest bytes
 *
 * Order of checks: signature FIRST (nothing from an unsigned document is parsed), then schema, then expiry, then the trust
 * epoch, then the anti-rollback rule. Only RELEASE keys sign manifests (a recovery key's signature is refused), a revoked key id is
 * refused, and a release key cannot move `manifestVersion` by more than MAX_VERSION_STEP. Any failure returns a code; nothing is installed.
 */
import { createPublicKey, createPrivateKey, sign as edSign, verify as edVerify } from 'node:crypto';
import { z } from 'zod';
import { Manifest, MAX_MANIFEST_BYTES } from './manifest.ts';
import { PINNED_PUBLIC_KEYS, roleOf, type PinnedKey } from './keys.ts';

export const SIGNATURE_DOMAIN = Buffer.from('botwarren-manifest-v1\0', 'utf8');

/** An online release key may raise manifestVersion by at most this much over the highest accepted one (a freeze attack needs a huge jump). */
export const MAX_VERSION_STEP = 1000;

export type VerifyCode =
  | 'too_large' | 'bad_signature_file' | 'unknown_key' | 'dev_key_refused' | 'key_expired' | 'key_revoked' | 'wrong_key_role' | 'bad_signature'
  | 'malformed' | 'expired' | 'epoch_rollback' | 'epoch_unknown' | 'rollback' | 'version_jump';
export type VerifyResult = { ok: true; manifest: Manifest; keyId: string } | { ok: false; code: VerifyCode };

const SigFile = z.object({ alg: z.literal('ed25519'), keyId: z.string().min(1).max(64), sig: z.string().regex(/^[A-Za-z0-9+/]{86}==$/) }).strict();

export interface VerifyOptions {
  keys?: readonly PinnedKey[];
  now: Date;
  /** accept keys flagged `dev` (tests, rehearsals) */
  allowDev?: boolean;
  /** highest manifestVersion ever accepted on this install IN THE CURRENT EPOCH (persisted); lower is a rollback */
  highestSeen: number;
  /** the trust epoch this install currently trusts (persisted, raised only by a recovery-signed keys document). Default 1. */
  epoch?: number;
  /** key ids revoked by a recovery-signed keys document (persisted) */
  revoked?: readonly string[];
}

export function verifyManifest(bytes: Buffer, sigText: string, o: VerifyOptions): VerifyResult {
  if (bytes.length > MAX_MANIFEST_BYTES) return { ok: false, code: 'too_large' };
  let sigFile: z.infer<typeof SigFile>;
  try { sigFile = SigFile.parse(JSON.parse(sigText)); } catch { return { ok: false, code: 'bad_signature_file' }; }
  const keys = o.keys ?? PINNED_PUBLIC_KEYS;
  const key = keys.find((k) => k.id === sigFile.keyId);
  if (!key) return { ok: false, code: 'unknown_key' };
  if (o.revoked?.includes(key.id)) return { ok: false, code: 'key_revoked' };
  if (roleOf(key) !== 'release') return { ok: false, code: 'wrong_key_role' };
  if (key.dev && !o.allowDev) return { ok: false, code: 'dev_key_refused' };
  if (key.notAfter && Date.parse(key.notAfter) < o.now.getTime()) return { ok: false, code: 'key_expired' };
  let valid: boolean;
  try {
    const pub = createPublicKey({ key: Buffer.from(key.spki, 'base64'), format: 'der', type: 'spki' });
    valid = edVerify(null, Buffer.concat([SIGNATURE_DOMAIN, bytes]), pub, Buffer.from(sigFile.sig, 'base64'));
  } catch { valid = false; }
  if (!valid) return { ok: false, code: 'bad_signature' };

  let manifest: Manifest;
  try { manifest = Manifest.parse(JSON.parse(bytes.toString('utf8'))); } catch { return { ok: false, code: 'malformed' }; }
  if (Date.parse(manifest.expires) <= o.now.getTime()) return { ok: false, code: 'expired' };
  const epoch = o.epoch ?? 1;
  if (manifest.epoch < epoch) return { ok: false, code: 'epoch_rollback' };
  if (manifest.epoch > epoch) return { ok: false, code: 'epoch_unknown' }; // only a recovery-signed keys document raises the epoch
  if (manifest.manifestVersion < o.highestSeen) return { ok: false, code: 'rollback' };
  if (o.highestSeen > 0 && manifest.manifestVersion > o.highestSeen + MAX_VERSION_STEP) return { ok: false, code: 'version_jump' };
  return { ok: true, manifest, keyId: key.id };
}

/** Used by scripts/release-sign.mjs. `privateKeyPem` is PKCS#8 PEM. */
export function signManifestBytes(bytes: Buffer, privateKeyPem: string | Buffer, keyId: string): string {
  const priv = createPrivateKey(privateKeyPem);
  const sig = edSign(null, Buffer.concat([SIGNATURE_DOMAIN, bytes]), priv).toString('base64');
  return JSON.stringify({ alg: 'ed25519', keyId, sig }) + '\n';
}

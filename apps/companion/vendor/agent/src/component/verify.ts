/**
 * VENDORED FILE: src/component/verify.ts of the Botwarren ship agent (https://github.com/turbokast/botwarren-ship), copied verbatim when this repository was exported;
 * the only edit is this header. The Companion shares the agent's release trust chain (the pinned public release keys, the manifest schema and
 * verifier, the Cloud KMS signer) on purpose: one key, one verifier. Do not edit here: changes are made in the ship agent repository and re-vendored.
 * Copyright 2026 TurboKast Ltd. Licensed under the Apache License, Version 2.0 (see the LICENSE file at the repository root).
 */
/**
 * Component manifest verification. Order of checks mirrors update/verify.ts: signature FIRST (nothing from an unsigned document is parsed),
 * then schema, then expiry, the trust epoch and the anti-rollback rule, then that it is for THIS component. Only pinned COMPONENT keys sign
 * (a release key's or a recovery key's signature is refused), revoked ids are refused, dev keys only when explicitly allowed.
 */
import { createPublicKey, createPrivateKey, sign as edSign, verify as edVerify } from 'node:crypto';
import { z } from 'zod';
import { COMPONENT_PUBLIC_KEYS, roleOf, type PinnedKey } from '../update/keys.ts';
import { MAX_VERSION_STEP } from '../update/verify.ts';
import { COMPONENT_DOMAIN, ComponentManifest, MAX_COMPONENT_MANIFEST_BYTES, type ComponentName } from './manifest.ts';

export type ComponentVerifyCode =
  | 'too_large' | 'bad_signature_file' | 'unknown_key' | 'dev_key_refused' | 'key_expired' | 'key_revoked' | 'wrong_key_role' | 'bad_signature'
  | 'malformed' | 'expired' | 'epoch_rollback' | 'epoch_unknown' | 'rollback' | 'version_jump' | 'wrong_component';
export type ComponentVerifyResult = { ok: true; manifest: ComponentManifest; keyId: string } | { ok: false; code: ComponentVerifyCode };

const SigFile = z.object({ alg: z.literal('ed25519'), keyId: z.string().min(1).max(64), sig: z.string().regex(/^[A-Za-z0-9+/]{86}==$/) }).strict();

export interface ComponentVerifyOptions {
  component: ComponentName;
  keys?: readonly PinnedKey[];
  now: Date;
  allowDev?: boolean;
  highestSeen: number;
  epoch?: number;
  revoked?: readonly string[];
}

export function verifyComponentManifest(bytes: Buffer, sigText: string, o: ComponentVerifyOptions): ComponentVerifyResult {
  if (bytes.length > MAX_COMPONENT_MANIFEST_BYTES) return { ok: false, code: 'too_large' };
  let sf: z.infer<typeof SigFile>;
  try { sf = SigFile.parse(JSON.parse(sigText)); } catch { return { ok: false, code: 'bad_signature_file' }; }
  const key = (o.keys ?? COMPONENT_PUBLIC_KEYS).find((k) => k.id === sf.keyId);
  if (!key) return { ok: false, code: 'unknown_key' };
  if (o.revoked?.includes(key.id)) return { ok: false, code: 'key_revoked' };
  // ONLY component keys verify a component manifest: the agent-update (release) key and the recovery keys are refused here, whatever list was passed
  if (roleOf(key) !== 'component') return { ok: false, code: 'wrong_key_role' };
  if (key.dev && !o.allowDev) return { ok: false, code: 'dev_key_refused' };
  if (key.notAfter && Date.parse(key.notAfter) < o.now.getTime()) return { ok: false, code: 'key_expired' };
  let valid: boolean;
  try {
    valid = edVerify(null, Buffer.concat([COMPONENT_DOMAIN, bytes]), createPublicKey({ key: Buffer.from(key.spki, 'base64'), format: 'der', type: 'spki' }), Buffer.from(sf.sig, 'base64'));
  } catch { valid = false; }
  if (!valid) return { ok: false, code: 'bad_signature' };
  let m: ComponentManifest;
  try { m = ComponentManifest.parse(JSON.parse(bytes.toString('utf8'))); } catch { return { ok: false, code: 'malformed' }; }
  if (Date.parse(m.expires) <= o.now.getTime()) return { ok: false, code: 'expired' };
  const epoch = o.epoch ?? 1;
  if (m.epoch < epoch) return { ok: false, code: 'epoch_rollback' };
  if (m.epoch > epoch) return { ok: false, code: 'epoch_unknown' };
  if (m.manifestVersion < o.highestSeen) return { ok: false, code: 'rollback' };
  if (o.highestSeen > 0 && m.manifestVersion > o.highestSeen + MAX_VERSION_STEP) return { ok: false, code: 'version_jump' };
  if (m.component !== o.component) return { ok: false, code: 'wrong_component' };
  return { ok: true, manifest: m, keyId: key.id };
}

/** release tooling and tests */
export function signComponentBytes(bytes: Buffer, privateKeyPem: string | Buffer, keyId: string): string {
  return JSON.stringify({ alg: 'ed25519', keyId, sig: edSign(null, Buffer.concat([COMPONENT_DOMAIN, bytes]), createPrivateKey(privateKeyPem)).toString('base64') }) + '\n';
}

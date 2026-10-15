/**
 * VENDORED FILE: src/update/keys.ts of the Botwarren ship agent (https://github.com/turbokast/botwarren-ship), copied verbatim when this repository was exported;
 * the only edit is this header. The Companion shares the agent's release trust chain (the pinned public release keys, the manifest schema and
 * verifier, the Cloud KMS signer) on purpose: one key, one verifier. Do not edit here: changes are made in the ship agent repository and re-vendored.
 * Copyright 2026 TurboKast Ltd. Licensed under the Apache License, Version 2.0 (see the LICENSE file at the repository root).
 */
/**
 * Pinned PUBLIC keys (Ed25519, SPKI DER, base64) compiled into the agent. Two roles:
 *
 *  - `release` keys sign `manifest.json` (routine releases). The production release key `kms-2026a` is a NON-EXPORTABLE Cloud KMS key
 *    (Google Cloud KMS, EC_SIGN_ED25519, software protection level) that only the gated `sign-manifest` job of the release workflow can use,
 *    through GitHub OIDC workload identity federation: nobody holds its private half (docs/RELEASING.md).
 *  - `recovery` keys (3, offline, age-encrypted, held in separate places) NEVER sign a manifest: a manifest signed by one is refused.
 *    They sign only the keys document (`keys.json`, see trust.ts): any TWO of the THREE can add or rotate release keys, revoke a release
 *    key, and raise the trust epoch. The recovery set itself changes only with a new agent release.
 *
 *  - `dev: true` keys exist only so the signing pipeline can be tested end to end. The private half is kept OUTSIDE the repository by the
 *    maintainers and is never committed; only the public half below is published. They are refused unless
 *    BOTWARREN_UPDATE_ALLOW_DEV_KEY=1, and never produced by CI. (An attacker who can set that variable on the user's machine already
 *    runs code there.) `scripts/build-release.mjs --release` additionally requires the production and recovery keys to be present.
 */
export type KeyRole = 'release' | 'recovery' | 'component';
export interface PinnedKey {
  id: string;
  /** SPKI DER, base64 */
  spki: string;
  dev: boolean;
  /** default 'release' */
  role?: KeyRole;
  /** a PLACEHOLDER public key whose private half does not exist: nothing may be signed with it (the signing scripts refuse) until the real key is pasted */
  placeholder?: boolean;
  /** ISO date after which the key is no longer trusted (optional) */
  notAfter?: string;
}

export const PINNED_PUBLIC_KEYS: readonly PinnedKey[] = [
  { id: 'dev-1', spki: 'MCowBQYDK2VwAyEAl2YWccFmHULX21drEF3MTegbuK33QvVhabdHCKG5HSc=', dev: true },
  // Production release key: GCP project botwarren-release, key ring botwarren-release (europe-west2), key manifest-signing, version 1.
  { id: 'kms-2026a', spki: 'MCowBQYDK2VwAyEA9wgEUj5KLXm+KZSD9cpJw3B8KmTtGDGL4gudKWPfTuM=', dev: false, role: 'release' },
  // Offline recovery keys (2-of-3 threshold). Generated 2026-10-14 by scripts/recovery-keygen.mjs; private halves are age-encrypted, never in the repo.
  { id: 'recovery-1', spki: 'MCowBQYDK2VwAyEAgh+PRhJvAXPllKqUBsQTCZsJoycIr7hluvOsE4/7qDE=', dev: false, role: 'recovery' },
  { id: 'recovery-2', spki: 'MCowBQYDK2VwAyEATvR3zU+ComOHom/14gbi9EgVvEyEcv8WPjf9X8MG4jE=', dev: false, role: 'recovery' },
  { id: 'recovery-3', spki: 'MCowBQYDK2VwAyEA0o4UlhviMcetJCdw8gpRjnjinf40H10lPNDwlyKgczY=', dev: false, role: 'recovery' },
];

/**
 * COMPONENT signing keys: a SEPARATE pinned set from PINNED_PUBLIC_KEYS above, on purpose. They verify only the optional components the agent can install
 * (the Botwarren Companion: its component manifest, domain `botwarren-component-v1`, and its signed web client, domain `botwarren-client-v1`). Key separation
 * and domain separation both hold, in both directions:
 *  - the component verifier (component/verify.ts) accepts ONLY role `component` keys, so a manifest signed by the agent-update key is `unknown_key`/`wrong_key_role`;
 *  - the agent-update verifier (update/verify.ts) accepts ONLY role `release` keys, so a manifest signed by a component key is `unknown_key`/`wrong_key_role`;
 *  - a keys document cannot register a component key as an agent release key (trust.ts `conflicts_with_pinned`), and keys it adds are never component keys.
 * The production component key `kms-comp-2026a` is a non-exportable Cloud KMS key (`component-signing`, EC_SIGN_ED25519) usable only by the service account
 * `companion-signer` through GitHub OIDC from the Companion repository's release workflow. Nobody holds its private half.
 */
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
/** a raw 32-byte Ed25519 public key (base64) as the SPKI DER (base64) the rest of the code pins */
export const spkiFromRaw = (rawB64: string): string => {
  const raw = Buffer.from(rawB64, 'base64');
  if (raw.length !== 32) throw new Error('an Ed25519 public key is 32 raw bytes');
  return Buffer.concat([SPKI_ED25519_PREFIX, raw]).toString('base64');
};

/**
 * The public key of the Cloud KMS key `component-signing` (key ring botwarren-release, europe-west2, version 1), as the raw 32-byte Ed25519 key (base64);
 * the SPKI form pinned below is derived from it. Read it with
 *   gcloud kms keys versions get-public-key 1 --key component-signing --keyring botwarren-release --location europe-west2 --project botwarren-release
 * (a PEM of an SPKI: the last 32 bytes of its DER are this value). Pinned 2026-10-15.
 * Rotation after a compromise: create a new key version or key, add it here under a NEW id (kms-comp-2026b) in a new agent release (a keys document
 * can revoke an id but cannot add component keys), and switch the Companion release workflow's KMS_KEY_ID. Both ids may be pinned together during the
 * overlap; the recovery-signed keys document revokes the compromised id (kms-comp-2026a) for installed agents.
 */
export const COMPONENT_KEY_RAW_B64 = 'Rv4WZoMAzdHQbQkIvHZpgGD/Pa6GXtwXN1Ql66vUVD4=';
/** true only while COMPONENT_KEY_RAW_B64 is a stand-in whose private half does not exist: the signing scripts and the release workflow refuse it */
export const COMPONENT_KEY_IS_PLACEHOLDER = false;

export const COMPONENT_PUBLIC_KEYS: readonly PinnedKey[] = [
  // Development key for rehearsals and tests only: the private half is kept OUTSIDE the repository by the maintainers (never committed). Refused unless dev keys are allowed.
  { id: 'dev-comp-1', spki: 'MCowBQYDK2VwAyEAQeJ8wcLQu2JfaeXPKj7yZd5JDJP3oylaKpQihLK0Lio=', dev: true, role: 'component' },
  // Production component key: GCP project botwarren-release, key ring botwarren-release (europe-west2), key component-signing, version 1 (service account companion-signer).
  { id: 'kms-comp-2026a', spki: spkiFromRaw(COMPONENT_KEY_RAW_B64), dev: false, role: 'component', ...(COMPONENT_KEY_IS_PLACEHOLDER ? { placeholder: true } : {}) },
];

/** minimum number of DISTINCT recovery signatures a keys document needs */
export const RECOVERY_THRESHOLD = 2;

export const roleOf = (k: PinnedKey): KeyRole => k.role ?? 'release';
export const componentKeys = (keys: readonly PinnedKey[]): PinnedKey[] => keys.filter((k) => roleOf(k) === 'component');
export const recoveryKeys = (keys: readonly PinnedKey[]): PinnedKey[] => keys.filter((k) => roleOf(k) === 'recovery');

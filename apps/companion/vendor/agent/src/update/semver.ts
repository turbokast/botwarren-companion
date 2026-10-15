/**
 * VENDORED FILE: src/update/semver.ts of the Botwarren ship agent (https://github.com/turbokast/botwarren-ship), copied verbatim when this repository was exported;
 * the only edit is this header. The Companion shares the agent's release trust chain (the pinned public release keys, the manifest schema and
 * verifier, the Cloud KMS signer) on purpose: one key, one verifier. Do not edit here: changes are made in the ship agent repository and re-vendored.
 * Copyright 2026 TurboKast Ltd. Licensed under the Apache License, Version 2.0 (see the LICENSE file at the repository root).
 */
/** Strict x.y.z versions only (no prerelease / build metadata): a manifest with anything else is rejected. */
const RE = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;

export function isVersion(v: unknown): v is string { return typeof v === 'string' && RE.test(v); }

export function parseVersion(v: string): [number, number, number] {
  const m = RE.exec(v);
  if (!m) throw new Error('invalid version');
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** negative, 0, positive like Array.sort */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a); const y = parseVersion(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
}

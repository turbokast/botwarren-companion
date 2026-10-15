/**
 * VENDORED FILE: src/update/manifest.ts of the Botwarren ship agent (https://github.com/turbokast/botwarren-ship), copied verbatim when this repository was exported;
 * the only edit is this header. The Companion shares the agent's release trust chain (the pinned public release keys, the manifest schema and
 * verifier, the Cloud KMS signer) on purpose: one key, one verifier. Do not edit here: changes are made in the ship agent repository and re-vendored.
 * Copyright 2026 TurboKast Ltd. Licensed under the Apache License, Version 2.0 (see the LICENSE file at the repository root).
 */
/**
 * Release manifest (signed, detached signature; see verify.ts). The manifest is the ONLY source of truth for what may
 * be installed: nothing is downloaded or executed that is not listed here with a matching sha256.
 */
import { z } from 'zod';
import { isVersion } from './semver.ts';

export const PLATFORMS = ['win-x64', 'win-arm64', 'mac-arm64', 'mac-x64', 'linux-x64', 'linux-arm64'] as const;
export const Platform = z.enum(PLATFORMS);
export type Platform = z.infer<typeof Platform>;

export const Version = z.string().refine(isVersion, 'x.y.z');
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

export const Artifact = z.object({
  /** absolute https URL, or a path relative to the manifest's base URL */
  url: z.string().min(1).max(1024),
  sha256: Sha256,
  size: z.number().int().min(1).max(250 * 1024 * 1024),
}).strict();
export type Artifact = z.infer<typeof Artifact>;

export const Release = z.object({
  /** git commit the release was built from (provenance; reproducible build check) */
  commit: z.string().regex(/^[0-9a-f]{7,40}$/).optional(),
  /** agent <-> server protocol range this release speaks */
  protocol: z.object({ min: z.number().int().min(1), max: z.number().int().min(1) }).strict(),
  /** staged rollout in basis points (0..10000); the install's own bucket decides, the server learns nothing */
  rolloutBp: z.number().int().min(0).max(10_000),
  rolloutSalt: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  /** critical releases skip the rollout gate (still need a valid signature and hash) */
  critical: z.boolean().default(false),
  /** platform-independent app bundle (zip: agent.mjs, cli.mjs, ops.html, VERSION) used by the silent updater */
  bundle: Artifact,
  /** per-platform full archives (runtime + launcher + bundle) used by the installers and package managers */
  full: z.partialRecord(Platform, Artifact).default({}),
  /** the Node runtime the bundle needs at least; an older installed runtime means "a new installer is required" */
  minRuntime: z.string().regex(/^\d{1,3}\.\d{1,3}\.\d{1,3}$/).optional(),
}).strict();
export type Release = z.infer<typeof Release>;

export const Manifest = z.object({
  schema: z.literal(1),
  /**
   * Trust epoch. Must equal the epoch the agent currently trusts (raised only by a recovery-signed keys document, see trust.ts).
   * Lets the recovery keys recover from a compromised or revoked release key: manifests of an older epoch are refused, and
   * the per-epoch `manifestVersion` high-water mark starts again at 0.
   */
  epoch: z.number().int().min(1).max(10_000).default(1),
  /** strictly monotonic within an epoch; a manifest older than the highest one ever seen is refused (rollback/freeze protection) */
  manifestVersion: z.number().int().min(1),
  issued: z.string().datetime({ offset: true }),
  expires: z.string().datetime({ offset: true }),
  channels: z.object({ stable: Version, beta: Version.optional() }).strict(),
  /** installs below this must update (rollout gate bypassed) */
  minSupported: Version,
  /** versions that must not run or be installed; an install on one of them updates at once */
  blocked: z.array(Version).max(200).default([]),
  /** signed, explicit downgrades: an install on `from` may move to `to` */
  rollbackFrom: z.array(z.object({ from: Version, to: Version }).strict()).max(50).default([]),
  releases: z.record(Version, Release),
}).strict();
export type Manifest = z.infer<typeof Manifest>;

export const MAX_MANIFEST_BYTES = 1024 * 1024;
/**
 * What the release signer will sign: Cloud KMS signs at most 64 KiB (65,536 bytes) per Ed25519 call and the signed message is the
 * 22-byte domain prefix plus the manifest, so the manifest must stay under 65,514 bytes. Below that with headroom; prune old
 * `releases` entries if a manifest ever approaches it (the build refuses to write a bigger one).
 */
export const MAX_SIGNABLE_MANIFEST_BYTES = 64_000;

/** `${process.platform}-${process.arch}` -> manifest platform key, or null when unsupported. */
export function platformKey(platform: string = process.platform, arch: string = process.arch): Platform | null {
  const os = platform === 'win32' ? 'win' : platform === 'darwin' ? 'mac' : platform === 'linux' ? 'linux' : null;
  const a = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : null;
  if (!os || !a) return null;
  const k = `${os}-${a}`;
  return (PLATFORMS as readonly string[]).includes(k) ? (k as Platform) : null;
}

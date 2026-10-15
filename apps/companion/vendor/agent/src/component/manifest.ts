/**
 * VENDORED FILE: src/component/manifest.ts of the Botwarren ship agent (https://github.com/turbokast/botwarren-ship), copied verbatim when this repository was exported;
 * the only edit is this header. The Companion shares the agent's release trust chain (the pinned public release keys, the manifest schema and
 * verifier, the Cloud KMS signer) on purpose: one key, one verifier. Do not edit here: changes are made in the ship agent repository and re-vendored.
 * Copyright 2026 TurboKast Ltd. Licensed under the Apache License, Version 2.0 (see the LICENSE file at the repository root).
 */
/**
 * Signed COMPONENT manifest: what the ship agent may install as an optional component. Today exactly one component exists, "companion"
 * (the opt-in, end-to-end encrypted remote-approvals program). It is NOT part of the metadata-only agent.
 *
 * Same trust chain as the agent's own update manifest (update/manifest.ts, verify.ts, keys.ts, trust.ts): Ed25519 detached signature over the
 * exact bytes, pinned release keys, trust epoch, anti-rollback, expiry. A DIFFERENT signature domain ("botwarren-component-v1\0") so a
 * signed agent manifest can never be presented as a component manifest or the other way round.
 */
import { z } from 'zod';
import { Artifact, Version } from '../update/manifest.ts';

export const COMPONENT_DOMAIN = Buffer.from('botwarren-component-v1\0', 'utf8');
export const COMPONENT_NAMES = ['companion'] as const;
export type ComponentName = (typeof COMPONENT_NAMES)[number];
export const MAX_COMPONENT_MANIFEST_BYTES = 256 * 1024;

export const ComponentRelease = z.object({
  commit: z.string().regex(/^[0-9a-f]{7,40}$/).optional(),
  protocol: z.object({ min: z.number().int().min(1), max: z.number().int().min(1) }).strict(),
  /** platform-independent zip: companion.mjs, VERSION, LICENSE (and NOTICE); anything else in it is refused */
  bundle: Artifact,
  /** the Node runtime the bundle needs at least (the agent's own runtime is used) */
  minRuntime: z.string().regex(/^\d{1,3}\.\d{1,3}\.\d{1,3}$/).optional(),
  /** the oldest ship agent that may install it */
  minAgent: Version.optional(),
}).strict();
export type ComponentRelease = z.infer<typeof ComponentRelease>;

export const ComponentManifest = z.object({
  schema: z.literal(1),
  kind: z.literal('botwarren-component'),
  /** must equal the component being installed: a manifest for another component is refused */
  component: z.enum(COMPONENT_NAMES),
  epoch: z.number().int().min(1).max(10_000).default(1),
  manifestVersion: z.number().int().min(1),
  issued: z.string().datetime({ offset: true }),
  expires: z.string().datetime({ offset: true }),
  channels: z.object({ stable: Version }).strict(),
  blocked: z.array(Version).max(200).default([]),
  releases: z.record(Version, ComponentRelease),
}).strict();
export type ComponentManifest = z.infer<typeof ComponentManifest>;

/** the files a component bundle may contain: nothing else is extracted */
export const BUNDLE_FILES: Record<ComponentName, readonly string[]> = { companion: ['companion.mjs', 'VERSION', 'LICENSE', 'NOTICE'] };
export const BUNDLE_REQUIRED: Record<ComponentName, readonly string[]> = { companion: ['companion.mjs', 'VERSION'] };

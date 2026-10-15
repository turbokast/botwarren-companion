#!/usr/bin/env node
/**
 * Verifies a downloaded Companion release directory against the PINNED public component key, trusting nothing else in it:
 *
 *   node apps/companion/scripts/verify-release.mjs <dir>
 *
 * <dir> holds the files of one release (the GitHub Release assets, or companion/<version>/ from the downloads host): SHA256SUMS, the signed client and
 * component manifests, the client archive, the component zip and the relay image inputs. Exit 0 only if every check in lib/release-verify.mjs passed.
 * Licence: Apache-2.0.
 */
import { resolve } from 'node:path';
import { verifyReleaseDir } from './lib/release-verify.mjs';

const dir = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (!dir) { console.error('usage: verify-release.mjs <release directory> [--allow-dev-key]'); process.exit(2); }
const r = await verifyReleaseDir({ dir: resolve(dir), allowDev: process.argv.includes('--allow-dev-key') });
if (!r.ok) { for (const p of r.problems) console.error(`  FAIL ${p}`); console.error(`release ${r.version ?? '?'} does NOT verify`); process.exit(1); }
console.log(`release ${r.version} verifies: hashes, the client signature, the component signature, the bundle and the relay image inputs`);

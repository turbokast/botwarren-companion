/** The adapters that ship with the companion besides Claude Code's (which the daemon registers itself). Licence: Apache-2.0. */
import type { CompanionHost } from '../host.ts';
import { CLAUDE_MANIFEST } from '../claude/bridge.ts';
import type { Adapter, AdapterManifest } from './types.ts';
import { HookFamilyAdapter } from './hookfamily/family.ts';
import { codexTool, CODEX_MANIFEST } from './hookfamily/tools/codex.ts';
import { museTool, MUSE_MANIFEST } from './hookfamily/tools/muse.ts';
import { OpenCodeAdapter, OPENCODE_MANIFEST } from './opencode/adapter.ts';
import { NinoxAdapter, NINOX_MANIFEST } from './ninox/adapter.ts';
import { AgyAdapter, AGY_MANIFEST } from './agy/adapter.ts';
import { HerdrAdapter, HERDR_MANIFEST, type HerdrTarget } from './herdr/adapter.ts';

/** every manifest, for `adapters` and `adapters explain` when the companion is not running */
export const ALL_MANIFESTS: readonly AdapterManifest[] = [CLAUDE_MANIFEST, CODEX_MANIFEST, MUSE_MANIFEST, OPENCODE_MANIFEST, HERDR_MANIFEST, AGY_MANIFEST, NINOX_MANIFEST];

export interface BuiltinOptions {
  /** replaces `<tool> --version` (tests, and anything that must not start the tool) */
  versionProbes?: Record<string, () => Promise<string | null>>;
  /** where to look for a Herdr socket (tests: a fake one) */
  herdrTargets?: () => HerdrTarget[];
  /** the environment OpenCode's password variable is read from (tests) */
  opencodeEnv?: Record<string, string | undefined>;
}

export function builtinAdapters(_host: CompanionHost, o: BuiltinOptions = {}): Adapter[] {
  const probe = (id: string): { versionProbe: () => Promise<string | null> } | Record<string, never> => (o.versionProbes?.[id] ? { versionProbe: o.versionProbes[id]! } : {});
  return [new HookFamilyAdapter(codexTool, probe('codex')), new HookFamilyAdapter(museTool, probe('muse')), new OpenCodeAdapter(o.opencodeEnv ? { env: o.opencodeEnv } : {}), new HerdrAdapter(o.herdrTargets ? { targets: o.herdrTargets } : {}), new AgyAdapter(o.versionProbes?.agy ? { versionProbe: o.versionProbes.agy } : {}), new NinoxAdapter()];
}

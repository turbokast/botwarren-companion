/**
 * The Muse plugin this companion generates. Muse has no hook file to merge into: hooks come from plugins (`.muse-plugin/plugin.json`), installed with
 * `muse plugins install <dir> --scope user` and trusted with `muse plugins approve <id>` (Muse's own gate, which stays the person's to pass). The plugin
 * lives in the companion's own folder and contains nothing but the manifest: each hook is a command ARRAY (no shell, no quoting) that runs the companion's
 * stable launcher. Manifest shape was found with `muse plugins validate` on Muse Code 1.4.9 (schemaVersion 1, compat.manifestDir, capabilities.hooks
 * [{id, event, command[], timeoutMs, async}], event names in PascalCase). Licence: Apache-2.0.
 */
import { join } from 'node:path';

export const MUSE_PLUGIN_ID = 'botwarren-companion';
/** fixed: it changes only when the hook definitions do, never with the companion's version, because Muse records trust against the package */
export const MUSE_PLUGIN_VERSION = '1.0.0';
export const musePluginDir = (companionHome: string): string => join(companionHome, 'muse-plugin');
export const musePluginManifestPath = (companionHome: string): string => join(musePluginDir(companionHome), '.muse-plugin', 'plugin.json');

/** the timeout of the permission hook is fixed (the longest hold is 45 s): the plugin never changes with a setting, so a trusted definition stays trusted */
export const MUSE_HOOKS: readonly { id: string; event: string; timeoutMs: number; async?: boolean }[] = [
  { id: 'session-start', event: 'SessionStart', timeoutMs: 10_000 },
  { id: 'user-prompt-submit', event: 'UserPromptSubmit', timeoutMs: 10_000 },
  { id: 'permission-request', event: 'PermissionRequest', timeoutMs: 60_000 },
  { id: 'post-tool-use', event: 'PostToolUse', timeoutMs: 10_000, async: true },
  { id: 'post-tool-use-failure', event: 'PostToolUseFailure', timeoutMs: 10_000, async: true },
  { id: 'notification', event: 'Notification', timeoutMs: 10_000, async: true },
  { id: 'stop', event: 'Stop', timeoutMs: 10_000 },
  { id: 'interrupt', event: 'Interrupt', timeoutMs: 3_000, async: true },
  { id: 'session-end', event: 'SessionEnd', timeoutMs: 3_000 },
];

export function musePluginManifest(o: { node: string; script: string }): string {
  const m = {
    schemaVersion: 1,
    name: MUSE_PLUGIN_ID,
    version: MUSE_PLUGIN_VERSION,
    description: 'Botwarren Companion: tells your own paired phone when Muse waits for you (end-to-end encrypted). Reports only to the companion on this computer.',
    compat: { source: 'native', manifestDir: '.muse-plugin' },
    capabilities: {
      skills: [], mcpServers: [], commands: [],
      hooks: MUSE_HOOKS.map((h) => ({ id: h.id, event: h.event, command: [o.node, '--disable-warning=ExperimentalWarning', o.script, 'hook', h.event, '--tool', 'muse', '--bw-companion'], timeoutMs: h.timeoutMs, ...(h.async ? { async: true } : {}) })),
    },
  };
  return JSON.stringify(m, null, 2) + '\n';
}

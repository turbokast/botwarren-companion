/**
 * The stable launcher: a path that Claude Code's settings (hooks) and MCP configuration can point at and that does NOT change when the companion updates.
 *
 * The companion installs each version in its own folder (`.../versions/0.1.1/companion.mjs`). Writing that path into `~/.claude/settings.json` or the MCP
 * config makes every update break them. So those files get `<home>/launch.mjs` instead (home = the companion's own directory, which does not move). It is
 * a few lines that read `<home>/entry.json` (which the running companion rewrites with its own script path every time it starts, and which `install-hooks`
 * and `register-channel` refresh) and import that script. Because the daemon is what writes the entry, hooks always talk to the same version as the
 * daemon that is running; after an update the first start of the new daemon moves them over. No symlink is needed, so it works the same on Windows.
 *
 * Fail open: for a hook the launcher exits quietly with 0 when anything is wrong, so Claude Code behaves as if the companion were not there.
 * Dependency-free on purpose (imported by the daemon, the CLI and the tests). Licence: Apache-2.0.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

export const LAUNCHER_FILE = 'launch.mjs';
export const ENTRY_FILE = 'entry.json';

export const LAUNCHER_SOURCE = `// Botwarren Companion: stable launcher for Claude Code hooks and the MCP channel (written by the companion; safe to delete: it is rewritten).
// It runs whatever version the companion last started as; see entry.json next to it. Hooks fail open: if anything is wrong this exits 0 silently.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
process.env.BOTWARREN_COMPANION_HOME ??= here;
try {
  const entry = JSON.parse(readFileSync(join(here, 'entry.json'), 'utf8'));
  if (!entry || typeof entry.script !== 'string') throw new Error('entry.json has no script');
  await import(pathToFileURL(entry.script).href);
} catch (e) {
  if (process.argv[2] === 'hook') process.exit(0);
  process.stderr.write('botwarren-companion launcher: cannot start the companion (' + (e && e.message ? e.message : 'unknown') + '). Run "botwarren-companion claude register-channel" again, or start the daemon once.\\n');
  process.exit(1);
}
`;

export interface EntryRecord { v: 1; node: string; script: string; version: string }

export const launcherPath = (home: string): string => join(home, LAUNCHER_FILE);

function writeAtomic(path: string, text: string, mode: number): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode });
  renameSync(tmp, path);
  try { chmodSync(path, mode); } catch { /* windows */ }
}

/** writes launch.mjs (when it differs) and entry.json (when it differs) in the companion's home; returns the launcher's path */
export function installLauncher(home: string, entry: { node: string; script: string; version: string }): string {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = launcherPath(home);
  let cur = ''; try { cur = readFileSync(file, 'utf8'); } catch { /* first time */ }
  if (cur !== LAUNCHER_SOURCE) writeAtomic(file, LAUNCHER_SOURCE, 0o600);
  const rec: EntryRecord = { v: 1, node: entry.node, script: entry.script, version: entry.version };
  const text = JSON.stringify(rec, null, 2) + '\n';
  let old = ''; try { old = readFileSync(join(home, ENTRY_FILE), 'utf8'); } catch { /* first time */ }
  if (old !== text) writeAtomic(join(home, ENTRY_FILE), text, 0o600);
  return file;
}

export function readEntry(home: string): EntryRecord | null {
  try {
    const j = JSON.parse(readFileSync(join(home, ENTRY_FILE), 'utf8')) as Partial<EntryRecord>;
    return j && typeof j.script === 'string' && typeof j.node === 'string' && typeof j.version === 'string' ? { v: 1, node: j.node, script: j.script, version: j.version } : null;
  } catch { return null; }
}

/** does the launcher exist and point at a script that exists? (for `doctor`) */
export function launcherHealth(home: string): { ok: true; version: string } | { ok: false; why: 'no_launcher' | 'no_entry' | 'script_missing' } {
  if (!existsSync(launcherPath(home))) return { ok: false, why: 'no_launcher' };
  const e = readEntry(home);
  if (!e) return { ok: false, why: 'no_entry' };
  return existsSync(e.script) ? { ok: true, version: e.version } : { ok: false, why: 'script_missing' };
}

/** a path inside a per-version folder (`.../versions/0.1.1/companion.mjs`), on any platform's separators: such a path breaks when the companion updates */
const VERSIONED = /[\\/]versions[\\/]\d+\.\d+\.\d+[^\\/"']*[\\/]companion\.mjs/;
export const isVersionedPath = (s: string): boolean => VERSIONED.test(s);

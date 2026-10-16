/** Where Codex keeps its hooks and which events this companion registers. Licence: Apache-2.0. */
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { EventSpec } from '../hookfile.ts';

/** `$CODEX_HOME/hooks.json` (default `~/.codex/hooks.json`) */
export function codexHooksPath(env: Record<string, string | undefined> = process.env): string {
  return join(env.CODEX_HOME ?? join(env.HOME ?? env.USERPROFILE ?? homedir(), '.codex'), 'hooks.json');
}

/**
 * The timeout of the permission hook is fixed at 60 s (the longest hold is 45 s) and does not follow the hold setting: Codex records trust against the
 * hook's current hash, and a changed hook must be trusted again, so nothing the person can tune may change what is in the file.
 */
export const CODEX_EVENTS_SPEC: readonly EventSpec[] = [
  { name: 'SessionStart', timeout: 10 },
  { name: 'UserPromptSubmit', timeout: 10 },
  { name: 'PermissionRequest', timeout: 60, matcher: '*' },
  { name: 'PostToolUse', timeout: 10, matcher: '*', async: true },
  { name: 'Stop', timeout: 10 },
  { name: 'Interrupt', timeout: 3 },
  { name: 'SessionEnd', timeout: 3 },
];

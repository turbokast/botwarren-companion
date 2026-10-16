/**
 * Display-only hints about what a command or patch touches, shown as chips next to the approve button and (only when the person set confirmation to
 * "risky") used to ask for confirmation on the computer. A hint, never a security boundary: the tool's own sandbox and approval policy are the boundary,
 * and a request without a chip is not thereby safe. Licence: Apache-2.0.
 */
import { isAbsolute, posix, win32 } from 'node:path';
import type { RiskTag } from '../types.ts';

const NETWORK = /(^|[\s;&|(])(curl|wget|nc|ncat|ssh|scp|sftp|rsync|ftp|telnet|gh|aws|gcloud|az|kubectl|terraform)\s|(^|[\s;&|(])git\s+(push|pull|fetch|clone|remote\s+add)\b|(^|[\s;&|(])(npm|pnpm|yarn|bun)\s+(publish|install|i|ci|add|dlx|exec)\b|(^|[\s;&|(])(npx|bunx|pipx)\s|(^|[\s;&|(])(pip3?|uv|poetry)\s+(install|add|publish)\b|(^|[\s;&|(])(cargo|gem|go)\s+(publish|install|get)\b|(^|[\s;&|(])docker\s+(pull|push|login|run)\b|https?:\/\//i;
const DESTRUCTIVE = /(^|[\s;&|(])rm\s+(-[a-zA-Z]*[rRfF][a-zA-Z]*\s+|--recursive\s+|--force\s+)|git\s+reset\s+--hard|git\s+clean\s+-[a-zA-Z]*f|git\s+push\s+(.*\s)?(--force|-f)\b|git\s+checkout\s+(--\s+)?\.|(^|[\s;&|(])(mkfs|dd|shred|truncate)\b|>\s*\/dev\/(sd|nvme|disk)|(^|[\s;&|(])chmod\s+-R|(^|[\s;&|(])chown\s+-R|drop\s+(table|database)\b|del\s+\/[sSqQ]|Remove-Item\s+.*-Recurse/i;
const PROTECTED = /(^|[\s/="'])(\.git(\/|\s|$)|\.env(\.[A-Za-z0-9]+)?(\s|$|["'])|\.ssh\b|\.aws\b|\.gnupg\b|\.codex\b|\.claude\b|\.config\/(gh|git)\b|\.bashrc|\.zshrc|\.profile|\.npmrc|\.netrc|id_rsa|id_ed25519|authorized_keys|credentials)/i;

function normalise(cwd: string, p: string): string {
  const w = /^[A-Za-z]:[\\/]/.test(cwd) || cwd.startsWith('\\\\');
  const m = w ? win32 : posix;
  const joined = isAbsolute(p) || m.isAbsolute(p) ? p : m.join(cwd, p);
  return m.normalize(joined).replace(/[\\/]+$/, '');
}

/** is `p` (as written in a command, relative to `cwd`) outside the project folder? `~` and absolute paths elsewhere count as outside */
export function outsideWorkspace(cwd: string, p: string): boolean {
  if (!cwd) return false;
  const q = p.replace(/^["']|["']$/g, '');
  if (!q || q.startsWith('-') || /^[a-z][a-z0-9+.-]*:\/\//i.test(q)) return false;
  if (q.startsWith('~')) return true;
  if (/^\/(dev\/(null|stdout|stderr|stdin)$|usr\/|bin\/|sbin\/|lib(64)?\/)/.test(q)) return false; // system programs and the null device are not what the chip is about
  if (!/^(\/|\.\.|[A-Za-z]:[\\/]|\\\\)/.test(q) && !q.includes('/../')) return false; // a plain relative name stays inside
  const w = /^[A-Za-z]:[\\/]/.test(cwd) || cwd.startsWith('\\\\');
  const root = normalise(cwd, '.');
  const full = normalise(cwd, q);
  const a = w ? full.toLowerCase().replace(/\\/g, '/') : full; const b = w ? root.toLowerCase().replace(/\\/g, '/') : root;
  return !(a === b || a.startsWith(`${b}/`));
}

/** hints for a shell command */
export function commandRisks(command: string, cwd: string): RiskTag[] {
  const out = new Set<RiskTag>();
  if (NETWORK.test(command)) out.add('network');
  if (DESTRUCTIVE.test(command)) out.add('destructive');
  if (PROTECTED.test(command)) out.add('protected_write');
  for (const tok of command.split(/[\s;&|()<>]+/)) if (tok && outsideWorkspace(cwd, tok)) { out.add('outside_workspace'); break; }
  return [...out];
}

/** the files a patch names (`*** Add File: p`, `*** Update File: p`, `*** Delete File: p`, `*** Move to: p`), in order, without duplicates */
export function patchFiles(patch: string): { files: string[]; deletes: boolean } {
  const files: string[] = []; let deletes = false;
  for (const line of patch.split('\n')) {
    const m = /^\*\*\* (Add File|Update File|Delete File|Move to):\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    if (m[1] === 'Delete File') deletes = true;
    if (!files.includes(m[2]!)) files.push(m[2]!);
  }
  return { files, deletes };
}

export function patchRisks(patch: string, cwd: string): RiskTag[] {
  const { files, deletes } = patchFiles(patch);
  const out = new Set<RiskTag>();
  if (deletes) out.add('destructive');
  for (const f of files) { if (outsideWorkspace(cwd, f)) out.add('outside_workspace'); if (PROTECTED.test(` ${f}`)) out.add('protected_write'); }
  return [...out];
}

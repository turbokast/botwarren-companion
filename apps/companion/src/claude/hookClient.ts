/**
 * The command Claude Code runs for each hook event: `botwarren-companion hook <Event>`. It reads Claude's JSON from stdin, hands it to
 * the running daemon over the local socket and prints the daemon's answer, if any.
 *
 * FAIL OPEN: if the daemon is not running, is slow, or anything goes wrong, this prints nothing and exits 0, so Claude Code behaves
 * exactly as it would without the companion. It never blocks longer than the daemon's own hold time (0 by default). If Claude Code
 * kills it (the user answered at the terminal), the socket closes and the daemon withdraws the pending request.
 * Licence: Apache-2.0.
 */
import { createConnection } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homeDir, socketPath } from '../paths.ts';

/** process ids from `pid` up towards init (Linux /proc; elsewhere just the parent) */
export function ancestors(pid: number): number[] {
  const out: number[] = [];
  let p = pid;
  for (let i = 0; i < 8 && p > 1; i++) {
    out.push(p);
    try { const stat = readFileSync(`/proc/${p}/stat`, 'utf8'); p = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]); } catch { break; }
    if (!Number.isFinite(p)) break;
  }
  return out;
}

const active = new Set<(v: null) => void>();
let signalsHooked = false;
function hookSignals(): void {
  if (signalsHooked) return;
  signalsHooked = true;
  // Claude Code kills the hook when the user answers at the terminal: close the socket so the daemon withdraws the request
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(sig, () => { for (const f of [...active]) f(null); });
}

/** `tool`: which tool's hook this is (`claude-code` when the hook command has no `--tool`, as in the hooks 0.1.x wrote) */
export async function runHook(event: string, stdin: string, env: Record<string, string | undefined> = process.env, maxWaitMs = 600_000, tool = 'claude-code'): Promise<string | null> {
  hookSignals();
  const dir = homeDir(env);
  let token: string;
  try { token = readFileSync(join(dir, 'hook.secret'), 'utf8').trim(); } catch { return null; }
  let input: unknown;
  try { input = JSON.parse(stdin || '{}'); } catch { return null; }
  return new Promise<string | null>((resolve) => {
    let done = false;
    const sock = createConnection(socketPath(dir, env));
    const finish = (v: string | null): void => { if (done) return; done = true; clearTimeout(timer); try { sock.destroy(); } catch { /* ignore */ } resolve(v); };
    const timer = setTimeout(() => finish(null), maxWaitMs);
    sock.setEncoding('utf8');
    let buf = '';
    sock.on('connect', () => sock.write(JSON.stringify({ id: 1, token, op: 'hook', tool, event, input, ancestors: ancestors(process.ppid) }) + '\n'));
    sock.on('data', (c: string) => {
      buf += c;
      const i = buf.indexOf('\n');
      if (i < 0) return;
      try { const m = JSON.parse(buf.slice(0, i)) as { ok?: boolean; out?: unknown }; finish(m.ok && m.out ? JSON.stringify(m.out) : null); } catch { finish(null); }
    });
    sock.on('error', () => finish(null));
    sock.on('close', () => finish(null));
    active.add(finish);
    sock.on('close', () => active.delete(finish));
  });
}

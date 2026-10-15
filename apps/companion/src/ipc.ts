/** Client side of the daemon's local socket, used by the CLI. Licence: Apache-2.0. */
import { createConnection, type Socket } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { socketPath } from './paths.ts';

export interface DaemonLink {
  request(op: string, args?: Record<string, unknown>): Promise<Record<string, unknown>>;
  onEvent(fn: (ev: Record<string, unknown>) => void): void;
  close(): void;
}

export function connectDaemon(dir: string, env: Record<string, string | undefined> = process.env): Promise<DaemonLink | null> {
  let token: string;
  try { token = readFileSync(join(dir, 'hook.secret'), 'utf8').trim(); } catch { return Promise.resolve(null); }
  return new Promise((resolve) => {
    const sock: Socket = createConnection(socketPath(dir, env));
    let seq = 1; let buf = '';
    const waits = new Map<number, (m: Record<string, unknown>) => void>();
    const listeners: ((ev: Record<string, unknown>) => void)[] = [];
    sock.setEncoding('utf8');
    sock.on('error', () => resolve(null));
    sock.on('data', (c: string) => {
      buf += c;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        try {
          const m = JSON.parse(line) as Record<string, unknown>;
          if (m.ev && typeof m.ev === 'object') for (const l of listeners) l(m.ev as Record<string, unknown>);
          else if (typeof m.id === 'number') { waits.get(m.id)?.(m); waits.delete(m.id); }
        } catch { /* ignore */ }
      }
    });
    sock.on('close', () => { for (const w of waits.values()) w({ ok: false, error: 'closed' }); waits.clear(); });
    sock.on('connect', () => resolve({
      request: (op, args = {}) => new Promise((ok) => { const id = seq++; waits.set(id, ok); sock.write(JSON.stringify({ id, token, op, ...args }) + '\n'); }),
      onEvent: (fn) => { listeners.push(fn); },
      close: () => sock.destroy(),
    }));
  });
}

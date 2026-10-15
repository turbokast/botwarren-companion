/** Paths only, with no dependencies, so the hook client (started for every Claude Code event) stays fast. Licence: Apache-2.0. */
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

export function homeDir(env: Record<string, string | undefined> = process.env): string {
  if (env.BOTWARREN_COMPANION_HOME) return env.BOTWARREN_COMPANION_HOME;
  const h = env.HOME ?? homedir();
  if (platform() === 'win32') return join(env.APPDATA ?? join(h, 'AppData', 'Roaming'), 'botwarren-companion');
  if (platform() === 'darwin') return join(h, 'Library', 'Application Support', 'botwarren-companion');
  return join(env.XDG_CONFIG_HOME ?? join(h, '.config'), 'botwarren-companion');
}

/** the local socket the daemon listens on: a Unix socket in the 0700 directory, a named pipe on Windows */
export function socketPath(dir: string, env: Record<string, string | undefined> = process.env): string {
  if (platform() === 'win32') return `\\\\.\\pipe\\botwarren-companion-${Buffer.from(dir).toString('hex').slice(0, 24)}`;
  // sun_path is limited to about 104 bytes: fall back to a short derived path if the home path is long
  const p = join(dir, 'daemon.sock');
  return p.length < 100 ? p : join(env.XDG_RUNTIME_DIR ?? '/tmp', `bwc-${Buffer.from(dir).toString('base64url').slice(-20)}.sock`);
}

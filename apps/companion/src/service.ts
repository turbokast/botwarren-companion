/**
 * Where the background service of this computer lives (the installer's `--service`), and what to tell a person when the daemon cannot be reached.
 * Mirrors install/installer.mjs (servicePaths, SERVICE); dependency-free. Licence: Apache-2.0.
 */
import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

export interface ServiceUnit { kind: 'systemd' | 'launchd' | 'startup'; file: string; restart: string }

export function serviceUnit(o: { os?: string; env?: Record<string, string | undefined>; home?: string } = {}): ServiceUnit | null {
  const os = o.os ?? platform(); const env = o.env ?? process.env;
  const home = o.home ?? env.HOME ?? env.USERPROFILE ?? homedir();
  let u: ServiceUnit;
  if (os === 'win32') u = { kind: 'startup', file: join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Botwarren Companion.vbs'), restart: 'sign out of Windows and back in, or run: botwarren-companion daemon (leave the window open)' };
  else if (os === 'darwin') u = { kind: 'launchd', file: join(home, 'Library', 'LaunchAgents', 'com.botwarren.companion.plist'), restart: 'launchctl kickstart -k gui/$(id -u)/com.botwarren.companion' };
  else u = { kind: 'systemd', file: join(env.XDG_CONFIG_HOME ?? join(home, '.config'), 'systemd', 'user', 'botwarren-companion.service'), restart: 'systemctl --user restart botwarren-companion' };
  return existsSync(u.file) ? u : null;
}

/** the sentence a command prints when it cannot reach the daemon: what was seen, and the one thing to do */
export function noDaemonMessage(o: { socketFile: boolean; unit: ServiceUnit | null }): string {
  const seen = o.socketFile
    ? 'The companion daemon is not answering: its socket file is there but nothing listens on it (a stale or replaced socket).'
    : 'The companion daemon is not running.';
  if (o.unit) return `${seen}\nA background service is installed (${o.unit.file}). Restart it: ${o.unit.restart}`;
  return `${seen}\nStart it with: botwarren-companion daemon (leave it running), or install the background service with the installer's --service option.`;
}

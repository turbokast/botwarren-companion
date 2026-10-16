/**
 * `botwarren-companion codex install-hooks | remove-hooks | doctor`: user-initiated, diff first, --yes without a terminal, backup, only our entries,
 * Herdr's own entries never edited. Everything happens in temporary folders: the real ~/.codex is never touched.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launcherPath, isVersionedPath } from '../src/claude/launcher.ts';
import { CODEX_EVENTS_SPEC, codexHooksPath } from '../src/adapters/hookfamily/installers/codex.ts';
import { familyHooksOf, isFamilyHook, withFamilyHooks, withoutFamilyHooks, type HooksFile } from '../src/adapters/hookfamily/hookfile.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'bwc-cx-'));
  const dirs = { home: join(root, 'user'), codex: join(root, 'codex'), companion: join(root, 'companion') };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  const env: Record<string, string> = { HOME: dirs.home, USERPROFILE: dirs.home, APPDATA: join(dirs.home, 'AppData', 'Roaming'), LOCALAPPDATA: join(dirs.home, 'AppData', 'Local'), XDG_CONFIG_HOME: join(dirs.home, '.config'), CODEX_HOME: dirs.codex, BOTWARREN_COMPANION_HOME: dirs.companion };
  const run = (args: string[]) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', cli, ...args], { env: { ...process.env, ...env }, input: '', encoding: 'utf8', timeout: 30_000 });
  return { ...dirs, env, run, hooks: join(dirs.codex, 'hooks.json'), launcher: launcherPath(dirs.companion) };
}

/** what Herdr's own installer leaves in the owner's hooks.json (shape from the real file; the script path is a stand-in) */
const herdrFile = (): HooksFile => ({
  hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'sh /home/u/.codex/herdr-agent-state.sh SessionStart', timeout: 5 }] }] },
});

describe('codex install-hooks', () => {
  it('adds our hooks beside Herdr\'s, shows the diff, writes a backup, and never edits Herdr\'s entry', () => {
    const sb = sandbox();
    writeFileSync(sb.hooks, JSON.stringify(herdrFile(), null, 2));
    const r = sb.run(['codex', 'install-hooks', '--yes']);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(r.stdout).toContain(`This will change ${sb.hooks}`);
    expect(r.stdout).toMatch(/other hook\(s\) already in the file, such as Herdr's, are not touched/);
    expect(r.stdout).toContain('/hooks');
    const after = JSON.parse(readFileSync(sb.hooks, 'utf8')) as HooksFile;
    // Herdr's group is byte-for-byte the same group, still first
    expect(after.hooks!.SessionStart![0]).toEqual(herdrFile().hooks!.SessionStart![0]);
    for (const ev of CODEX_EVENTS_SPEC) {
      const ours = (after.hooks![ev.name] ?? []).flatMap((g) => g.hooks ?? []).filter((h) => isFamilyHook(h, 'codex'));
      expect(ours, ev.name).toHaveLength(1);
      expect(ours[0]!.command).toContain(` hook ${ev.name} --tool codex --bw-companion`);
      expect(ours[0]!.timeout).toBe(ev.timeout);
    }
    expect(after.hooks!.PostToolUse![0]!.hooks![0]!.async).toBe(true);
    expect(after.hooks!.PermissionRequest![0]!.matcher).toBe('*');
    // the backup is the file as it was
    const backups = readdirSync(sb.codex).filter((f) => f.startsWith('hooks.json.bw-backup-'));
    expect(backups).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(sb.codex, backups[0]!), 'utf8'))).toEqual(herdrFile());
    // a second run changes nothing
    const again = sb.run(['codex', 'install-hooks', '--yes']);
    expect(again.stdout).toContain('already installed');
    expect(JSON.parse(readFileSync(sb.hooks, 'utf8'))).toEqual(after);
  });

  it('the commands name the stable launcher (not a per-version path) and the tool', () => {
    const sb = sandbox();
    expect(sb.run(['codex', 'install-hooks', '--yes']).status).toBe(0);
    const f = JSON.parse(readFileSync(sb.hooks, 'utf8')) as HooksFile;
    const cmds = familyHooksOf(f, 'codex').map((h) => h.entry.command!);
    expect(cmds).toHaveLength(CODEX_EVENTS_SPEC.length);
    for (const c of cmds) { expect(isVersionedPath(c)).toBe(false); expect(c).toContain('launch.mjs'); expect(c).toContain('--disable-warning=ExperimentalWarning'); }
    expect(existsSync(sb.launcher)).toBe(true);
  });

  it('without a terminal and without --yes nothing is changed and it says how to proceed; the file is created only when it is applied', () => {
    const sb = sandbox();
    writeFileSync(sb.hooks, JSON.stringify(herdrFile(), null, 2));
    const before = readFileSync(sb.hooks, 'utf8');
    const r = sb.run(['codex', 'install-hooks']);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('Re-run with --yes to apply it');
    expect(readFileSync(sb.hooks, 'utf8')).toBe(before);
    expect(readdirSync(sb.codex).filter((f) => f.includes('bw-backup'))).toEqual([]);
  });

  it('remove-hooks takes out only our entries and leaves the rest exactly as it was', () => {
    const sb = sandbox();
    const orig = { ...herdrFile(), description: 'mine', hooks: { ...herdrFile().hooks, Stop: [{ hooks: [{ type: 'command', command: 'echo my own stop hook' }] }] } } as HooksFile;
    writeFileSync(sb.hooks, JSON.stringify(orig, null, 2));
    expect(sb.run(['codex', 'install-hooks', '--yes']).status).toBe(0);
    const r = sb.run(['codex', 'remove-hooks']);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(readFileSync(sb.hooks, 'utf8'))).toEqual(orig);
    expect(sb.run(['codex', 'remove-hooks']).stdout).toContain('no companion hooks found');
  });

  it('a hook file that is not JSON is refused untouched', () => {
    const sb = sandbox();
    writeFileSync(sb.hooks, '{ not json');
    const r = sb.run(['codex', 'install-hooks', '--yes']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('cannot read');
    expect(readFileSync(sb.hooks, 'utf8')).toBe('{ not json');
  });

  it('the file location follows CODEX_HOME, then HOME/.codex', () => {
    expect(codexHooksPath({ CODEX_HOME: '/x/codex' })).toBe(join('/x/codex', 'hooks.json'));
    expect(codexHooksPath({ HOME: '/home/u' })).toBe(join('/home/u', '.codex', 'hooks.json'));
  });

  it('pure functions: only our --tool is ours (another tool\'s marker entries are left alone) and removal is exact', () => {
    const cur: HooksFile = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node x.mjs hook Stop --tool muse --bw-companion' }, { type: 'command', command: 'echo hi' }] }] } };
    const next = withFamilyHooks(cur, { tool: 'codex', node: '/usr/bin/node', script: '/h/launch.mjs', events: [{ name: 'Stop', timeout: 10 }], win: false });
    expect(next.hooks!.Stop![0]).toEqual(cur.hooks!.Stop![0]);
    expect(familyHooksOf(next, 'codex')).toHaveLength(1);
    expect(familyHooksOf(next, 'muse')).toHaveLength(1);
    expect(withoutFamilyHooks(next, 'codex')).toEqual(cur);
  });
});

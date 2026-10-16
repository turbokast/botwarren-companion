/**
 * LIVE (opt-in, `BW_LIVE_MUSE=1`): the real Muse binary's plugin machinery in an isolated HOME with an EMPTY environment (PATH and temp folders only, nothing of
 * the owner's Muse, Herdr or shell session is inherited): our `muse install-hooks` writes the plugin and installs it with Muse's own `plugins install`,
 * Muse validates it, trusts it on `approve`, and Muse's own `plugins hook test` runs our REAL hook command, which reaches a real daemon and a simulated phone,
 * and Muse's parser reads the decision the phone chose. No model, no credentials, no network. It does NOT prove how a running Muse TUI treats the hook.
 * The binary is the versioned `muse-bin-*` next to the `muse` launcher (the launcher auto-updates itself and is never run here).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startWorld, type World } from './world.ts';
import type { SimDevice } from './simdevice.ts';
import type { Pending } from '../src/protocol/index.ts';
import { fixture } from './fixtures.ts';
import { firstVersion } from '../src/adapters/io.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const binDir = join(homedir(), '.local', 'bin');
const museBin = ((): string | null => { try { const f = readdirSync(binDir).filter((n) => /^muse-bin-\d/.test(n)).sort().at(-1); return f ? join(binDir, f) : null; } catch { return null; } })();
const live = process.env.BW_LIVE_MUSE === '1' && museBin !== null && process.platform !== 'win32';

let w: World | null = null; let tmp = '';
afterEach(async () => { await w?.close(); w = null; if (tmp) rmSync(tmp, { recursive: true, force: true }); tmp = ''; });

const pendingOf = (d: SimDevice): (Pending & { sid: string }) | undefined => { const s = d.latest?.sessions.find((x) => x.pending && x.agent === 'muse'); return s?.pending ? { ...s.pending, sid: s.sid } : undefined; };

describe.skipIf(!live)('live Muse plugin machinery (real binary, isolated)', () => {
  it('installs, validates, trusts, and answers a PermissionRequest from a phone through Muse\'s own hook runner', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'bwc-muselive-'));
    const home = join(tmp, 'home'); const tbin = join(tmp, 'bin'); mkdirSync(home); mkdirSync(tbin);
    symlinkSync(museBin!, join(tbin, 'muse')); // `muse` on the CLI's PATH is the versioned binary, never the self-updating launcher
    const env: Record<string, string> = { PATH: `${tbin}:/usr/bin:/bin`, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'), XDG_STATE_HOME: join(home, '.local/state'), XDG_CACHE_HOME: join(home, '.cache') };
    const version = firstVersion(spawnSync(museBin!, ['--version'], { env, encoding: 'utf8' }).stdout)!;
    w = await startWorld({ resolveWaitMs: 2000, versionProbes: { muse: async () => version } });
    const cfg = w.daemon.store.config();
    w.setConfig({ adapters: { ...cfg.adapters, muse: { enabled: true, hold: 'away', holdSeconds: 30, verifiedVersions: [version] } } });
    const d = await w.pairDevice(); w.daemon.host.setAway(Date.now() + 3_600_000);

    // asynchronous on purpose: the daemon runs in THIS process, so a blocking spawn of a command that talks to it would deadlock
    const run = (args: string[]) => new Promise<{ status: number | null; stdout: string; stderr: string }>((ok) => { const c = execFile(process.execPath, ['--disable-warning=ExperimentalWarning', cli, ...args], { env: { ...env, BOTWARREN_COMPANION_HOME: w!.env.BOTWARREN_COMPANION_HOME }, timeout: 60_000 }, (e, stdout, stderr) => ok({ status: e ? ((e as { code?: number }).code ?? 1) : 0, stdout, stderr })); c.stdin?.end(''); });
    const inst = await run(['muse', 'install-hooks', '--yes']);
    expect(inst.status, inst.stderr + inst.stdout).toBe(0);
    expect(inst.stdout).toContain('muse plugins approve botwarren-companion');
    const m = (args: string[]) => spawnSync(museBin!, args, { env, encoding: 'utf8', timeout: 60_000 });
    const list = JSON.parse(m(['plugins', 'list', '--json']).stdout) as { plugins: { plugin: { id: string }; diagnostics: unknown[] }[] };
    expect(list.plugins.map((p) => p.plugin.id)).toContain('botwarren-companion');
    expect(list.plugins[0]!.diagnostics).toEqual([]); // Muse accepts every event name and field in the generated manifest
    // before approval Muse does not trust the hooks, and our doctor says so
    expect((await run(['muse', 'doctor'])).stdout).toMatch(/plugin\s+installed; hooks: .*(untrusted|pending|changed|disabled)|run:\s+muse plugins approve/i);
    expect(m(['plugins', 'approve', 'botwarren-companion', '--json']).status).toBe(0);
    expect((await run(['muse', 'doctor'])).stdout).toMatch(/plugin\s+installed; hooks: 9 trusted_enabled/);

    // Muse's own hook runner runs OUR hook command with the fixture on stdin; the daemon holds it; the phone answers
    const fx = join(tmp, 'fixture.json');
    writeFileSync(fx, JSON.stringify({ event: 'PermissionRequest', stdin: fixture('muse', '1.4.9', 'permission-request-escalated').input }));
    const test = new Promise<{ stdout: string }>((ok) => { execFile(museBin!, ['plugins', 'hook', 'test', 'botwarren-companion:permission-request', '--fixture', fx, '--json'], { env, timeout: 90_000, maxBuffer: 1 << 20 }, (_e, stdout) => ok({ stdout })); });
    const p = await d.waitFor(() => pendingOf(d), 40_000);
    expect(p).toMatchObject({ tool: 'bash', can: { approve: false, deny: true } });
    await d.act({ rid: p.rid, sid: p.sid, a: 'reply', bind: p.bind, opt: 'no' });
    const out = JSON.parse((await test).stdout) as { decision: { permission_decision: string; block_reason: string }; terminals: { status: string }[] };
    expect(out.decision.permission_decision).toBe('deny');
    expect(out.decision.block_reason).toBe('Denied from "Sim phone" via Botwarren Companion: No, do not do that.');
    expect(out.terminals[0]!.status).toBe('blocked');
    expect(existsSync(join(home, '.local/share/muse/plugins/installed.json'))).toBe(true);
    // removal goes through Muse's own command
    expect((await run(['muse', 'remove-hooks'])).status).toBe(0);
    expect(JSON.parse(m(['plugins', 'list', '--json']).stdout).plugins).toEqual([]);
  }, 180_000);
});

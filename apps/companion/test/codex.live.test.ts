/**
 * LIVE: the real `codex` binary (its TUI in a pseudo-terminal), hooks installed by our own `codex install-hooks`, a real companion daemon and relay, and a
 * simulated phone. The model is a scripted local stand-in (test/support/mock-responses.ts): no account, no credentials, no real prompt, no network.
 * Opt-in because it starts a real TUI and takes about a minute: `BW_LIVE_CODEX=1 pnpm exec vitest run test/codex.live.test.ts` (needs `codex` and `python3`).
 * It runs in temporary folders only; the real ~/.codex is never read or written. Proves, on the installed Codex version: a held hook answered from the
 * phone runs the command with no dialog; deny shows "Blocked by hook" and nothing runs; an unanswered hold falls back to Codex's own dialog.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startWorld, type World } from './world.ts';
import type { SimDevice } from './simdevice.ts';
import type { Pending } from '../src/protocol/index.ts';
import { havePython, ptyRun } from './support/pty.ts';
import { mockResponses, type MockResponses } from './support/mock-responses.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const codexVersion = (): string | null => { try { const r = spawnSync('codex', ['--version'], { encoding: 'utf8', timeout: 8000 }); return r.status === 0 ? r.stdout.trim() : null; } catch { return null; } };
const live = process.env.BW_LIVE_CODEX === '1' && codexVersion() !== null && havePython();

let w: World | null = null;
let mock: MockResponses | null = null;
let tmp = '';
afterEach(async () => { await w?.close(); w = null; await mock?.close(); mock = null; if (tmp) rmSync(tmp, { recursive: true, force: true }); tmp = ''; });

/** the TUI paints with cursor moves instead of spaces, so compare without whitespace */
const squash = (s: string): string => s.replace(/\s+/g, '');

const pendingOf = (d: SimDevice): (Pending & { sid: string }) | undefined => {
  const s = d.latest?.sessions.find((x) => x.pending && x.agent === 'codex');
  return s?.pending ? { ...s.pending, sid: s.sid } : undefined;
};

async function rig(holdSeconds: number): Promise<{ d: SimDevice; marker: string; run: (o: { stopOn: string[]; sends?: { pattern: string; keys: string }[] }) => ReturnType<typeof ptyRun> }> {
  tmp = mkdtempSync(join(tmpdir(), 'bwc-live-'));
  const marker = join(tmp, 'marker.txt');
  const repo = join(tmp, 'repo'); mkdirSync(repo);
  const codexHome = join(tmp, 'codex'); mkdirSync(codexHome);
  const userHome = join(tmp, 'user'); mkdirSync(userHome);
  mock = await mockResponses([
    { tool: { name: 'exec_command', arguments: { cmd: `touch ${marker} && echo LIVE_RAN`, sandbox_permissions: 'require_escalated', justification: 'Botwarren live test: create a marker file outside the workspace', yield_time_ms: 2000 } } },
    { text: 'The command finished.' },
  ]);
  writeFileSync(join(codexHome, 'config.toml'), `model = "mock-model"\nmodel_provider = "mock"\napproval_policy = "on-request"\nsandbox_mode = "workspace-write"\n\n[model_providers.mock]\nname = "mock"\nbase_url = "http://127.0.0.1:${mock.port}/v1"\nwire_api = "responses"\nenv_key = "MOCK_KEY"\n\n[projects."${repo}"]\ntrust_level = "trusted"\n`);
  w = await startWorld({ resolveWaitMs: 8000 });
  const cfg = w.daemon.store.config();
  w.setConfig({ adapters: { ...cfg.adapters, codex: { enabled: true, hold: 'away', holdSeconds } } });
  const d = await w.pairDevice('Mia phone');
  w.daemon.host.setAway(Date.now() + 3_600_000);
  // our own installer writes the hooks (into the temporary CODEX_HOME)
  const env = { ...process.env, HOME: userHome, CODEX_HOME: codexHome, BOTWARREN_COMPANION_HOME: w.env.BOTWARREN_COMPANION_HOME } as Record<string, string>;
  const inst = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', cli, 'codex', 'install-hooks', '--yes'], { env, encoding: 'utf8', input: '' });
  if (inst.status !== 0) throw new Error(`install-hooks failed: ${inst.stderr}${inst.stdout}`);
  const run = (o: { stopOn: string[]; sends?: { pattern: string; keys: string }[] }) => ptyRun({
    cmd: ['codex', '--dangerously-bypass-hook-trust', 'run the marker command'], cwd: repo, seconds: 60, ...o,
    env: { HOME: userHome, CODEX_HOME: codexHome, MOCK_KEY: 'dummy', BOTWARREN_COMPANION_HOME: w!.env.BOTWARREN_COMPANION_HOME },
  });
  return { d, marker, run };
}

describe.skipIf(!live)('live Codex (real binary, hooks installed by our installer, scripted model)', () => {
  it('approve from the phone: the command runs, Codex shows no dialog, and the outcome becomes "applied"', async () => {
    const r = await rig(30);
    const running = r.run({ stopOn: ['The\\s*command\\s*finished'] });
    const p = await r.d.waitFor(() => pendingOf(r.d), 40_000);
    expect(p).toMatchObject({ tool: 'Bash', can: { approve: true }, risk: expect.arrayContaining(['outside_workspace']) });
    await r.d.act({ rid: p.rid, sid: p.sid, a: 'approve', bind: p.bind });
    const out = await running;
    expect(squash(out.screen)).not.toContain('Wouldyoulike');
    expect(existsSync(r.marker)).toBe(true);
    expect((await r.d.waitFor(() => r.d.results[0], 15_000)).outcome).toBe('applied');
  }, 120_000);

  it('deny from the phone: Codex shows "Blocked by hook", the command never runs', async () => {
    const r = await rig(30);
    const running = r.run({ stopOn: ['Blocked\\s*by\\s*hook'] });
    const p = await r.d.waitFor(() => pendingOf(r.d), 40_000);
    await r.d.act({ rid: p.rid, sid: p.sid, a: 'reply', bind: p.bind, opt: 'no' });
    const out = await running;
    expect(squash(out.screen)).toContain('Blockedbyhook');
    expect(squash(out.screen)).toContain('Deniedfrom"Miaphone"viaBotwarrenCompanion:No,donotdothat.');
    expect(squash(out.screen)).not.toContain('Wouldyoulike');
    expect(existsSync(r.marker)).toBe(false);
    expect((await r.d.waitFor(() => r.d.results[0], 15_000)).outcome).toBe('denied');
  }, 120_000);

  it('nobody answers: after the hold Codex shows its own dialog (nothing ran, nothing was approved by waiting)', async () => {
    const r = await rig(5);
    const out = await r.run({ stopOn: ['Press\\s*enter\\s*to\\s*confirm'] });
    expect(squash(out.screen)).toContain('Wouldyoulike');
    expect(out.seconds).toBeGreaterThanOrEqual(5);
    expect(existsSync(r.marker)).toBe(false); // nothing ran: Codex is waiting for the person, as it would without the companion
  }, 120_000);
});

import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { maskSecrets, secretEnvValues, clip } from '../src/mask.ts';
import { ActionLimiter, needsLocalConfirmation, relayAllowed } from '../src/policy.ts';
import { ConfigSchema, Store } from '../src/store.ts';
import { HOOK_EVENTS, MARKER, hasOurHooks, readSettings, settingsPath, withHooks, withoutHooks, writeSettings } from '../src/claude/settings.ts';
import { readRecentAssistant, safeTranscript } from '../src/sessions.ts';
import { CompanionHost, type ConnectionLike } from '../src/host.ts';
import { b64u, generateIdentity, KemKeyring, openMessage, ReplayGuard, signTicket, unb64u, type Frame } from '../src/protocol/index.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const tmp = (): string => mkdtempSync(join(tmpdir(), 'bwc-u-'));

// The fake secrets below are assembled at run time so that no secret-shaped literal sits in the source (secret scanners, push protection).
const j = (...parts: string[]): string => parts.join('');

describe('secret masking (a seatbelt, not a boundary)', () => {
  it.each([
    ['github token', `use ${j('gh', 'p_')}abcdefghijklmnopqrstuvwxyz0123456789AB now`],
    ['fine-grained pat', `${j('github', '_pat_')}11ABCDEFG0abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz`],
    ['anthropic key', `key ${j('sk-', 'ant-api03-')}abcdefghijklmnopqrstuvwxyz`],
    ['aws key', `${j('AK', 'IA')}IOSFODNN7EXAMPLE`],
    ['jwt', `${j('ey', 'Jh')}bGciOiJIUzI1NiJ9.${j('ey', 'Jz')}dWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk`],
    ['bearer', 'curl -H "Authorization: Bearer abcdef1234567890abcdef"'],
    ['url credentials', 'git clone https://user:hunter2hunter2@github.com/x/y.git'],
    ['env assignment', 'DATABASE_PASSWORD=correcthorsebatterystaple'],
    ['private key', `-----${j('BEGIN ', 'OPENSSH PRIVATE')} KEY-----\nabcdef\n-----END OPENSSH PRIVATE KEY-----`],
    ['stripe', `${j('sk_', 'live_')}abcdefghijklmnopqrstuvwx`],
  ])('masks a %s', (_n, text) => {
    const r = maskSecrets(text);
    expect(r.masked).toBeGreaterThan(0);
    for (const frag of ['ghp_abcdef', 'github_pat_11', 'sk-ant-api03', 'AKIAIOSF', 'eyJhbGci', 'abcdef1234567890abcdef', 'hunter2', 'correcthorse', 'BEGIN OPENSSH', 'sk_live_abc']) expect(r.text).not.toContain(frag);
  });

  it('removes literal secret values from the environment and long random-looking strings, and leaves ordinary text alone', () => {
    const env = { MY_API_TOKEN: 'zzz-very-secret-value-1234', PATH: '/usr/bin' };
    expect(maskSecrets('the token zzz-very-secret-value-1234 leaked', secretEnvValues(env)).text).toBe('the token [masked] leaked');
    expect(maskSecrets('hash 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 end').text).toContain('[masked]');
    const plain = 'I updated src/components/LoginRedirect.tsx and ran the tests; all 42 passed. See https://example.com/docs/getting-started.';
    expect(maskSecrets(plain)).toEqual({ text: plain, masked: 0 });
    expect(clip('abcdef', 4)).toBe('abc…');
  });
});

describe('policy', () => {
  const cfg = ConfigSchema.parse({});
  it('defaults: deny and replies and approvals go through; any mode can require local confirmation', () => {
    expect(needsLocalConfirmation(cfg, { kind: 'deny' })).toBe(false);
    expect(needsLocalConfirmation(cfg, { kind: 'approve', tool: 'Bash' })).toBe(false);
    expect(needsLocalConfirmation({ ...cfg, confirm: { approve: 'always', reply: 'off' } }, { kind: 'approve' })).toBe(true);
    expect(needsLocalConfirmation({ ...cfg, confirm: { approve: 'always', reply: 'off' } }, { kind: 'deny' })).toBe(false);
    const risky = { ...cfg, confirm: { approve: 'risky' as const, reply: 'risky' as const }, requireLocalTools: ['Bash'] };
    expect(needsLocalConfirmation(risky, { kind: 'approve', tool: 'Bash' })).toBe(true);
    expect(needsLocalConfirmation(risky, { kind: 'approve', tool: 'Read' })).toBe(false);
    expect(needsLocalConfirmation(risky, { kind: 'reply', presetId: 'yes' })).toBe(true); // flagged affirm
    expect(needsLocalConfirmation(risky, { kind: 'reply', presetId: 'summary' })).toBe(false);
  });

  it('limits actions per minute and per hour', () => {
    const l = new ActionLimiter(2, 3);
    expect([l.allow(0), l.allow(1), l.allow(2)]).toEqual([true, true, false]);
    expect(l.allow(61_000)).toBe(true);
    expect(l.allow(122_000)).toBe(false); // 3 in the hour
  });

  it('only connects to an allowed relay: wss on the allowed domain, or loopback for development', () => {
    const allow = ['botwarren.com'];
    expect(relayAllowed('wss://relay.botwarren.com/v1/ws', allow)).toBe(true);
    expect(relayAllowed('https://relay.botwarren.com', allow)).toBe(true);
    expect(relayAllowed('wss://evil.example/v1/ws', allow)).toBe(false);
    expect(relayAllowed('wss://botwarren.com.evil.example', allow)).toBe(false);
    expect(relayAllowed('ws://relay.botwarren.com', allow)).toBe(false);
    expect(relayAllowed('wss://user:pw@relay.botwarren.com', allow)).toBe(false);
    expect(relayAllowed('ws://127.0.0.1:1234', allow)).toBe(false);
    expect(relayAllowed('ws://127.0.0.1:1234', ['127.0.0.1'])).toBe(true);
  });
});

describe('Claude Code settings: reversible, never silent, nothing else touched', () => {
  const o = { node: '/usr/bin/node', script: '/opt/botwarren companion/cli.ts', holdSeconds: 0 };
  it('adds our hooks next to existing ones and removes exactly ours', () => {
    const cur = { model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }], PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'check.sh' }] }] }, permissions: { allow: ['Read'] } };
    const next = withHooks(cur, o);
    for (const ev of HOOK_EVENTS) expect(JSON.stringify(next.hooks![ev])).toContain(MARKER);
    expect(next.hooks!.Stop).toHaveLength(2);
    expect(next.hooks!.Stop![0]!.hooks![0]!.command).toBe('echo mine');
    expect(next.hooks!.PreToolUse).toEqual(cur.hooks.PreToolUse);
    expect(next.permissions).toEqual(cur.permissions);
    const pr = next.hooks!.PermissionRequest![0]!.hooks![0]!;
    expect(pr.timeout).toBe(10);
    expect(next.hooks!.PostToolUse![0]!.hooks![0]!.async).toBe(true);
    expect(pr.command).toContain('"/opt/botwarren companion/cli.ts"'); // quoted
    expect(hasOurHooks(next)).toBe(true);
    expect(withoutHooks(next)).toEqual(cur);
    // idempotent
    expect(withHooks(next, o)).toEqual(next);
    expect(withHooks(cur, { ...o, holdSeconds: 30 }).hooks!.PermissionRequest![0]!.hooks![0]!.timeout).toBe(40);
  });

  it('writes with a backup, in a temporary CLAUDE_CONFIG_DIR, and refuses a settings file that is not an object', () => {
    const dir = tmp();
    const env = { CLAUDE_CONFIG_DIR: dir };
    const p = settingsPath('user', '/x', env);
    expect(p).toBe(join(dir, 'settings.json'));
    writeFileSync(p, JSON.stringify({ theme: 'dark' }));
    const backup = writeSettings(p, withHooks(readSettings(p), o));
    expect(backup && readFileSync(backup, 'utf8')).toContain('dark');
    expect(hasOurHooks(readSettings(p))).toBe(true);
    writeFileSync(p, '[1,2]');
    expect(() => readSettings(p)).toThrow();
    writeFileSync(p, '{ not json');
    expect(() => readSettings(p)).toThrow();
  });
});

describe('transcript reading is confined', () => {
  it('reads only .jsonl files under the Claude projects directory, assistant text only', () => {
    const dir = tmp(); mkdirSync(join(dir, 'projects', 'a'), { recursive: true });
    const env = { CLAUDE_CONFIG_DIR: dir };
    const ok = join(dir, 'projects', 'a', 's.jsonl');
    writeFileSync(ok, [JSON.stringify({ type: 'user', message: { role: 'user', content: 'private prompt' } }), JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }, { type: 'tool_use', name: 'Bash', input: { command: 'secret' } }] } }), '{torn'].join('\n'));
    expect(readRecentAssistant(ok, 3, env).map((x) => x.text)).toEqual(['hello']);
    const outside = join(tmp(), 'id_rsa.jsonl'); writeFileSync(outside, JSON.stringify({ type: 'assistant', message: { content: 'STOLEN' } }));
    expect(readRecentAssistant(outside, 3, env)).toEqual([]);
    expect(safeTranscript('/etc/passwd', env)).toBeNull();
    expect(safeTranscript(join(dir, 'projects', 'a', '..', '..', '..', 'x.jsonl'), env)).toBeNull();
  });
});

describe('files at rest', () => {
  it('everything in the home directory is mode 0600 and the directory 0700', async () => {
    const dir = join(tmp(), 'home');
    const store = new Store(dir);
    const host = new CompanionHost({ store, confirmer: async () => false });
    await host.init();
    store.hookSecret(); store.audit('x');
    expect((statSync(dir).mode & 0o777).toString(8)).toBe('700');
    for (const f of readdirSync(dir)) expect((statSync(join(dir, f)).mode & 0o777).toString(8), f).toBe('600');
    // the host key survives a restart
    const again = new CompanionHost({ store, confirmer: async () => false });
    await again.init();
    expect(again.hostId).toBe(host.hostId);
  });
});

describe('host key rotation and device removal (no network)', () => {
  function stubConn() {
    const frames: Frame[] = []; const ctl: unknown[] = [];
    const conn: ConnectionLike = { start() {}, stop() {}, send(o) { ctl.push(o); return true; }, sendFrame(f) { frames.push(f); return true; }, ack() {}, online: true };
    return { conn, frames, ctl };
  }

  it('rotates only when every device was seen lately, announces the new key, and keeps the old one for the grace period', async () => {
    let now = 1_800_000_000_000;
    const dir = join(tmp(), 'h'); const store = new Store(dir);
    const server = await generateIdentity(true);
    const s = stubConn();
    const host = new CompanionHost({ store, now: () => now, confirmer: async () => false, makeConnection: () => s.conn });
    await host.init();
    store.writeJson('enrollment.json', { v: 1, relayUrl: 'wss://relay.botwarren.com', ticket: await signTicket(server, { v: 1, acct: 'acct-aaaaaaaaaaaaaaaa', host: host.hostId, hostSig: host.hostSigPub, iat: now, exp: now + 1e9 }), acct: 'acct-aaaaaaaaaaaaaaaa' });
    host.start();
    const dev = await generateIdentity(false);
    const ring = new KemKeyring(false); const k = await ring.init(now);
    store.saveDevices([{ id: dev.id, name: 'p', sig: b64u(dev.pub), kem: b64u(k.pair.pub), kemEpoch: 0, cert: { j: 'x', s: 'y'.repeat(86) }, pairedAt: now, lastSeen: null }]);
    await host.init();
    expect(host.ring.current.epoch).toBe(0);

    now += 8 * 86_400_000;
    expect(await host.maybeRotate()).toBe(false); // the device was never seen: do not strand it
    const devs = store.devices(); devs[0]!.lastSeen = now - 3600_000; store.saveDevices(devs); await host.init();
    expect(await host.maybeRotate()).toBe(true);
    expect(host.ring.current.epoch).toBe(1);
    expect(host.ring.lookup(0)).toBeDefined(); // grace
    expect(s.frames).toHaveLength(1);
    const opened = await openMessage(s.frames[0]!, { me: { id: dev.id, ring }, senderKey: () => host.identity.pub, guard: new ReplayGuard(), now });
    expect(opened).toMatchObject({ ok: true, msg: { kind: 'keyupdate', data: { ep: 1 } } });
    expect(unb64u((opened as { msg: { data: { kem: string } } }).msg.data.kem)).toEqual(host.ring.current.pair.pub);

    now += 49 * 3_600_000;
    await host.housekeeping();
    expect(host.ring.lookup(0)).toBeUndefined(); // deleted: forward secrecy
  });
});

describe('CLI process behaviour', () => {
  const run = (args: string[], env: Record<string, string>, input?: string) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', cli, ...args], { env: { ...process.env, ...env }, input, encoding: 'utf8', timeout: 20_000 });

  it('the hook command prints nothing and exits 0 when no daemon is running (fails open)', () => {
    const r = run(['hook', 'PermissionRequest', MARKER], { BOTWARREN_COMPANION_HOME: join(tmp(), 'none') }, '{"session_id":"x"}');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('claude install-hooks shows the diff, needs a yes, and uninstall-hooks restores the file', () => {
    const claude = tmp(); const home = join(tmp(), 'h');
    const env = { CLAUDE_CONFIG_DIR: claude, BOTWARREN_COMPANION_HOME: home };
    writeFileSync(join(claude, 'settings.json'), JSON.stringify({ theme: 'dark' }, null, 2));
    const no = run(['claude', 'install-hooks'], env, 'n\n');
    expect(no.stdout).toContain('This will change');
    expect(no.stdout).toContain(MARKER);
    expect(JSON.parse(readFileSync(join(claude, 'settings.json'), 'utf8'))).toEqual({ theme: 'dark' });
    const yes = run(['claude', 'install-hooks', '--yes'], env);
    expect(yes.status).toBe(0);
    expect(hasOurHooks(readSettings(join(claude, 'settings.json')))).toBe(true);
    expect(readdirSync(claude).some((f) => f.includes('bw-backup'))).toBe(true);
    const un = run(['claude', 'uninstall-hooks'], env);
    expect(un.status).toBe(0);
    expect(JSON.parse(readFileSync(join(claude, 'settings.json'), 'utf8'))).toEqual({ theme: 'dark' });
  });

  it('enroll refuses a ticket for another computer, an expired one, and a relay that is not allowed', async () => {
    const home = join(tmp(), 'h'); const env = { BOTWARREN_COMPANION_HOME: home };
    const initOut = JSON.parse(run(['init', '--json'], env).stdout) as { hostId: string; hostSig: string };
    const server = await generateIdentity(true);
    const mk = async (over: Record<string, unknown>) => JSON.stringify({ v: 1, relayUrl: 'wss://relay.botwarren.com', acct: 'acct-aaaaaaaaaaaaaaaa', ticket: await signTicket(server, { v: 1, acct: 'acct-aaaaaaaaaaaaaaaa', host: initOut.hostId, hostSig: initOut.hostSig, iat: Date.now(), exp: Date.now() + 1e9, ...over } as never) });
    const other = await generateIdentity(true);
    expect(run(['enroll'], env, await mk({ host: other.id, hostSig: b64u(other.pub) })).status).toBe(1);
    expect(run(['enroll'], env, await mk({ exp: Date.now() - 1000 })).status).toBe(1);
    const bad = JSON.parse(await mk({})); bad.relayUrl = 'wss://evil.example';
    expect(run(['enroll'], env, JSON.stringify(bad)).status).toBe(1);
    expect(run(['enroll'], env, await mk({})).status).toBe(0);
    expect(new Store(home).enrollment()?.relayUrl).toBe('wss://relay.botwarren.com');
  });

  it('prints help and a QR-capable pair path is wired (qrText renders)', async () => {
    const { qrText } = await import('../src/commands.ts');
    expect(qrText('https://relay.example/#/pair/AAAA-BBBB-CCCC-DDDD').split('\n').length).toBeGreaterThan(10);
    expect(run(['help'], { BOTWARREN_COMPANION_HOME: tmp() }).stdout).toContain('botwarren-companion');
  });
});

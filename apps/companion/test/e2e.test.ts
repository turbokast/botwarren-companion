import { afterEach, describe, expect, it } from 'vitest';
import { assistant, startWorld, transcript, type World } from './world.ts';
import type { SimDevice } from './simdevice.ts';
import type { Frame, Pending } from '../src/protocol/index.ts';

let w: World | null = null;
afterEach(async () => { await w?.close(); w = null; });

const pending = (d: SimDevice): (Pending & { sid: string }) | undefined => {
  const s = d.latest?.sessions.find((x) => x.pending);
  return s?.pending ? { ...s.pending, sid: s.sid } : undefined;
};
const waitPending = (d: SimDevice) => d.waitFor(() => pending(d));
const ask = (d: SimDevice, p: Pending & { sid: string }, a: 'approve' | 'deny' | 'reply', extra: { opt?: string; bind?: string; rid?: string; now?: number } = {}) =>
  d.act({ rid: extra.rid ?? p.rid, sid: p.sid, a, bind: extra.bind ?? p.bind, ...(extra.opt ? { opt: extra.opt } : {}) }, extra.now ?? d.clock());
const hookIn = (event: string, extra: Record<string, unknown> = {}) => ({ session_id: 'sess-1', cwd: '/work/dragon-game', hook_event_name: event, ...extra });

describe('pairing', () => {
  it('pairs only after the person at the computer confirms, and both sides show the same number', async () => {
    w = await startWorld();
    const d = await w.pairDevice('Mia phone');
    expect(w.daemon.host.listDevices().map((x) => x.name)).toEqual(['Mia phone']);
    const log = w.daemon.store.auditTail(50).join('\n');
    expect(log).toContain('device_paired');
    expect(log).not.toContain('Mia phone'); // names are not even written to the audit log
    await d.waitFor(() => d.latest);
  });

  it('a declined pairing issues nothing; a wrong or expired code reaches nothing', async () => {
    w = await startWorld();
    const { connectDaemon } = await import('../src/ipc.ts');
    const { SimDevice } = await import('./simdevice.ts');
    const link = (await connectDaemon(w.env.BOTWARREN_COMPANION_HOME))!;
    link.onEvent((ev) => { if (ev.t === 'pair_confirm') void link.request('pair_decision', { cid: ev.cid, ok: false }); });
    const r = await link.request('pair_start');
    const d = new SimDevice(w.base);
    const { finish } = await d.pair(String(r.code));
    expect(await finish()).toBe(false);
    expect(w.daemon.host.listDevices()).toHaveLength(0);
    await expect(new SimDevice(w.base).pair('AAAA-BBBB-CCCC-DDDD')).rejects.toThrow(/offer 404/);
    link.close();
  });
});

describe('Claude Code via the channel: approve, deny and safety checks', () => {
  it('shows the permission request on the phone and relays the approval to Claude Code', async () => {
    w = await startWorld();
    const d = await w.pairDevice();
    const ch = await w.channel();
    ch.permissionRequest('abcde', 'Bash', 'Publish the package', 'npm publish --access public');
    const p = await waitPending(d);
    expect(p).toMatchObject({ kind: 'permission', tool: 'Bash', summary: 'Publish the package', preview: 'npm publish --access public', can: { approve: true, reply: false } });
    await ask(d, p, 'approve');
    const line = await ch.waitFor((m) => m.method === 'notifications/claude/channel/permission');
    expect(line.params).toEqual({ request_id: 'abcde', behavior: 'allow' });
    await d.waitFor(() => d.results.find((r) => r.rid === p.rid));
    expect(d.results[0]).toMatchObject({ outcome: 'applied' });
    await d.waitFor(() => !pending(d));
  });

  it('deny is relayed; a second action on the same request is stale', async () => {
    w = await startWorld();
    const d = await w.pairDevice();
    const ch = await w.channel();
    ch.permissionRequest('fghij', 'Write', 'Write a file', '/work/x.ts');
    const p = await waitPending(d);
    await ask(d, p, 'deny');
    expect((await ch.waitFor((m) => m.method === 'notifications/claude/channel/permission')).params).toEqual({ request_id: 'fghij', behavior: 'deny' });
    await ask(d, p, 'approve');
    await d.waitFor(() => d.results.filter((r) => r.outcome === 'stale').length === 1);
    expect(ch.lines.filter((m) => m.method === 'notifications/claude/channel/permission')).toHaveLength(1);
  });

  it('refuses an approval for something other than what was shown (bind mismatch), a wrong request id, and an expired request', async () => {
    let t = Date.now();
    w = await startWorld({ now: () => t });
    const d = await w.pairDevice();
    const ch = await w.channel();
    ch.permissionRequest('mnopq', 'Bash', 'Run', 'ls');
    const p = await waitPending(d);
    await ask(d, p, 'approve', { bind: 'f'.repeat(64) });
    await d.waitFor(() => d.results.find((r) => r.outcome === 'stale'));
    await ask(d, p, 'approve', { rid: 'zzzz-zzzzzz' });
    await d.waitFor(() => d.results.filter((r) => r.outcome === 'stale').length === 2);
    t += 11 * 60_000; // past the request's life (the device's clock moves with the host's)
    d.clock = () => t;
    await ask(d, p, 'approve');
    await d.waitFor(() => d.results.find((r) => r.outcome === 'expired'));
    expect(ch.lines.filter((m) => m.method === 'notifications/claude/channel/permission')).toHaveLength(0);
  });

  it('an unpaired device, a revoked device and a replayed frame cannot act', async () => {
    w = await startWorld();
    const d = await w.pairDevice('one');
    const d2 = await w.pairDevice('two');
    const ch = await w.channel();
    ch.permissionRequest('pqrst', 'Bash', 'Run', 'ls');
    const p = await waitPending(d);
    await d2.waitFor(() => pending(d2));

    // replaying a captured valid frame is dropped, the first one counts
    const frame: Frame = await ask(d, p, 'approve');
    await d.waitFor(() => d.results.find((r) => r.outcome === 'applied'));
    d.conn!.sendFrame(frame);
    await new Promise((r) => setTimeout(r, 300));
    expect(ch.lines.filter((m) => m.method === 'notifications/claude/channel/permission')).toHaveLength(1);
    expect(w.daemon.store.auditTail(80).join('\n')).toContain('"code":"replay"');

    // revoke device two: the host stops listening to it and tells it
    ch.permissionRequest('uvwxy', 'Bash', 'Run again', 'pwd');
    const p2 = await d2.waitFor(() => { const x = pending(d2); return x && x.summary === 'Run again' ? x : undefined; });
    expect(await w.daemon.host.revokeDevice('two')).toBe(true);
    await d2.waitFor(() => d2.revoked);
    await ask(d2, p2, 'approve');
    await new Promise((r) => setTimeout(r, 300));
    expect(ch.lines.filter((m) => m.method === 'notifications/claude/channel/permission')).toHaveLength(1);
  });

  it('pause stops all answering at once, rate limits apply, and the audit log never holds content', async () => {
    w = await startWorld();
    const d = await w.pairDevice();
    const ch = await w.channel();
    w.setConfig({ paused: true });
    ch.permissionRequest('aaaab', 'Bash', 'Run SECRET-CANARY-summary', 'echo SECRET-CANARY-preview');
    const p = await waitPending(d);
    await ask(d, p, 'approve');
    await d.waitFor(() => d.results.find((r) => r.outcome === 'paused'));
    w.setConfig({ paused: false, maxActionsPerMinute: 1 });
    (w.daemon.host as unknown as { limiter: unknown }).limiter = null;
    await ask(d, p, 'approve');
    await d.waitFor(() => d.results.find((r) => r.outcome === 'applied'));
    ch.permissionRequest('aaaac', 'Bash', 'Run 2', 'ls');
    const p2 = await d.waitFor(() => { const x = pending(d); return x && x.summary === 'Run 2' ? x : undefined; });
    await ask(d, p2, 'approve');
    await d.waitFor(() => d.results.find((r) => r.outcome === 'rate_limited'));
    const log = w.daemon.store.auditTail(200).join('\n');
    expect(log).not.toContain('CANARY');
    expect(log).not.toContain('echo');
  });

  it('local confirmation: when required, the approval waits for a yes on the computer; "no" denies', async () => {
    w = await startWorld();
    const d = await w.pairDevice();
    const ch = await w.channel();
    w.setConfig({ confirm: { approve: 'always', reply: 'off' } });
    ch.permissionRequest('bbbba', 'Bash', 'Deploy', 'deploy --prod');
    const p = await waitPending(d);
    await ask(d, p, 'approve');
    await d.waitFor(() => d.results.find((r) => r.outcome === 'needs_local'));
    expect(ch.lines.filter((m) => m.method === 'notifications/claude/channel/permission')).toHaveLength(0);
    const seen: string[] = [];
    const stop = w.daemon.hub.watch((cid, req) => { seen.push(`${req.kind}:${req.tool}:${req.device}`); w!.daemon.hub.decide(cid, false); });
    await d.waitFor(() => d.results.find((r) => r.outcome === 'denied'));
    stop();
    expect(seen[0]).toBe('approve:Bash:Sim phone');
    expect((await ch.waitFor((m) => m.method === 'notifications/claude/channel/permission')).params).toEqual({ request_id: 'bbbba', behavior: 'deny' });

    ch.permissionRequest('bbbbb', 'Bash', 'Deploy 2', 'deploy --staging');
    const p2 = await d.waitFor(() => { const x = pending(d); return x && x.summary === 'Deploy 2' ? x : undefined; });
    await ask(d, p2, 'approve');
    const stop2 = w.daemon.hub.watch((cid) => { w!.daemon.hub.decide(cid, true); });
    await ch.waitFor((m) => (m.params as { request_id?: string } | undefined)?.request_id === 'bbbbb');
    stop2();
  });
});

describe('quick replies and what the phone sees', () => {
  it('after Claude stops, the phone sees the last assistant messages (masked) and can send only a preset reply', async () => {
    w = await startWorld();
    const d = await w.pairDevice();
    const ch = await w.channel();
    const tp = transcript(w.claudeDir, [
      { type: 'user', message: { role: 'user', content: 'USER-PROMPT-NOT-SHOWN' } },
      assistant('I fixed the login redirect.'),
      { type: 'tool_result', content: 'TOOL-OUTPUT-NOT-SHOWN' },
      assistant(`The deploy token is ${['gh', 'p_'].join('')}abcdefghijklmnopqrstuvwxyz0123456789AB, do not share it.`),
      assistant('Shall I publish 0.4.1?'),
    ]);
    await w.hook('Stop', hookIn('Stop', { transcript_path: tp }));
    const p = await waitPending(d);
    expect(p).toMatchObject({ kind: 'idle', can: { approve: false, reply: true } });
    const sess = d.latest!.sessions[0]!;
    expect(sess.recent.map((r) => r.text)).toEqual(['I fixed the login redirect.', 'The deploy token is [token], do not share it.', 'Shall I publish 0.4.1?']);
    const wire = JSON.stringify(d.latest);
    expect(wire).not.toContain('USER-PROMPT');
    expect(wire).not.toContain('TOOL-OUTPUT');
    expect(wire).not.toContain('ghp_');

    // the device sends a preset id; the text that reaches Claude Code is the host's text
    await ask(d, p, 'reply', { opt: 'continue' });
    const msg = await ch.waitFor((m) => m.method === 'notifications/claude/channel');
    expect(msg.params).toMatchObject({ content: 'Please continue.', meta: { via: 'botwarren_companion', device: 'Sim_phone', preset: 'continue' } });

    // an id that is not a preset is refused; there is no field for free text at all
    await w.hook('Stop', hookIn('Stop', { transcript_path: tp }));
    const p2 = await d.waitFor(() => { const x = pending(d); return x && x.rid !== p.rid ? x : undefined; });
    await ask(d, p2, 'reply', { opt: 'rm-rf' });
    await d.waitFor(() => d.results.find((r) => r.outcome === 'rejected'));
    expect(ch.lines.filter((m) => m.method === 'notifications/claude/channel')).toHaveLength(1);
  });

  it('without a channel the phone is told it can only look: replies and approvals are refused', async () => {
    w = await startWorld();
    const d = await w.pairDevice();
    await w.hook('Stop', hookIn('Stop'));
    const p = await waitPending(d);
    expect(p.can).toEqual({ approve: false, reply: false });
    await ask(d, p, 'reply', { opt: 'continue' });
    await d.waitFor(() => d.results.find((r) => r.outcome === 'rejected'));
  });

  it('local presets are the only replies; presets edited locally show up on the phone', async () => {
    w = await startWorld();
    w.setConfig({ presets: [{ id: 'ship', label: 'Ship it', text: 'Ship it.', affirm: true }] });
    const d = await w.pairDevice();
    await w.channel();
    await w.hook('Stop', hookIn('Stop'));
    await waitPending(d);
    expect(d.latest!.presets).toEqual([{ id: 'ship', label: 'Ship it' }]);
  });

  it('a user prompt typed at the terminal clears the waiting state on the phone', async () => {
    w = await startWorld();
    const d = await w.pairDevice();
    await w.hook('Stop', hookIn('Stop'));
    await waitPending(d);
    await w.hook('UserPromptSubmit', hookIn('UserPromptSubmit'));
    await d.waitFor(() => !pending(d) && d.latest!.sessions[0]?.status === 'working');
  });
});

describe('hooks without the channel', () => {
  it('fails open: no daemon means no output and no delay', async () => {
    w = await startWorld();
    const { runHook } = await import('../src/claude/hookClient.ts');
    const t = Date.now();
    expect(await runHook('PermissionRequest', '{}', { BOTWARREN_COMPANION_HOME: '/nonexistent/dir' })).toBeNull();
    expect(Date.now() - t).toBeLessThan(500);
  });

  it('holdSeconds 0 (default): reports the request, never holds, and approvals from the phone are refused', async () => {
    w = await startWorld();
    const d = await w.pairDevice();
    const t = Date.now();
    const out = await w.hook('PermissionRequest', hookIn('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'make deploy', description: 'Deploy' } }));
    expect(out).toBeNull();
    expect(Date.now() - t).toBeLessThan(2000);
    const p = await waitPending(d);
    expect(p).toMatchObject({ kind: 'permission', tool: 'Bash', summary: 'Deploy', preview: 'make deploy', can: { approve: false } });
    await ask(d, p, 'approve');
    await d.waitFor(() => d.results.find((r) => r.outcome === 'rejected'));
  });

  it('holdSeconds > 0: holds the hook, answers it from the phone, and releases it when the person answers at the terminal', async () => {
    w = await startWorld();
    w.setConfig({ holdSeconds: 20 });
    const d = await w.pairDevice();
    const held = w.hook('PermissionRequest', hookIn('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'make deploy' } }));
    const p = await waitPending(d);
    expect(p.can.approve).toBe(true);
    await ask(d, p, 'approve');
    const out = JSON.parse((await held)!);
    expect(out).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });

    const held2 = w.hook('PermissionRequest', hookIn('PermissionRequest', { tool_name: 'Write', tool_input: { file_path: '/work/x' } }));
    const p2 = await d.waitFor(() => { const x = pending(d); return x && x.tool === 'Write' ? x : undefined; });
    await ask(d, p2, 'deny');
    const out2 = JSON.parse((await held2)!);
    expect(out2.hookSpecificOutput.decision.behavior).toBe('deny');
    expect(out2.hookSpecificOutput.decision.message).toContain('Sim phone');

    // answered at the terminal instead: PostToolUse arrives, the pending request disappears and the held hook is released with no decision
    const held3 = w.hook('PermissionRequest', hookIn('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'ls' } }));
    await d.waitFor(() => { const x = pending(d); return x && x.preview === 'ls'; });
    await w.hook('PostToolUse', hookIn('PostToolUse', { tool_name: 'Bash' }));
    expect(await held3).toBeNull();
    await d.waitFor(() => !pending(d));
  });

  it('a question with options is shown with its options', async () => {
    w = await startWorld();
    const d = await w.pairDevice();
    await w.hook('PermissionRequest', hookIn('PermissionRequest', { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Which fix?', header: 'Fix', options: [{ label: 'Change cookie settings', description: 'x' }, { label: 'Add a route', description: 'y' }], multiSelect: false }] } }));
    const p = await waitPending(d);
    expect(p).toMatchObject({ kind: 'question', summary: 'Which fix?', options: [{ id: 'o1', label: 'Change cookie settings' }, { id: 'o2', label: 'Add a route' }] });
  });

  it('the local socket refuses a caller without the install secret', async () => {
    w = await startWorld();
    const { createConnection } = await import('node:net');
    const { socketPath } = await import('../src/paths.ts');
    const reply = await new Promise<string>((ok) => {
      const s = createConnection(socketPath(w!.env.BOTWARREN_COMPANION_HOME));
      s.setEncoding('utf8'); let b = '';
      s.on('connect', () => s.write(JSON.stringify({ id: 1, token: 'wrong', op: 'status' }) + '\n'));
      s.on('data', (c: string) => { b += c; });
      s.on('close', () => ok(b));
    });
    expect(JSON.parse(reply.trim())).toMatchObject({ ok: false, error: 'unauthorized' });
  });
});

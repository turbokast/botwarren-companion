/**
 * Playwright, remote control screens (design board "Remote control" R1 to R15, D1 to D3, Botwarren Claude Design project). The real client app runs on a
 * scripted ControlApi (client/test/mock.ts) under the relay's own Content-Security-Policy, so a script, inline style or eval would fail the run. The wire
 * (protocol 3) is the core branch's; here every call the screens make is recorded and asserted, and hostile agent text is checked to stay inert.
 *
 * Run only as: nice -n 15 flock /tmp/botwarren-playwright.lock pnpm exec playwright test --workers=1 e2e/remote-control.spec.ts
 */
import { test, expect, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CSession, ControlHost, Tail } from '../client/src/control/types.ts';
import { permission, sess } from '../client/test/mock.ts';
import type { MockApi } from '../client/test/mock.ts';

const here = dirname(fileURLToPath(import.meta.url));
const SHOTS = process.env.BW_SHOTS ?? resolve(here, '../../../.data/shots/remote-control');
let server: Server; let base = '';
const CSP = `default-src 'none'; script-src 'self' blob:; worker-src 'self'; style-src 'self' blob:; img-src 'self' data:; manifest-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`;

test.beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bw-rc-'));
  await build({ entryPoints: [join(here, '../client/test/harness.ts')], bundle: true, format: 'esm', target: 'es2022', platform: 'browser', outfile: join(dir, 'harness.js'), logLevel: 'silent' });
  copyFileSync(join(here, '../client/app.css'), join(dir, 'app.css'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>Botwarren Link</title><link rel="stylesheet" href="app.css"></head><body><div id="root"></div><script type="module" src="harness.js"></script></body></html>');
  mkdirSync(SHOTS, { recursive: true });
  server = createServer((req, res) => {
    const f = (req.url ?? '/').split('?')[0] === '/harness.js' ? 'harness.js' : (req.url ?? '/').split('?')[0] === '/app.css' ? 'app.css' : 'index.html';
    res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : f.endsWith('.css') ? 'text/css' : 'text/html', 'content-security-policy': CSP, 'cache-control': 'no-store' });
    res.end(readFileSync(join(dir, f)));
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
test.afterAll(async () => { await new Promise((ok) => server.close(ok)); });

interface Seed { host?: Partial<ControlHost>; sessions: CSession[]; tails?: Record<string, Partial<Tail> & Pick<Tail, 'lines'>>; stepUpSupported?: boolean }
const problems = new WeakMap<Page, string[]>();

async function open(page: Page, seed: Seed, hash = '', ready = 'machine'): Promise<void> {
  const errs: string[] = [];
  problems.set(page, errs);
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (/content security policy|refused to/i.test(m.text())) errs.push(m.text()); });
  await page.addInitScript((s) => { (window as unknown as { __seed: unknown }).__seed = s; }, seed);
  await page.goto(`${base}/${hash}`);
  await expect(page.getByTestId(ready)).toBeVisible();
}
const call = (page: Page, body: string): Promise<unknown> => page.evaluate(`(async () => { const m = window.__bw; ${body} })()`);
const calls = async (page: Page): Promise<MockApi['calls']> => (await page.evaluate('window.__bw.calls')) as MockApi['calls'];
const shot = (page: Page, name: string): Promise<Buffer> => page.screenshot({ path: join(SHOTS, `${name}.png`) });
const noProblems = (page: Page): void => { expect(problems.get(page) ?? []).toEqual([]); };

const NOW = (): number => Date.now();
const lines = (rows: [Tail['lines'][number]['kind'], string][]): Tail['lines'] => rows.map(([kind, text], i) => ({ kind, text, ts: NOW() - (rows.length - i) * 1000 }));

const fleet = (): CSession[] => [
  sess({ sid: 'dragon01', label: 'dragon-game', model: 'opus-5.5', effort: 3, route: 'through the Claude channel', pending: permission(1, 'Bash', 'Run a command', 'docker build -t registry.example.com/dragon-game/api:1.14.0 .\ndocker push registry.example.com/dragon-game/api:1.14.0', { risk: ['network', 'outside_workspace'], denyWith: ['no'] }) }),
  sess({ sid: 'warren01', label: 'botwarren', status: 'working', model: 'sonnet-5.5', effort: 2, route: 'through the Claude channel', prompt: { ok: true, queue: true } }),
  sess({ sid: 'docs0001', label: 'docs-site', status: 'idle', mode: 'bypass', model: 'opus-5.5', effort: 4, prompt: { ok: false, why: 'bypass' } }),
  sess({ sid: 'billing1', label: 'billing-api', status: 'idle', harness: 'codex', model: 'gpt-5.5', effort: 2, prompt: { ok: false, why: 'harness' }, stop: 'none', stopWhy: 'Codex in your terminal cannot be stopped from outside.', tail: false }),
  sess({ sid: 'infra001', label: 'infra-notes', status: 'working', harness: 'opencode', model: 'kimi-k3', prompt: { ok: true }, stop: 'now', pending: undefined }),
  sess({ sid: 'oldspike', label: 'old-spike', status: 'ended', harness: 'opencode', prompt: { ok: false, why: 'ended' }, stop: 'none' }),
];

const baseTail = (): Record<string, Partial<Tail> & Pick<Tail, 'lines'>> => ({
  warren01: { lines: lines([['user', 'Tighten the retry loop, then run the tests.'], ['assistant', 'Reading the retry code first, then I will change the loop to stop after five tries.'], ['tool', '▸ Read src/retry.ts'], ['tool', '▸ Edit src/retry.ts  +12 -4'], ['tool', '▸ Bash  pnpm test retry'], ['output', 'PASS retry.test.ts (14 tests)\nsecret-looking: ghp_[masked]'], ['assistant', 'All 14 tests pass. The loop now stops after five tries and logs the last error.']]) },
  infra001: { lines: lines([['assistant', 'Planning the migration.']]) },
});

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 860 } });

  test('R1 list: machine > agent > session, needs-you first, model and effort, what you may do', async ({ page }) => {
    await open(page, { sessions: fleet(), tails: baseTail() });
    await expect(page.getByTestId('machine')).toContainText('work-desktop');
    await expect(page.getByTestId('conn')).toHaveText('Computer online');
    const groups = await page.getByTestId('harness').allTextContents();
    expect(groups.map((g) => g.replace(/^./, ''))).toEqual(['Claude Code', 'OpenCode', 'Codex']); // the group holding the request first, then the one with a working session, then the idle one
    const rows = page.locator('[data-sid]');
    expect(await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-sid')))).toEqual(['dragon01', 'warren01', 'docs0001', 'infra001', 'oldspike', 'billing1']);
    await expect(page.getByTestId('waiting-row')).toHaveCount(1);
    await expect(page.getByTestId('waiting-count')).toHaveText('Waiting for you · 1');
    const dragon = page.locator('[data-sid="dragon01"]');
    await expect(dragon).toContainText('asks permission');
    await expect(dragon.getByTestId('status-chip')).toHaveText('Needs you');
    await expect(dragon.getByTestId('model-chip')).toContainText('opus-5.5');
    await expect(dragon.getByTestId('model-chip').getByRole('img')).toHaveAttribute('aria-label', 'effort 3 of 5');
    await expect(dragon.getByTestId('cap')).toHaveText('Full control');
    await expect(page.locator('[data-sid="docs0001"]').getByTestId('bypass-tag')).toHaveText('No approval prompts');
    await expect(page.locator('[data-sid="docs0001"]').getByTestId('cap')).toHaveText('Observe only');
    await expect(page.locator('[data-sid="billing1"]').getByTestId('cap')).toHaveText('Approve only');
    await expect(page.locator('[data-sid="oldspike"]').getByTestId('status-chip')).toHaveText('Ended');
    // every row is a 44px+ touch target and nothing overlaps (the first design pass had chips running into the next row)
    const boxes = await rows.evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, h: r.height }; }));
    for (let i = 1; i < boxes.length; i++) expect(boxes[i]!.top).toBeGreaterThanOrEqual(boxes[i - 1]!.bottom - 0.5);
    for (const b of boxes) expect(b.h).toBeGreaterThanOrEqual(64);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await shot(page, 'phone-R1-list');
    noProblems(page);
  });

  test('approve and deny: the card shows the real input and risk tags; Approve means once; the computer is asked exactly once', async ({ page }) => {
    await open(page, { sessions: fleet(), tails: baseTail() });
    await page.getByTestId('waiting-row').click();
    await expect(page.getByTestId('risk')).toContainText('Network');
    await expect(page.getByTestId('risk')).toContainText('Outside the project');
    await expect(page.getByTestId('preview')).toContainText('docker push registry.example.com');
    await expect(page.getByTestId('approve')).toHaveText('Approve once');
    await expect(page.getByTestId('deny-say-no')).toBeVisible();
    await expect(page.getByTestId('approve')).toBeInViewport();
    await shot(page, 'phone-R3-approval');
    await page.getByTestId('approve').click();
    await expect(page.getByTestId('notice')).toContainText('Done');
    expect((await calls(page)).answer).toEqual([{ sid: 'dragon01', a: 'approve' }]);
  });

  test('answer a question: options answer at once; free text goes through the step-up sheet', async ({ page }) => {
    const q = sess({ sid: 'infra001', label: 'infra-notes', harness: 'opencode', model: 'kimi-k3', stop: 'now', pending: { rid: 'req-0002', kind: 'question', summary: 'Which environment should I run the migration against?', preview: '', expires: Date.now() + 600_000, bind: 'b'.repeat(64), options: [{ id: 'staging', label: 'Staging' }, { id: 'prod', label: 'Production (read only)' }], can: { approve: false, reply: true } } });
    await open(page, { sessions: [q] });
    await page.getByTestId('waiting-row').click();
    await expect(page.getByTestId('pending-summary')).toContainText('Which environment');
    await expect(page.getByText('The agent\'s own words. Botwarren cannot check them.')).toBeVisible();
    await shot(page, 'phone-R4-question');
    await page.getByTestId('opt-prod').click();
    expect((await calls(page)).answer).toEqual([{ sid: 'infra001', a: 'reply', opt: 'prod' }]);
    // free text
    await open(page, { sessions: [q] });
    await page.getByTestId('waiting-row').click();
    await page.getByTestId('compose-input').fill('Staging, but only the billing tables.');
    await page.getByTestId('compose-send').click();
    await expect(page.getByTestId('stepup')).toBeVisible();
    await expect(page.getByTestId('stepup-text')).toHaveText('Staging, but only the billing tables.');
    await page.getByTestId('stepup-confirm').click();
    await expect.poll(async () => (await calls(page)).prompt.length).toBe(1);
    expect((await calls(page)).prompt[0]).toEqual({ sid: 'infra001', text: 'Staging, but only the billing tables.', asAnswer: true });
  });

  test('R2/R5 prompt: counter, limit, Ctrl+Enter, step-up names the exact text, unlock window, draft kept on failure', async ({ page }) => {
    await open(page, { sessions: fleet(), tails: baseTail() });
    await page.locator('[data-sid="warren01"]').click();
    await expect(page.getByTestId('tail-line').first()).toContainText('Tighten the retry loop');
    await expect(page.getByTestId('tail-live')).toHaveText('LIVE');
    await expect(page.getByTestId('compose-count')).toHaveText('0 / 4,000');
    await expect(page.getByTestId('compose-send')).toBeDisabled();
    // the session fills the screen: message box and Stop are both on screen at once and do not overlap
    await expect(page.getByTestId('compose-send')).toBeInViewport();
    await expect(page.getByTestId('stop')).toBeInViewport();
    const cb = (await page.getByTestId('compose').boundingBox())!; const sb = (await page.getByTestId('stop').boundingBox())!;
    expect(sb.y).toBeGreaterThanOrEqual(cb.y + cb.height - 0.5);
    expect(sb.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 1)).toBe(true);
    await shot(page, 'phone-R2-detail');
    const input = page.getByTestId('compose-input');
    await input.fill('x'.repeat(3700));
    await expect(page.getByTestId('compose-count')).toHaveText('3,700 / 4,000');
    await expect(page.getByTestId('compose-count')).toHaveClass(/near/);
    await input.fill('x'.repeat(4001));
    await expect(page.getByTestId('compose-count')).toHaveClass(/over/);
    await expect(page.getByTestId('compose-send')).toBeDisabled();
    await input.fill('😀'.repeat(4000)); // counted as characters, not code units
    await expect(page.getByTestId('compose-count')).toHaveText('4,000 / 4,000');
    await expect(page.getByTestId('compose-send')).toBeEnabled();
    await input.fill('Now run the full suite, and if billing fails, stop and tell me.');
    await expect(page.getByTestId('compose-queue')).toBeVisible(); // this harness takes a message while it works
    await shot(page, 'phone-R5-composer');
    // the first send needs the fingerprint; the sheet shows exactly what will be sent
    await page.getByTestId('compose-send').click();
    await expect(page.getByTestId('stepup')).toBeVisible();
    await expect(page.getByTestId('stepup-text')).toHaveText('Now run the full suite, and if billing fails, stop and tell me.');
    await shot(page, 'phone-R9-stepup');
    // Cancel: nothing is sent and the text stays
    await page.getByTestId('stepup-cancel').click();
    await expect(page.getByTestId('stepup')).toHaveCount(0);
    expect((await calls(page)).prompt).toEqual([]);
    await expect(input).toHaveValue('Now run the full suite, and if billing fails, stop and tell me.');
    // Confirm: sent once, box cleared, 15 minute window starts
    await page.getByTestId('compose-send').click();
    await page.getByTestId('stepup-confirm').click();
    await expect(page.getByTestId('send-note')).toContainText('Sent');
    await expect(input).toHaveValue('');
    expect((await calls(page)).prompt).toEqual([{ sid: 'warren01', text: 'Now run the full suite, and if billing fails, stop and tell me.', asAnswer: false }]);
    // inside the window: no sheet, Ctrl+Enter sends
    await input.fill('Also update the changelog.');
    await input.press('Control+Enter');
    await expect(page.getByTestId('stepup')).toHaveCount(0);
    await expect.poll(async () => (await calls(page)).prompt.length).toBe(2);
    // a refused send keeps the draft and says why
    await call(page, "m.promptResult = 'stale';");
    await input.fill('And bump the version.');
    await page.getByTestId('compose-send').click();
    await expect(page.getByTestId('send-note')).toContainText('This changed');
    await expect(input).toHaveValue('And bump the version.');
    await call(page, "m.promptResult = 'offline';");
    await page.getByTestId('compose-send').click();
    await expect(page.getByTestId('send-note')).toContainText('never held back');
    await expect(input).toHaveValue('And bump the version.');
    noProblems(page);
  });

  test('the draft and the cursor survive a new state arriving while typing', async ({ page }) => {
    await open(page, { sessions: fleet(), tails: baseTail() });
    await page.locator('[data-sid="warren01"]').click();
    const input = page.getByTestId('compose-input');
    await input.fill('half a sentence');
    await input.focus();
    await call(page, "m.setTail('warren01', { lines: [{ kind: 'assistant', text: 'Another line arrived', ts: Date.now() }] });");
    await expect(page.getByTestId('tail-line').last()).toContainText('Another line arrived');
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('half a sentence');
    await page.keyboard.type(' and more');
    await expect(input).toHaveValue('half a sentence and more');
  });

  test('R6/R7 disabled composers say why and what to do (bypass, harness, scope, control off, read only, old computer, ended)', async ({ page }) => {
    const cases: { sid: string; host?: Partial<ControlHost>; why: string; text: RegExp }[] = [
      { sid: 'docs0001', why: 'bypass', text: /control\.allowBypass/ },
      { sid: 'billing1', why: 'harness', text: /not type to it/ },
      { sid: 'warren01', host: { scope: 'answer' }, why: 'scope', text: /devices grant Phone control/ },
      { sid: 'warren01', host: { control: 'off' }, why: 'off', text: /control on/ },
      { sid: 'warren01', host: { control: 'readonly' }, why: 'readonly', text: /read only/ },
      { sid: 'warren01', host: { supported: false }, why: 'host_old', text: /too old/ },
      { sid: 'oldspike', why: 'ended', text: /has ended/ },
      { sid: 'warren01', host: { paused: true }, why: 'paused', text: /paused/ },
    ];
    for (const c of cases) {
      await open(page, { host: c.host ?? {}, sessions: fleet(), tails: baseTail() }, '');
      await page.locator(`[data-sid="${c.sid}"]`).click();
      await expect(page.getByTestId('compose-why'), c.why).toHaveAttribute('data-why', c.why);
      await expect(page.getByTestId('compose-why'), c.why).toContainText(c.text);
      await expect(page.getByTestId('compose-input'), c.why).toBeDisabled();
      await expect(page.getByTestId('compose-send'), c.why).toBeDisabled();
      if (c.why === 'bypass') await shot(page, 'phone-R6-disabled-bypass');
      if (c.why === 'harness') await shot(page, 'phone-R7-disabled-harness');
    }
  });

  test('R8 Stop: soft stop is explained, three honest outcomes, never asks for a fingerprint; no button when it cannot be stopped', async ({ page }) => {
    await open(page, { sessions: fleet(), tails: baseTail() });
    await page.locator('[data-sid="warren01"]').click();
    await expect(page.getByTestId('stop')).toContainText('Stops at the next tool call');
    await expect(page.getByText('finishes the step it is on')).toBeVisible();
    await call(page, "m.stopDelay = 400;");
    await page.getByTestId('stop').click();
    await expect(page.getByTestId('stop-note')).toContainText('Stopping');
    await shot(page, 'phone-R8-stopping');
    await expect(page.getByTestId('stop-note')).toContainText('stopped before its next step');
    await expect(page.getByTestId('stepup')).toHaveCount(0);
    expect((await calls(page)).stop).toEqual(['warren01']);
    await call(page, "m.stopStages = ['stopping', 'failed'];");
    await page.getByTestId('stop').click();
    await expect(page.getByTestId('stop-note')).toContainText('Could not stop it');
    await call(page, "m.stopStages = ['stopped_now'];");
    await page.getByTestId('stop').click();
    await expect(page.getByTestId('stop-note')).toHaveText('Stopped now.');
    await page.reload();
    await page.locator('[data-sid="billing1"]').click();
    await expect(page.getByTestId('stop')).toHaveCount(0);
    await expect(page.getByTestId('stop-why')).toContainText('cannot be stopped from outside');
    await page.reload();
    await page.locator('[data-sid="infra001"]').click();
    await expect(page.getByTestId('stop')).toContainText('Stops at once');
  });

  test('step-up sheet: failure and cancel are shown, no lock on the device means no sheet, start always asks fresh', async ({ page }) => {
    await open(page, { sessions: fleet(), tails: baseTail() });
    await page.locator('[data-sid="warren01"]').click();
    await call(page, "m.stepUpResult = 'failed';");
    await page.getByTestId('compose-input').fill('hello');
    await page.getByTestId('compose-send').click();
    await page.getByTestId('stepup-confirm').click();
    await expect(page.getByTestId('stepup-note')).toContainText('Could not confirm');
    await expect(page.getByTestId('stepup')).toBeVisible();
    await call(page, "m.stepUpResult = 'cancelled';");
    await page.getByTestId('stepup-confirm').click();
    await expect(page.getByTestId('stepup-note')).toContainText('Not confirmed');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('stepup')).toHaveCount(0);
    expect((await calls(page)).prompt).toEqual([]);
    await expect(page.getByTestId('send-note')).toContainText('Not sent');
    // a device without a fingerprint or face lock: no sheet, the computer asks on its own screen
    await open(page, { sessions: fleet(), tails: baseTail(), stepUpSupported: false });
    await page.locator('[data-sid="warren01"]').click();
    await expect(page.getByTestId('compose-route')).toContainText('confirm it there');
    await call(page, "m.promptResult = 'needs_local';");
    await page.getByTestId('compose-input').fill('hello');
    await page.getByTestId('compose-send').click();
    await expect(page.getByTestId('stepup')).toHaveCount(0);
    await expect(page.getByTestId('send-note')).toContainText('on your computer');
  });

  test('R10 start a session: only what the computer lists, never a path, always a fresh step-up, never "no prompts"', async ({ page }) => {
    const launch = [
      { id: 'bw-oc', project: 'botwarren', harness: 'opencode', models: [{ id: 'kimi', label: 'kimi-k3' }, { id: 'glm', label: 'glm-5' }], efforts: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }], modes: [{ id: 'default', label: 'Ask me' }, { id: 'plan', label: 'Plan only' }] },
      { id: 'bw-cc', project: 'botwarren', harness: 'claude-code', models: [{ id: 'opus', label: 'opus-5.5' }], efforts: [{ id: 'high', label: 'High' }], modes: [{ id: 'default', label: 'Ask me' }] },
      { id: 'docs-oc', project: 'docs-site', harness: 'opencode', models: [{ id: 'kimi', label: 'kimi-k3' }], efforts: [], modes: [{ id: 'default', label: 'Ask me' }] },
    ];
    await open(page, { host: { launch }, sessions: fleet(), tails: baseTail() });
    await page.getByTestId('start-open').click();
    await expect(page.getByTestId('start-project-botwarren')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('start-agent-bw-oc')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByText(/without approval prompts is never offered/i)).toBeVisible();
    await expect(page.getByTestId('start-mode-default')).toBeVisible();
    expect(await page.locator('body').innerText()).not.toMatch(/bypass|dangerously|\/home|\\\\/i);
    await page.getByTestId('start-model-glm').click();
    await page.getByTestId('start-effort-high').click();
    await page.getByTestId('start-mode-plan').click();
    await page.getByTestId('start-text').fill('Add the audit page.');
    await shot(page, 'phone-R10-start');
    await page.getByTestId('start-go').click();
    await expect(page.getByTestId('stepup-text')).toHaveText('Add the audit page.');
    await page.getByTestId('stepup-confirm').click();
    await expect(page.getByTestId('notice')).toContainText('Started');
    const c = await calls(page);
    expect(c.start).toEqual([{ id: 'bw-oc', o: { project: 'botwarren', harness: 'opencode', model: 'glm', effort: 'high', mode: 'plan', text: 'Add the audit page.' } }]);
    expect(c.stepUp.at(-1)?.fresh).toBe(true);
    // a second start asks again even though a message was unlocked a moment ago
    await call(page, 'm.unlocked = Date.now() + 600000;');
    await page.getByTestId('start-open').click();
    await page.getByTestId('start-go').click();
    await expect(page.getByTestId('stepup')).toBeVisible();
    await page.getByTestId('stepup-cancel').click();
    await expect(page.getByTestId('start-note')).toContainText('Not started');
    expect((await calls(page)).start).toHaveLength(1);
  });

  test('start with nothing listed, or without the scope, explains itself', async ({ page }) => {
    await open(page, { host: { launch: [] }, sessions: fleet() });
    await page.getByTestId('start-open').click();
    await expect(page.getByTestId('start-empty')).toContainText('never sends a path or a command');
    await open(page, { host: { scope: 'answer', launch: [] }, sessions: fleet() });
    await page.getByTestId('start-open').click();
    await expect(page.getByTestId('start-why')).toContainText('start sessions');
  });

  test('R11 offline, stale, expired: each says what happened; nothing is queued', async ({ page }) => {
    await open(page, { sessions: fleet(), tails: baseTail() });
    await page.locator('[data-sid="warren01"]').click();
    await call(page, "m.patchHost({ online: false, offlineSince: Date.now() - 360000 });");
    await expect(page.getByTestId('banner-offline')).toContainText('Computer offline since');
    await expect(page.getByTestId('banner-offline')).toContainText('Nothing you tap will run later');
    await expect(page.getByTestId('tail-live')).toHaveText('OFFLINE');
    await shot(page, 'phone-R11-offline');
    await call(page, "m.patchHost({ online: true, offlineSince: undefined });");
    await expect(page.getByTestId('banner-offline')).toHaveCount(0);
    await call(page, "m.setTail('warren01', { lines: [{ kind: 'assistant', text: 'old line', ts: Date.now() - 90000 }], updatedAt: Date.now() - 90000 });");
    await expect(page.getByTestId('tail-live')).toHaveText('STALE');
    await expect(page.getByTestId('tail-stale')).toContainText('No update for');
    await page.reload();
    await call(page, "m.answerResult = 'expired';");
    await page.getByTestId('waiting-row').click();
    await page.getByTestId('approve').click();
    await expect(page.getByTestId('notice')).toContainText('Expired');
    await call(page, "m.answerResult = 'stale';");
    noProblems(page);
  });

  test('R14 kill switch: control off or read only is a banner, approvals keep working', async ({ page }) => {
    await open(page, { host: { control: 'off' }, sessions: fleet(), tails: baseTail() });
    await expect(page.getByTestId('banner-control-off')).toContainText('Control switched off on your computer');
    await expect(page.getByTestId('control-chip')).toHaveText('Control off');
    await shot(page, 'phone-R14-control-off');
    await page.getByTestId('waiting-row').click();
    await expect(page.getByTestId('approve')).toBeEnabled();
    await call(page, "m.patchHost({ control: 'readonly' });");
    await expect(page.getByTestId('banner-readonly')).toContainText('read only');
    await expect(page.getByTestId('stop')).toHaveCount(0);
  });

  test('R12 audit trail: what this device did, lengths only', async ({ page }) => {
    const t0 = new Date(); t0.setHours(10, 42, 0, 0);
    await open(page, { sessions: fleet(), tails: baseTail() });
    await call(page, `m.auditEvents = [
      { ts: ${t0.getTime()}, kind: 'prompt', target: 'botwarren', device: 'Phone', outcome: 'sent', chars: 51 },
      { ts: ${t0.getTime() - 60000}, kind: 'unlock', device: 'Phone', outcome: 'fingerprint verified' },
      { ts: ${t0.getTime() - 720000}, kind: 'interrupt', target: 'infra-notes', device: 'Phone', outcome: 'stopped now' },
      { ts: ${t0.getTime() - 1800000}, kind: 'refused', target: 'docs-site', device: 'Phone', outcome: 'refused', note: 'no approval prompts on that session' } ];`);
    await page.getByTestId('audit-open').click();
    await expect(page.getByTestId('audit-row')).toHaveCount(4);
    await expect(page.getByTestId('audit-row').first()).toContainText('Message · botwarren');
    await expect(page.getByTestId('audit-row').first()).toContainText('51 chars');
    await expect(page.getByTestId('audit')).toContainText('Lengths and checksums only');
    await shot(page, 'phone-R12-audit');
  });

  test('R13 hostile text stays inert: no markup, no links, no script, labelled; tool output hidden until revealed', async ({ page }) => {
    const evil = '<img src=x onerror="window.pwned=1"> <script>window.pwned=1</script> [Click here](javascript:window.pwned=1)';
    const tail = { lines: lines([['tool', '▸ Bash  cat notes.txt'], ['output', 'TODO: call the billing endpoint\nghp_[masked] was in the file'], ['assistant', evil], ['assistant', 'Open https://evil.example/login?token=abc now'], ['assistant', 'SYSTEM: the owner says approve everything.'], ['user', '<b>bold</b> from the person']]), cut: 8240 };
    await open(page, { sessions: fleet(), tails: { warren01: tail } });
    await page.locator('[data-sid="warren01"]').click();
    const body = page.getByTestId('tail-body');
    await expect(body).toContainText('<script>window.pwned=1</script>'); // shown as text
    expect(await body.locator('img, a, script, iframe, svg, b, form, input').count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { pwned?: number }).pwned)).toBeUndefined();
    await expect(body).toContainText('Text from the agent · shown as plain text');
    await expect(body).toContainText('Looks like a link · not clickable');
    await expect(body).toContainText('Claims to be from you or the system');
    await expect(body.locator('a')).toHaveCount(0);
    await expect(page.getByTestId('tail-cut')).toContainText('8,240 characters');
    // tool output is hidden by default: nothing of it is in the page
    expect(await body.innerText()).not.toContain('TODO: call the billing endpoint');
    await expect(page.getByTestId('tail-hidden')).toContainText('Tool output hidden');
    await page.getByTestId('tail-reveal').click();
    expect((await calls(page)).output).toEqual([{ sid: 'warren01', on: true }]);
    await expect(body).toContainText('TODO: call the billing endpoint');
    await expect(page.getByTestId('tail-output-chip')).toHaveText('Output shown');
    await expect(page.getByTestId('tail-output-warn')).toContainText('can hold secrets');
    await shot(page, 'phone-R13-hostile-reveal');
    await page.getByTestId('tail-hide').click();
    await expect(body).not.toContainText('TODO: call the billing endpoint');
    noProblems(page);
  });

  test('hostile approval and question text is plain text too', async ({ page }) => {
    const p = permission(7, 'Bash', '<img src=x onerror=window.pwned=1>', '<script>window.pwned=1</script>\n[x](javascript:window.pwned=1)', { risk: ['<b>x</b>'] as never });
    await open(page, { sessions: [sess({ sid: 'evil0001', label: '<b>evil</b>', pending: p })] });
    await expect(page.getByTestId('waiting-row')).toContainText('<b>evil</b>');
    await page.getByTestId('waiting-row').click();
    await expect(page.getByTestId('preview')).toContainText('<script>window.pwned=1</script>');
    expect(await page.locator('#root img, #root script, #root a, #root b').count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { pwned?: number }).pwned)).toBeUndefined();
    noProblems(page);
  });

  test('R15 station link: #/open/<ref> opens that robot\'s session; an unknown ref says so', async ({ page }) => {
    const list = fleet().map((s) => (s.sid === 'warren01' ? { ...s, station: 'wren-7f3a' } : s));
    await open(page, { sessions: list, tails: baseTail() }, '#/open/wren-7f3a', 'session-head');
    await expect(page.getByTestId('session-head')).toContainText('Claude Code');
    await expect(page.getByTestId('compose-input')).toBeVisible();
    expect(page.url()).not.toContain('#/open');
    await open(page, { sessions: list, tails: baseTail() }, '#/open/nobody-123');
    await expect(page.getByTestId('notice')).toContainText('not one of the sessions on your computer');
  });
});

test.describe('desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('D1 two panes: sessions left, open session right with approval, tail, composer, Stop; Esc never stops', async ({ page }) => {
    await open(page, { sessions: fleet(), tails: baseTail() });
    // the request is selected first; pick the working one
    await expect(page.getByTestId('detail')).toContainText('dragon-game');
    await page.locator('[data-sid="warren01"]').click();
    await expect(page.locator('#root')).toHaveClass(/split/);
    await expect(page.getByTestId('tail-body')).toBeVisible();
    await expect(page.locator('[data-sid="warren01"]')).toHaveAttribute('aria-current', 'true');
    await expect(page.getByTestId('compose-input')).toBeVisible();
    await expect(page.getByTestId('stop')).toBeVisible();
    await page.getByTestId('compose-input').fill('Run it again.');
    await page.keyboard.press('Escape');
    expect((await calls(page)).stop).toEqual([]);
    // the whole session fits without the page scrolling
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 1)).toBe(true);
    await shot(page, 'desktop-D1-two-pane');
    // the request is a card in the right pane with the buttons next to the text
    await page.locator('[data-sid="dragon01"]').click();
    await expect(page.getByTestId('approve')).toBeVisible();
    await shot(page, 'desktop-D1-approval');
    // step-up is a dialog in the middle, not a bottom sheet
    await page.locator('[data-sid="warren01"]').click();
    await page.getByTestId('compose-input').fill('Ship it.');
    await page.getByTestId('compose-send').click();
    const sheet = await page.getByTestId('stepup').boundingBox();
    expect(sheet!.x).toBeGreaterThan(300);
    expect(sheet!.y + sheet!.height).toBeLessThan(800);
    await shot(page, 'desktop-D2-stepup');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('stepup')).toHaveCount(0);
  });
});

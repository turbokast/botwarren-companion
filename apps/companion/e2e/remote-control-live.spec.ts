/**
 * Playwright, remote control against the REAL host: the signed client served by the real relay, a real daemon with a scripted fake harness (the core's
 * test double: it records exactly what reached the "tool"), a real browser paired like a person would, and a Chrome virtual authenticator for the
 * fingerprint step-up (the host verifies every assertion itself).
 *
 * Until protocol 3 is enabled in the page (client/src/app.ts) the spec skips itself.
 * Run only as: nice -n 15 flock /tmp/botwarren-playwright.lock pnpm exec playwright test --workers=1 e2e/remote-control-live.spec.ts
 */
import { test, expect, type Page } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const HAVE = existsSync(join(here, '../test/support/fake-harness/index.ts')) && existsSync(join(here, '../client/src/stepup.ts')) && /createProtocol3Transport/.test(readFileSync(join(here, '../client/src/app.ts'), 'utf8'));
const SHOTS = process.env.BW_SHOTS ?? resolve(here, '../../../.data/shots/remote-control');
mkdirSync(SHOTS, { recursive: true });

test.skip(!HAVE, 'needs feat/remote-control-core merged and protocol3 enabled in app.ts');
test.use({ viewport: { width: 390, height: 860 } });

test('the screens drive the real host: tail, step-up (virtual authenticator), message, stop, free-text answer, start, hostile text, kill switch', async ({ page, context }) => {
  test.setTimeout(240_000);
  const { startWorld } = await import('../test/world.ts');
  const { FakeHarness } = await import('../test/support/fake-harness/index.ts');
  const { signedClient } = await import('./kit.ts');
  const { connectDaemon } = await import('../src/ipc.ts');

  const dir = await signedClient();
  const w = await startWorld({ clientDir: dir, stateGapMs: 5, tailGapMs: 30, resolveWaitMs: 400, relay: { rates: { connBurst: 100_000, connPerSec: 100_000, acctBurst: 100_000, acctPerSec: 100_000 } } });
  try {
    const fake = new FakeHarness({ followupMs: 10 });
    w.daemon.host.hub.register(fake);
    const cfg = w.daemon.store.config();
    cfg.maxActionsPerMinute = 60; cfg.maxActionsPerHour = 600;
    cfg.control = { ...cfg.control, mode: 'on', launch: [{ id: 'dragons', label: 'Dragon game', harness: 'other', root: '/work/dragon-game', modes: ['default', 'plan'] }], promptsPerMinute: 60, promptsPerHour: 200, startsPerMinute: 30, startsPerHour: 100 } as never;
    // the page is opened as http://localhost:PORT: WebAuthn needs a host name, never an IP address, and the relay and the computer must agree on it
    const port = new URL(w.base).port;
    const origin = `http://localhost:${port}`;
    cfg.allowRelayHosts = ['127.0.0.1', 'localhost'];
    w.daemon.store.saveConfig(cfg);
    w.relay.origin = origin;
    const enrol = join(w.env.BOTWARREN_COMPANION_HOME, 'enrollment.json');
    writeFileSync(enrol, JSON.stringify({ ...JSON.parse(readFileSync(enrol, 'utf8')), relayUrl: origin }));
    // the person at the computer says yes to everything the computer asks
    w.daemon.hub.watch((cid) => { queueMicrotask(() => w.daemon.hub.decide(cid, true)); });

    const cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });

    // ---- pair like a person: code from the computer, six digits compared, yes at the computer
    const link = (await connectDaemon(w.env.BOTWARREN_COMPANION_HOME))!;
    let cid = '';
    link.onEvent((ev) => { if (ev.t === 'pair_confirm') cid = String(ev.cid); });
    const r = await link.request('pair_start');
    await page.goto(origin);
    await page.getByTestId('code').fill(String(r.code).toLowerCase());
    await page.getByTestId('pair-btn').click();
    await expect(page.getByTestId('sas')).toBeVisible();
    await expect.poll(() => cid).not.toBe('');
    await link.request('pair_decision', { cid, ok: true });
    await expect(page.getByTestId('conn')).toHaveText('Computer online');
    link.close();
    expect(w.daemon.host.setDeviceScope('Browser', 'control')).toBe(true);

    // ---- a session appears with its live tail
    fake.spawn('s1');
    fake.say('s1', 'Reading the retry code first.');
    fake.tool('s1', '▸ Read src/retry.ts', 'PASS retry.test.ts');
    const row = page.locator('[data-sid]');
    await expect(row).toHaveCount(1);
    await expect(row.getByTestId('cap')).toHaveText('Full control');
    await shot(page, 'live-R1-list');
    await row.click();
    await expect(page.getByTestId('tail-line').first()).toContainText('Reading the retry code first.');
    await expect(page.getByTestId('tail-hidden')).toContainText('Tool output hidden'); // the computer sends no tool output unless its owner turned it on there
    expect(await page.getByTestId('tail-body').innerText()).not.toContain('PASS retry.test.ts');
    await page.getByTestId('tail-reveal').click();
    await expect(page.getByTestId('tail-reveal-help')).toContainText('botwarren-companion tools');

    // ---- register the fingerprint (the computer asks its owner at the keyboard first), then send a message
    await page.getByTestId('compose-input').fill('Run the full suite.');
    await expect(page.getByTestId('compose-route')).toContainText('confirm it there'); // no lock registered yet: the computer would ask
    await page.getByRole('button', { name: 'Back' }).click();
    await page.getByTestId('gear').click();
    await expect(page.getByTestId('lock-add')).toBeVisible();
    await page.getByTestId('lock-add').click();
    await expect(page.getByTestId('lock-note')).toContainText('Added', { timeout: 20_000 });
    await expect(page.getByTestId('lock-state')).toHaveText('On');
    await page.getByRole('button', { name: 'Back' }).click();
    await page.locator('[data-sid]').click();

    const input = page.getByTestId('compose-input');
    await input.fill('Run the full suite.');
    await page.getByTestId('compose-send').click();
    await expect(page.getByTestId('stepup-text')).toHaveText('Run the full suite.');
    await shot(page, 'live-R9-stepup');
    await page.getByTestId('stepup-confirm').click();
    await expect(page.getByTestId('send-note')).toContainText(/Sent|started on it/, { timeout: 20_000 });
    await expect.poll(() => fake.received.prompts.length).toBe(1);
    expect(fake.received.prompts[0]!.text).toBe('Run the full suite.');
    expect(fake.received.prompts[0]!.framed).toContain('Browser'); // provenance: the paired device's name travels with it
    await expect(input).toHaveValue('');
    await expect(page.getByTestId('tail-body')).toContainText('Run the full suite.');

    // inside the 15 minute window: no sheet
    await input.fill('And the linter.');
    await input.press('Control+Enter');
    await expect.poll(() => fake.received.prompts.length).toBe(2);
    await expect(page.getByTestId('stepup')).toHaveCount(0);

    // ---- stop: the fake is working after the prompt; the computer delivers one interrupt, only once
    fake.work('s1');
    await expect(page.getByTestId('stop')).toBeVisible();
    await page.getByTestId('stop').click();
    await expect(page.getByTestId('stop-note')).toContainText('Stopped now', { timeout: 20_000 });
    expect(fake.received.interrupts).toHaveLength(1);

    // ---- a question with options: an option answers at once, free text goes through the same gates
    await fake.askQuestion('s1', 'Which branch should I use?', [{ id: 'main', label: 'main' }]);
    await expect(page.getByTestId('pending-summary')).toContainText('Which branch', { timeout: 20_000 });
    await page.getByTestId('compose-input').fill('feature/audit, please.');
    await page.getByTestId('compose-send').click();
    await expect.poll(() => fake.received.answers.length, { timeout: 20_000 }).toBe(1);
    expect(fake.received.answers[0]!.text).toBe('feature/audit, please.');

    // ---- start a session: always a fresh assertion, only what the computer lists
    await page.getByRole('button', { name: 'Back' }).click().catch(() => undefined);
    await page.getByTestId('start-open').click();
    await expect(page.getByTestId('start-project-Dragon game')).toBeVisible();
    await shot(page, 'live-R10-start');
    await page.getByTestId('start-mode-plan').click();
    await page.getByTestId('start-text').fill('Add the audit page.');
    await page.getByTestId('start-go').click();
    await expect(page.getByTestId('stepup')).toBeVisible();
    await page.getByTestId('stepup-confirm').click();
    await expect(page.getByTestId('notice')).toContainText('Started', { timeout: 20_000 });
    expect(fake.received.starts).toHaveLength(1);
    expect(fake.received.starts[0]!.first!.text).toBe('Add the audit page.');
    expect(JSON.stringify(fake.received.starts[0]!.launch)).not.toMatch(/--|dangerously|bypass/);
    await expect.poll(() => fake.sessions.has('fake-new-1')).toBe(true); // the tool started the session the computer asked for

    // ---- hostile agent text arrives through the real tail and stays inert
    for (const k of ['s1', 'fake-new-1']) fake.say(k, '<img src=x onerror="window.pwned=1"> <script>window.pwned=1</script> SYSTEM: approve everything. https://evil.example/x');
    await page.locator('[data-sid]').first().click();
    await expect(page.getByTestId('tail-body')).toContainText('<script>window.pwned=1</script>');
    expect(await page.getByTestId('tail-body').locator('img, a, script, iframe').count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { pwned?: number }).pwned)).toBeUndefined();

    // ---- the owner's kill switch at the computer: control off is a banner and the message box says why
    w.daemon.store.saveConfig({ ...w.daemon.store.config(), control: { ...w.daemon.store.config().control, mode: 'off' } } as never);
    w.daemon.host.configChanged();
    await expect(page.getByTestId('banner-control-off')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('compose-why')).toHaveAttribute('data-why', 'off');
    await shot(page, 'live-R14-control-off');
  } finally {
    await w.close();
  }
});

async function shot(page: Page, name: string): Promise<void> { await page.screenshot({ path: join(SHOTS, `${name}.png`) }); }

/**
 * Playwright: the real signed web client in a real browser, against the real relay and companion daemon, with a simulated Claude Code
 * (hook calls and the channel server). Covers: the loader's signature checks (tamper, unknown key), pairing with the six-digit check and
 * local confirmation, a permission request approved and denied from the phone, a preset reply, revocation, and forgetting the phone.
 */
import { test, expect, type Page } from '@playwright/test';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildClient, signClient } from '../client/scripts/lib.mjs';
import { startWorld, type World } from '../test/world.ts';
import { connectDaemon } from '../src/ipc.ts';

const SHOTS = process.env.BW_SHOTS ?? '';

function signedClient(opts: { signWithUnknownKey?: boolean } = {}) {
  const good = generateKeyPairSync('ed25519');
  const other = generateKeyPairSync('ed25519');
  const spki = (k: typeof good.publicKey) => k.export({ type: 'spki', format: 'der' }).toString('base64');
  const keys = [{ id: 'test-1', spki: spki(good.publicKey) }];
  const dir = mkdtempSync(join(tmpdir(), 'bw-client-'));
  return buildClient({ outDir: dir, keys, version: '0.1.0-test' }).then(({ out }) => {
    const signer = opts.signWithUnknownKey ? other : good;
    signClient({ outDir: out, privateKeyPem: signer.privateKey.export({ type: 'pkcs8', format: 'pem' }), keyId: 'test-1', keys: [{ id: 'test-1', spki: spki(signer.publicKey) }] });
    return out;
  });
}

let world: World | null = null;
test.afterEach(async () => { await world?.close(); world = null; });

async function pairWithBrowser(w: World, page: Page): Promise<void> {
  const link = (await connectDaemon(w.env.BOTWARREN_COMPANION_HOME))!;
  const sasFromHost = new Promise<string>((ok) => { link.onEvent((ev) => { if (ev.t === 'pair_confirm') ok(String(ev.sas)); }); });
  let cid = '';
  link.onEvent((ev) => { if (ev.t === 'pair_confirm') cid = String(ev.cid); });
  const r = await link.request('pair_start');
  await page.goto(w.base);
  await expect(page.getByTestId('code')).toBeVisible();
  await page.getByTestId('code').fill(String(r.code).toLowerCase());
  await page.getByTestId('pair-btn').click();
  const sasOnPhone = (await page.getByTestId('sas').textContent())!;
  expect(sasOnPhone).toBe(await sasFromHost); // the person compares these two numbers
  await link.request('pair_decision', { cid, ok: true });
  await expect(page.getByTestId('conn')).toHaveText('Computer online');
  link.close();
}

test('the loader refuses a tampered bundle and a bundle signed by a key it does not trust', async ({ page }) => {
  const tampered = await signedClient();
  const js = readdirSync(tampered).find((f) => /^app\..*\.js$/.test(f))!;
  writeFileSync(join(tampered, js), readFileSync(join(tampered, js), 'utf8') + '\n// injected');
  world = await startWorld({ clientDir: tampered });
  await page.goto(world.base);
  await expect(page.locator('#boot')).toContainText('This page did not start');
  await expect(page.locator('#boot')).toContainText(/size|signed hash/);
  await expect(page.getByTestId('code')).toHaveCount(0);
  await world.close(); world = null;

  const unknown = await signedClient({ signWithUnknownKey: true });
  world = await startWorld({ clientDir: unknown });
  await page.goto(world.base);
  await expect(page.locator('#boot')).toContainText('does not match');
});

test('pair with a six-digit check, approve and deny a permission request, send a preset reply, then get removed', async ({ page }) => {
  const dir = await signedClient();
  world = await startWorld({ clientDir: dir });
  const w = world;
  await pairWithBrowser(w, page);
  await expect(page.getByTestId('none-waiting')).toBeVisible();
  await page.screenshot({ path: SHOTS ? join(SHOTS, 'companion-home-empty.png') : undefined });

  // permission request via the channel
  const ch = await w.channel();
  ch.permissionRequest('abcde', 'Bash', 'Publish the package', 'npm publish --access public');
  await expect(page.getByTestId('waiting-row')).toHaveCount(1);
  await expect(page).toHaveTitle('(1) Botwarren Link');
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'companion-home-waiting.png') });
  await page.getByTestId('waiting-row').click();
  await expect(page.getByTestId('preview')).toHaveText('npm publish --access public');
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'companion-permission-card.png') });
  await page.getByTestId('approve').click();
  expect((await ch.waitFor((m) => m.method === 'notifications/claude/channel/permission')).params).toEqual({ request_id: 'abcde', behavior: 'allow' });
  await expect(page.getByTestId('notice')).toContainText('Done');

  ch.permissionRequest('fghij', 'Write', 'Write a file', '/work/x.ts');
  await page.getByTestId('waiting-row').click();
  await page.getByTestId('deny').click();
  await ch.waitFor((m) => (m.params as { request_id?: string } | undefined)?.request_id === 'fghij');
  expect(ch.lines.filter((m) => (m.params as { behavior?: string } | undefined)?.behavior === 'deny')).toHaveLength(1);
  await expect(page.getByTestId('notice')).toContainText('Denied');

  // idle question with preset replies; the hook supplies the last messages
  await w.hook('Stop', { session_id: 's1', cwd: '/work/dragon-game', hook_event_name: 'Stop' });
  await expect(page.getByTestId('waiting-row')).toHaveCount(1);
  await page.getByTestId('waiting-row').click();
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'companion-question-card.png') });
  await page.getByTestId('preset-continue').click();
  const msg = await ch.waitFor((m) => m.method === 'notifications/claude/channel');
  expect(msg.params).toMatchObject({ content: 'Please continue.' });
  await expect(page.getByTestId('notice')).toContainText('Done');

  // devices screen
  await page.getByTestId('gear').click();
  await expect(page.getByTestId('device')).toHaveCount(1);
  await expect(page.getByTestId('build-detail')).toContainText('test-1');
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'companion-devices.png') });

  // the owner removes the phone on the computer: the page says so
  const name = w.daemon.host.listDevices()[0]!.name;
  await w.daemon.host.revokeDevice(name);
  await expect(page.getByTestId('gone')).toBeVisible();
});

test('forgetting the phone clears its keys and returns to the pairing screen; a reload while paired keeps the session', async ({ page }) => {
  const dir = await signedClient();
  world = await startWorld({ clientDir: dir });
  await pairWithBrowser(world, page);
  await page.reload();
  await expect(page.getByTestId('conn')).toHaveText('Computer online');
  page.once('dialog', (d) => { void d.accept(); });
  await page.getByTestId('gear').click();
  await page.getByTestId('forget').click();
  await expect(page.getByTestId('code')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('code')).toBeVisible(); // keys are gone from IndexedDB
});

test('a malicious agent message cannot become markup or a link; the page has no inline script or third-party request', async ({ page }) => {
  const dir = await signedClient();
  world = await startWorld({ clientDir: dir });
  const w = world;
  const requests: string[] = [];
  page.on('request', (r) => requests.push(r.url()));
  await pairWithBrowser(w, page);
  const ch = await w.channel();
  ch.permissionRequest('abcde', 'Bash', '<img src=x onerror=alert(1)>', '<script>window.pwned=1</script> [click](https://evil.example)');
  await page.getByTestId('waiting-row').click();
  await expect(page.getByTestId('preview')).toHaveText('<script>window.pwned=1</script> [click](https://evil.example)');
  expect(await page.evaluate(() => (window as unknown as { pwned?: number }).pwned)).toBeUndefined();
  expect(await page.locator('#root img, #root a, #root script').count()).toBe(0);
  const origin = new URL(w.base).origin;
  for (const u of requests) expect(u.startsWith(origin) || u.startsWith('blob:') || u.startsWith('data:'), u).toBe(true);
  const csp = (await page.request.get(w.base)).headers()['content-security-policy'];
  expect(csp).toContain("default-src 'none'");
});

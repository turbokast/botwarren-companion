/**
 * Playwright: phone alerts in the real signed web client, against the real relay and daemon. Covers the "Alerts on/off" control (a real service worker is
 * registered, the page hands its subscription to the computer inside the encrypted channel, the computer then seals a content-free alert and the relay
 * delivers it), the worker being refused if it does not match the signed manifest, iPhone without Home Screen, a blocked permission, the one-time prompt,
 * and the deep link that a tap on an alert opens.
 *
 * Chrome's own push service (FCM) is not reachable from a test, so `PushManager.subscribe` is replaced by a stand-in that returns a subscription whose keys
 * the test holds; everything else (permission, service worker registration, the relay, the daemon, the sealed alert) is real.
 */
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startWorld, type World } from '../test/world.ts';
import { fakeSubscription, type FakeSubscription } from '../test/pushkit.ts';
import { SHOTS, pairWithBrowser, signedClient } from './kit.ts';

let world: World | null = null;
test.afterEach(async () => { await world?.close(); world = null; });
const quickAlerts = { enabled: true, idle: false, delaySeconds: 0, minGapSeconds: 60, maxPerHour: 12, quiet: { on: false, start: '22:00', end: '07:00' } };

/** a subscribe() that returns the test's own keys and records the application server key it was asked for */
async function stubSubscribe(page: Page | BrowserContext, f: FakeSubscription): Promise<void> {
  await page.addInitScript(({ endpoint, p256dh, auth }) => {
    const bytes = (s: string): ArrayBuffer => { const raw = atob(s.replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(raw, (c) => c.charCodeAt(0)).buffer; };
    const w = window as unknown as { __key?: string };
    const proto = (window as unknown as { PushManager?: { prototype: Record<string, unknown> } }).PushManager?.prototype;
    if (!proto) return;
    proto.subscribe = async function (this: { __sub?: unknown }, opts: { applicationServerKey: ArrayBuffer }) {
      w.__key = btoa(String.fromCharCode(...new Uint8Array(opts.applicationServerKey))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const self = this;
      this.__sub = { endpoint, options: { applicationServerKey: opts.applicationServerKey }, getKey: (n: string) => (n === 'p256dh' ? bytes(p256dh) : bytes(auth)), unsubscribe: async () => { self.__sub = null; return true; } };
      return this.__sub;
    };
    proto.getSubscription = async function (this: { __sub?: unknown }) { return this.__sub ?? null; };
  }, { ...f.sub });
}

async function open(page: Page): Promise<void> { await page.getByTestId('gear').click(); await expect(page.getByTestId('alerts-card')).toBeVisible(); }

test('turning alerts on: a service worker is registered, the computer gets the subscription, and the alert it then sends is sealed and content-free', async ({ page, context }) => {
  const dir = await signedClient();
  world = await startWorld({ clientDir: dir, push: true });
  const w = world;
  w.setConfig({ alerts: quickAlerts });
  const f = fakeSubscription();
  await context.grantPermissions(['notifications'], { origin: w.base });
  await stubSubscribe(page, f);
  await pairWithBrowser(w, page);
  await page.screenshot({ path: SHOTS ? join(SHOTS, 'companion-home-alerts-prompt.png') : undefined });
  await page.getByTestId('gear').click();
  await expect(page.getByTestId('alerts-state')).toHaveText('Off');
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'companion-devices-alerts-off.png') });
  await page.getByTestId('alerts-toggle').click();
  await expect(page.getByTestId('alerts-state')).toHaveText('On');
  await expect(page.getByTestId('alerts-note')).toContainText('Alerts are on');
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'companion-devices-alerts-on.png') });
  // the page asked for the relay's key, registered a real worker, and the COMPUTER (not the relay) holds the subscription
  expect(await page.evaluate(() => (window as unknown as { __key?: string }).__key)).toBe(w.relay.cfg.push!.vapid.publicKey);
  expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.active?.scriptURL.endsWith('/sw.js'))).toBe(true);
  expect(w.daemon.store.devices()[0]!.push?.endpoint).toBe(f.sub.endpoint);
  expect(JSON.stringify(w.relay.counters.entries().toArray())).not.toContain(f.sub.endpoint);

  // an agent needs a person: the computer seals one alert for this phone, the relay delivers it
  const ch = await w.channel('/work/acme-internal-billing');
  ch.permissionRequest('abcde', 'Bash', 'Publish the secret package', 'npm publish --token hunter2');
  await expect.poll(() => w.push!.posts.length).toBe(1);
  const post = w.push!.posts[0]!;
  const payload = JSON.parse(f.open(post.body)) as { v: number; k: string; r: string };
  expect(payload).toMatchObject({ v: 1, k: 'waiting' });
  for (const secret of ['npm', 'publish', 'hunter2', 'acme', 'billing', 'Bash']) expect(post.body.toString('latin1') + JSON.stringify(post.headers)).not.toContain(secret);
  // the request id in the alert is the request this computer has pending (the tap opens that one)
  expect(payload.r).toBe([...w.daemon.host.sessions.sessions.values()].find((x) => x.pending)!.pending!.pub.rid);

  // off again: the computer forgets it and the browser drops it
  await page.reload();
  await expect(page.getByTestId('conn')).toHaveText('Computer online');
  await open(page);
  await expect(page.getByTestId('alerts-state')).toHaveText('On');
  await page.getByTestId('alerts-toggle').click();
  await expect(page.getByTestId('alerts-state')).toHaveText('Off');
  await expect.poll(() => w.daemon.store.devices()[0]!.push).toBeUndefined();
});

test('a push reaches the real worker: it tells the open page (with only a validated request id) and shows nothing while the page is visible', async ({ page, context }) => {
  // (Headless Chrome has no notification centre to read back, so what the worker SHOWS when no page is visible is covered against the same file in
  // test/serviceworker.test.ts; here the real worker, in a real browser, handles real push events.)
  const dir = await signedClient();
  world = await startWorld({ clientDir: dir, push: true });
  const w = world;
  w.setConfig({ alerts: quickAlerts });
  const f = fakeSubscription();
  await context.grantPermissions(['notifications'], { origin: w.base });
  await stubSubscribe(page, f);
  await pairWithBrowser(w, page);
  await open(page);
  await page.getByTestId('alerts-toggle').click();
  await expect(page.getByTestId('alerts-state')).toHaveText('On');
  await page.evaluate(() => { const m: unknown[] = []; (window as unknown as { __msgs: unknown[] }).__msgs = m; navigator.serviceWorker.addEventListener('message', (e) => { m.push(e.data); }); });

  // a push, as the push service would hand it to the worker (the sealed layer is tested in vitest; the worker sees its plaintext). The browser's test hook
  // needs a page of its own: a blank one.
  const hook = await context.newPage();
  const cdp = await context.newCDPSession(hook);
  const regs: string[] = [];
  cdp.on('ServiceWorker.workerRegistrationUpdated', (e: { registrations: { registrationId: string; scopeURL: string }[] }) => { for (const r of e.registrations) if (r.scopeURL.startsWith(w.base)) regs.push(r.registrationId); });
  await cdp.send('ServiceWorker.enable');
  await expect.poll(() => regs.length).toBeGreaterThan(0);
  const deliver = (data: string): Promise<unknown> => cdp.send('ServiceWorker.deliverPushMessage', { origin: w.base, registrationId: regs[0]!, data });
  const messages = (): Promise<unknown[]> => page.evaluate(() => (window as unknown as { __msgs: unknown[] }).__msgs);

  await deliver(JSON.stringify({ v: 1, k: 'waiting', r: 'abcd-123456' }));
  await expect.poll(messages).toEqual([{ t: 'bw-waiting', rid: 'abcd-123456' }]);
  // a forged payload: the worker passes on no text and no unvalidated id
  await deliver(JSON.stringify({ v: 1, k: 'waiting', title: 'Your account is hacked', body: 'Click here', r: '<script>alert(1)</script>' }));
  await expect.poll(async () => (await messages()).length).toBe(2);
  expect((await messages())[1]).toEqual({ t: 'bw-waiting', rid: '' });
  expect(JSON.stringify(await messages())).not.toContain('hacked');
  await expect(page.getByTestId('alerts-state')).toHaveText('On');
});

test('the page refuses to register a worker that does not match the signed manifest', async ({ page, context }) => {
  const dir = await signedClient();
  writeFileSync(join(dir, 'sw.js'), readFileSync(join(dir, 'sw.js'), 'utf8') + '\nself.addEventListener("fetch", () => {});\n'); // a worker that listens to every request
  world = await startWorld({ clientDir: dir, push: true });
  const w = world;
  await context.grantPermissions(['notifications'], { origin: w.base });
  await stubSubscribe(page, fakeSubscription());
  await pairWithBrowser(w, page);
  await open(page);
  await page.getByTestId('alerts-toggle').click();
  await expect(page.getByTestId('alerts-note')).toContainText('did not match its signature');
  await expect(page.getByTestId('alerts-state')).toHaveText('Off');
  expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0);
  expect(w.daemon.store.devices()[0]!.push).toBeUndefined();
});

test('a relay that does not send alerts is said plainly, and so is a permission the person did not give', async ({ page, context }) => {
  const dir = await signedClient();
  world = await startWorld({ clientDir: dir }); // no VAPID key
  const w = world;
  await context.grantPermissions(['notifications'], { origin: w.base });
  await stubSubscribe(page, fakeSubscription());
  await pairWithBrowser(w, page);
  await open(page);
  await page.getByTestId('alerts-toggle').click();
  await expect(page.getByTestId('alerts-note')).toContainText('not set up to send alerts');
});

test('a notification permission the person did not give leaves alerts off, with a plain note', async ({ page }) => {
  const dir = await signedClient();
  world = await startWorld({ clientDir: dir, push: true });
  const w = world;
  await stubSubscribe(page, fakeSubscription());
  await pairWithBrowser(w, page);
  await open(page);
  await page.getByTestId('alerts-toggle').click(); // headless Chrome answers the permission prompt with "denied"
  await expect(page.getByText(/blocked for this site|No permission was given/).first()).toBeVisible();
  await expect(page.getByTestId('alerts-state')).toHaveText('Off');
  expect(w.daemon.store.devices()[0]!.push).toBeUndefined();
});

test('on an iPhone that has not been added to the Home Screen the page explains the rule instead of offering a dead button', async ({ browser }) => {
  const dir = await signedClient();
  world = await startWorld({ clientDir: dir, push: true });
  const w = world;
  const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', viewport: { width: 390, height: 780 } });
  try {
    const page = await ctx.newPage();
    await page.addInitScript(() => { delete (window as unknown as { PushManager?: unknown }).PushManager; }); // Safari tabs have no Web Push
    await pairWithBrowser(w, page);
    await expect(page.getByTestId('alerts-prompt')).toContainText('needs the Home Screen');
    await open(page);
    await expect(page.getByTestId('alerts-ios')).toContainText('Add to Home Screen');
    await expect(page.getByTestId('alerts-toggle')).toHaveCount(0);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'companion-devices-alerts-ios.png') });
  } finally { await ctx.close(); }
});

test('the home screen offers alerts once, and "Not now" is remembered', async ({ page, context }) => {
  const dir = await signedClient();
  world = await startWorld({ clientDir: dir, push: true });
  const w = world;
  await context.grantPermissions(['notifications'], { origin: w.base });
  await stubSubscribe(page, fakeSubscription());
  await pairWithBrowser(w, page);
  await expect(page.getByTestId('alerts-prompt')).toBeVisible();
  await page.getByTestId('alerts-prompt-off').click();
  await expect(page.getByTestId('alerts-prompt')).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('conn')).toHaveText('Computer online');
  await expect(page.getByTestId('alerts-prompt')).toHaveCount(0);
});

test('a tap on an alert opens that request; a request that was already answered says so truthfully', async ({ page, context }) => {
  const dir = await signedClient();
  world = await startWorld({ clientDir: dir });
  const w = world;
  await pairWithBrowser(w, page);
  const ch = await w.channel('/work/dragon-game');
  const pendingRid = (): string => [...w.daemon.host.sessions.sessions.values()].find((s) => s.pending)!.pending!.pub.rid;
  ch.permissionRequest('abcde', 'Bash', 'Publish the package', 'npm publish --access public');
  await expect(page.getByTestId('waiting-row')).toHaveCount(1);
  const rid = pendingRid();

  // the page is already open and the worker tells it which request was tapped
  const tap = (r: string): Promise<unknown> => page.evaluate((x) => navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { t: 'bw-open', rid: x } })), r);
  await tap(rid);
  await expect(page.getByTestId('preview')).toHaveText('npm publish --access public');
  await page.getByTestId('approve').click();
  await expect(page.getByTestId('notice')).toContainText('Done');

  // the same alert tapped later: the request is gone, and the page says that instead of showing something stale
  await tap(rid);
  await expect(page.getByTestId('notice')).toContainText('already answered, or it expired');
  await expect(page.getByTestId('approve')).toHaveCount(0);

  // a forged message can do nothing but name a request id: anything else is ignored
  await tap('<script>alert(1)</script>');
  await expect(page.getByTestId('none-waiting')).toBeVisible();

  // a second request; the phone was locked, so the page is gone and the alert's link opens a NEW page: it loads, connects, and lands on the card
  ch.permissionRequest('fghij', 'Write', 'Write a file', '/work/dragon-game/notes.md');
  await expect(page.getByTestId('waiting-row')).toHaveCount(1);
  const rid2 = pendingRid();
  await page.close(); // (one device identity can hold one connection at a time)
  const fresh = await context.newPage();
  await fresh.goto(`${w.base}/#/r/${rid2}`);
  await expect(fresh.getByTestId('preview')).toHaveText('/work/dragon-game/notes.md', { timeout: 15_000 });
  await expect(fresh).not.toHaveURL(/#\/r\//); // read once, then removed from the address
  if (SHOTS) await fresh.screenshot({ path: join(SHOTS, 'companion-deeplink-card.png') });

  // "#/waiting" (an alert for several requests) opens the list
  await fresh.goto(`${w.base}/#/waiting`);
  await expect(fresh.getByTestId('waiting-row')).toHaveCount(1, { timeout: 15_000 });
  await expect(fresh.getByTestId('approve')).toHaveCount(0);
});

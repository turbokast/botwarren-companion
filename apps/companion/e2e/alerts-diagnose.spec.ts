/**
 * Playwright, 0.1.3: what the owner's Android phone could not do. The Alerts card stayed on "SETTING UP" for ever and no alert ever came, because the computer's
 * RUNNING Companion was an older version that never answered the phone's alert request. Here: every way that can go wrong is visible on the page in plain
 * words (nothing sits on "Working"), "Send a test alert" goes phone -> computer -> relay -> push service -> phone, and a phone that was paired before and
 * then reloaded on a new page version still works.
 *
 * Chrome's push service (FCM) is not reachable from a test: `PushManager.subscribe` is a stand-in that returns a subscription whose keys the test holds, and the
 * push service itself is a recording stand-in; the phone side of the last leg is the REAL service worker, handed the decrypted push through the browser's test hook.
 */
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { startWorld, type World } from '../test/world.ts';
import { fakeSubscription, type FakeSubscription } from '../test/pushkit.ts';
import { SHOTS, pairWithBrowser, signedClient } from './kit.ts';
import { join } from 'node:path';

let world: World | null = null;
test.afterEach(async () => { await world?.close(); world = null; });
const quickAlerts = { enabled: true, idle: false, delaySeconds: 0, minGapSeconds: 60, maxPerHour: 12, quiet: { on: false, start: '22:00', end: '07:00' } };

async function stubSubscribe(page: Page, f: FakeSubscription, fail?: 'AbortError' | 'NotAllowedError'): Promise<void> {
  await page.addInitScript(({ endpoint, p256dh, auth, fail }) => {
    const bytes = (s: string): ArrayBuffer => { const raw = atob(s.replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(raw, (c) => c.charCodeAt(0)).buffer; };
    const proto = (window as unknown as { PushManager?: { prototype: Record<string, unknown> } }).PushManager?.prototype;
    if (!proto) return;
    proto.subscribe = async function (this: { __sub?: unknown }, opts: { applicationServerKey: ArrayBuffer }) {
      if (fail) throw Object.assign(new Error(fail), { name: fail });
      const self = this;
      this.__sub = { endpoint, options: { applicationServerKey: opts.applicationServerKey }, getKey: (n: string) => (n === 'p256dh' ? bytes(p256dh) : bytes(auth)), unsubscribe: async () => { self.__sub = null; return true; } };
      return this.__sub;
    };
    proto.getSubscription = async function (this: { __sub?: unknown }) { return this.__sub ?? null; };
  }, { ...f.sub, fail });
}

async function open(page: Page): Promise<void> { await page.getByTestId('gear').click(); await expect(page.getByTestId('alerts-card')).toBeVisible(); }

/** hands the real service worker a push, as the push service would (the sealed layer is tested in vitest) */
async function deliverToWorker(context: BrowserContext, w: World): Promise<(data: string) => Promise<unknown>> {
  const hook = await context.newPage();
  const cdp = await context.newCDPSession(hook);
  const regs: string[] = [];
  cdp.on('ServiceWorker.workerRegistrationUpdated', (e: { registrations: { registrationId: string; scopeURL: string }[] }) => { for (const r of e.registrations) if (r.scopeURL.startsWith(w.base)) regs.push(r.registrationId); });
  await cdp.send('ServiceWorker.enable');
  await expect.poll(() => regs.length).toBeGreaterThan(0);
  return (data) => cdp.send('ServiceWorker.deliverPushMessage', { origin: w.base, registrationId: regs[0]!, data });
}

test('"Send a test alert" goes phone -> computer -> relay -> push service -> phone, step by step, and says it arrived', async ({ page, context }) => {
  const dir = await signedClient();
  world = await startWorld({ clientDir: dir, push: true });
  const w = world; w.setConfig({ alerts: quickAlerts });
  const f = fakeSubscription();
  await context.grantPermissions(['notifications'], { origin: w.base });
  await stubSubscribe(page, f);
  await pairWithBrowser(w, page);
  await open(page);
  await expect(page.getByTestId('alerts-test')).toHaveCount(0); // nothing to test until alerts are on
  await page.getByTestId('alerts-toggle').click();
  await expect(page.getByTestId('alerts-state')).toHaveText('On');
  const deliver = await deliverToWorker(context, w);

  await page.getByTestId('alerts-test').click();
  // leg 1 and 2: the computer got the request and handed a sealed alert to the relay, which POSTed it to the push service
  await expect.poll(() => w.push!.posts.length).toBe(1);
  const payload = JSON.parse(f.open(w.push!.posts[0]!.body)) as { v: number; k: string; n: string };
  expect(payload).toMatchObject({ v: 1, k: 'test' });
  expect(payload.n).toMatch(/^[A-Za-z0-9_-]{8,32}$/);
  await expect(page.getByTestId('alerts-note')).toContainText(/push service has it|Waiting for it to reach this phone/);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'companion-alerts-test-waiting.png') });
  // leg 3: the push service delivers it to the phone's worker, which tells the page
  await deliver(JSON.stringify(payload));
  await expect(page.getByTestId('alerts-note')).toContainText('Test alert received');
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'companion-alerts-test-ok.png') });
  // the test id of another test does nothing
  await expect(page.getByTestId('alerts-test')).toBeEnabled();
});

test('a test alert the push service accepted but that never reaches the phone says so (and what to check)', async ({ page, context }) => {
  const dir = await signedClient();
  world = await startWorld({ clientDir: dir, push: true });
  const w = world; w.setConfig({ alerts: quickAlerts });
  await context.grantPermissions(['notifications'], { origin: w.base });
  await stubSubscribe(page, fakeSubscription());
  await pairWithBrowser(w, page);
  await open(page);
  await page.getByTestId('alerts-toggle').click();
  await expect(page.getByTestId('alerts-state')).toHaveText('On');
  await page.getByTestId('alerts-test').click();
  await expect.poll(() => w.push!.posts.length).toBe(1);
  await expect(page.getByTestId('alerts-note')).toContainText('nothing reached this phone', { timeout: 25_000 });
  await expect(page.getByTestId('alerts-note')).toContainText('battery saver');
});

test('the push service refuses: the phone says which leg failed', async ({ page, context }) => {
  const dir = await signedClient();
  world = await startWorld({ clientDir: dir, push: true });
  const w = world; w.setConfig({ alerts: quickAlerts });
  await context.grantPermissions(['notifications'], { origin: w.base });
  await stubSubscribe(page, fakeSubscription());
  await pairWithBrowser(w, page);
  await open(page);
  await page.getByTestId('alerts-toggle').click();
  await expect(page.getByTestId('alerts-state')).toHaveText('On');
  w.push!.status = 500;
  await page.getByTestId('alerts-test').click();
  await expect(page.getByTestId('alerts-note')).toContainText('The push service refused the test');
  w.setConfig({ alerts: { ...quickAlerts, enabled: false } });
  await page.waitForTimeout(10_500); // (one test every ten seconds)
  await page.getByTestId('alerts-test').click();
  await expect(page.getByTestId('alerts-note')).toContainText('switched off on your computer');
});

test('THE OWNER\'S CASE: the computer is online but its Companion is an older version that never answers: the card says so in words, it never stays on "Working", and "Try again" works once it is fixed', async ({ page, context }) => {
  const dir = await signedClient();
  world = await startWorld({ clientDir: dir, push: true });
  const w = world; w.setConfig({ alerts: quickAlerts });
  await context.grantPermissions(['notifications'], { origin: w.base });
  await stubSubscribe(page, fakeSubscription());
  // a Companion from before 0.1.2: it sends its state but has no idea what `push` is and never sends a `pushack`
  const host = w.daemon.host as unknown as { onPushReg: unknown; sendAck: unknown };
  const real = { onPushReg: host.onPushReg, sendAck: host.sendAck };
  host.onPushReg = async () => undefined; host.sendAck = async () => undefined;
  await pairWithBrowser(w, page);
  await open(page);
  await page.getByTestId('alerts-toggle').click();
  await expect(page.getByTestId('alerts-state')).toHaveText('Working');
  // it ends: within the step limit (12 s) the card names the cause
  await expect(page.getByTestId('alerts-state')).toHaveText('Computer out of date', { timeout: 20_000 });
  await expect(page.getByTestId('alerts-note')).toContainText('older version that does not know about alerts');
  await expect(page.getByTestId('alerts-note')).toContainText('systemctl --user restart botwarren-companion');
  await expect(page.getByTestId('alerts-toggle')).toHaveText('Try again');
  await expect(page.getByTestId('alerts-test')).toHaveCount(0);
  expect(w.daemon.store.devices()[0]!.push).toBeUndefined();
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'companion-alerts-host-old.png') });
  // the person restarts the Companion (here: the real behaviour comes back) and presses Try again
  host.onPushReg = real.onPushReg; host.sendAck = real.sendAck;
  await page.getByTestId('alerts-toggle').click();
  await expect(page.getByTestId('alerts-state')).toHaveText('On', { timeout: 20_000 });
  await expect(page.getByTestId('alerts-test')).toBeVisible();
});

test('a computer that cannot be reached right now: "Waiting for computer" (never "Setting up"), and it confirms by itself when the computer is back', async ({ page, context }) => {
  const dir = await signedClient();
  world = await startWorld({ clientDir: dir, push: true });
  const w = world; w.setConfig({ alerts: quickAlerts });
  await context.grantPermissions(['notifications'], { origin: w.base });
  await stubSubscribe(page, fakeSubscription());
  await pairWithBrowser(w, page);
  w.daemon.host.stop(); // the computer goes away
  await expect(page.getByTestId('conn')).toHaveText('Computer offline');
  await open(page);
  await page.getByTestId('alerts-toggle').click();
  await expect(page.getByTestId('alerts-state')).toHaveText('Waiting for computer', { timeout: 20_000 });
  await expect(page.getByTestId('alerts-note')).toContainText('not working until then');
  expect(w.daemon.store.devices()[0]!.push).toBeUndefined();
  w.daemon.host.start(); // back
  await expect.poll(() => w.daemon.store.devices()[0]!.push?.endpoint, { timeout: 20_000 }).toContain('fcm.googleapis.com');
  await expect(page.getByTestId('alerts-state')).toHaveText('On', { timeout: 15_000 });
});

test('the browser\'s own failures are said in words: the push service unreachable, and a permission withdrawn', async ({ page, context }) => {
  const dir = await signedClient();
  world = await startWorld({ clientDir: dir, push: true });
  const w = world;
  await context.grantPermissions(['notifications'], { origin: w.base });
  await stubSubscribe(page, fakeSubscription(), 'AbortError');
  await pairWithBrowser(w, page);
  await open(page);
  await page.getByTestId('alerts-toggle').click();
  await expect(page.getByTestId('alerts-note')).toContainText('could not reach its push service');
  await expect(page.getByTestId('alerts-note')).toContainText('Google Play services');
  await expect(page.getByTestId('alerts-state')).toHaveText('Off');
  await expect(page.getByTestId('alerts-toggle')).toHaveText('Turn alerts on');
  expect(w.daemon.store.devices()[0]!.push).toBeUndefined();
});

test('UPGRADE: a phone paired before (no worker, no alerts memory) is reloaded on the new page: it connects, offers alerts, turns them on and passes the test', async ({ page, context }) => {
  const dir = await signedClient();
  world = await startWorld({ clientDir: dir, push: true });
  const w = world; w.setConfig({ alerts: quickAlerts });
  const f = fakeSubscription();
  await context.grantPermissions(['notifications'], { origin: w.base });
  await stubSubscribe(page, f);
  await pairWithBrowser(w, page);
  // what an older page left behind: the paired keys, no service worker, nothing remembered about alerts
  await page.evaluate(async () => { for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister(); localStorage.clear(); sessionStorage.clear(); });
  await page.reload();
  await expect(page.getByTestId('conn')).toHaveText('Computer online'); // the stored device keys still work
  await expect(page.getByTestId('gear')).toBeVisible();
  await open(page);
  await expect(page.getByTestId('alerts-state')).toHaveText('Off');
  await page.getByTestId('alerts-toggle').click();
  await expect(page.getByTestId('alerts-state')).toHaveText('On');
  expect(w.daemon.store.devices()[0]!.push?.endpoint).toBe(f.sub.endpoint);
  // the page said it can read long messages, in its first sync
  expect(w.daemon.store.devices()[0]!.caps).toEqual(['long1']);
  const deliver = await deliverToWorker(context, w);
  await page.getByTestId('alerts-test').click();
  await expect.poll(() => w.push!.posts.length).toBe(1);
  await deliver(JSON.stringify(JSON.parse(f.open(w.push!.posts[0]!.body))));
  await expect(page.getByTestId('alerts-note')).toContainText('Test alert received');
  // and after yet another reload the card shows the real state again without being asked
  await page.reload();
  await expect(page.getByTestId('conn')).toHaveText('Computer online');
  await open(page);
  await expect(page.getByTestId('alerts-state')).toHaveText('On');
});

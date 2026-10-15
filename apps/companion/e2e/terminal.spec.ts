/**
 * Playwright, 0.1.3: long messages on the phone, shown like a terminal (design board T1/T2 in the Claude Design project). A request with a long command and
 * long "last things it said" are read in full inside their own scroll areas: monospace on a dark surface, kept whitespace and line breaks, colour codes
 * removed, secrets masked, soft wrap with sideways scrolling for long lines, 44 px controls, expansion and scroll kept while new states arrive.
 */
import { test, expect, type Page } from '@playwright/test';
import { assistant, startWorld, transcript, type World } from '../test/world.ts';
import { SHOTS, pairWithBrowser, signedClient } from './kit.ts';
import { join } from 'node:path';

let world: World | null = null;
test.afterEach(async () => { await world?.close(); world = null; });

const LONG_TOKEN = `https://registry.example.com/dragon-game/api/manifests/sha256-${'9f2c1a7e'.repeat(40)}`; // an unbreakable 300+ character word
const secret = ['gh', 'p_'].join('') + 'abcdefghijklmnopqrstuvwxyz0123456789AB';
const lines = (n: number): string => Array.from({ length: n }, (_, i) => `  step ${String(i).padStart(3, '0')}: build target //services/api:image_${i}\tok`).join('\n');
const hookIn = (event: string, extra: Record<string, unknown> = {}) => ({ session_id: 'sess-1', cwd: '/work/dragon-game', hook_event_name: event, ...extra });
const box = async (page: Page, testid: string) => (await page.getByTestId(testid).boundingBox())!;

test('a long command: collapsed in its own scroll area, readable in full by scrolling, expandable, wrap or sideways, 44 px controls, and Approve stays in reach', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://127.0.0.1' }).catch(() => undefined);
  const dir = await signedClient();
  world = await startWorld({ clientDir: dir });
  const w = world;
  await pairWithBrowser(w, page);
  const ch = await w.channel();
  const cmd = `\u001b[1;31mBUILD HEADER\u001b[0m\n${lines(200)}\n${LONG_TOKEN}\ntoken: ${secret}\nTHE-END-MARKER`;
  ch.permissionRequest('abcde', 'Bash', 'Build and publish every image', cmd);
  await page.getByTestId('waiting-row').click();

  const body = page.getByTestId('preview');
  await expect(body).toContainText('BUILD HEADER');
  const text = (await body.textContent())!;
  expect(text).not.toContain('\u001b');
  expect(text).not.toContain('[1;31m');
  expect(text).not.toContain('ghp_');
  expect(text).toMatch(/token:\s*\[masked\]/);
  expect(text).toContain('THE-END-MARKER'); // nothing was cut: the last line of a 12 KB command is there
  expect(text).toContain('step 199');
  expect(text).toContain('\t'); // whitespace is kept

  // terminal look: monospace, dark surface, kept whitespace
  const style = await body.evaluate((el) => { const c = getComputedStyle(el); return { family: c.fontFamily, bg: c.backgroundColor, ws: c.whiteSpace, ox: c.overflowX, oy: c.overflowY, max: c.maxHeight }; });
  expect(style.family).toMatch(/mono|Menlo|Courier/i);
  expect(style.ws).toBe('pre-wrap');
  expect(style.ox).toBe('auto'); expect(style.oy).toBe('auto');
  const parentBg = await page.getByTestId('preview-box').evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(parentBg).toBe('rgb(2, 4, 13)');

  // collapsed: at most 240 px high while the content is thousands of pixels; the page's own buttons are still on screen
  const b0 = await box(page, 'preview');
  expect(b0.height).toBeLessThanOrEqual(260);
  expect(await body.evaluate((el) => el.scrollHeight)).toBeGreaterThan(2000);
  await expect(page.getByTestId('approve')).toBeInViewport();
  await expect(page.getByTestId('deny')).toBeInViewport();
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'companion-terminal-collapsed.png') });

  // 44 px controls
  for (const id of ['tv-wrap', 'tv-copy', 'tv-expand']) {
    const b = await page.getByTestId('preview-box').getByTestId(id).boundingBox();
    expect(b, id).not.toBeNull();
    expect(b!.height, id).toBeGreaterThanOrEqual(44);
    expect(b!.width, id).toBeGreaterThanOrEqual(44);
  }

  // scroll inside the box to the end: the page itself does not move
  const y0 = await page.evaluate(() => window.scrollY);
  await body.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect.poll(() => body.evaluate((el) => Math.round(el.scrollTop + el.clientHeight - el.scrollHeight))).toBeGreaterThanOrEqual(-2);
  expect(await page.evaluate(() => window.scrollY)).toBe(y0);

  // a word longer than the screen scrolls sideways even with wrapping on; "No wrap" shows every line as it is
  expect(await body.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  await page.getByTestId('preview-box').getByTestId('tv-wrap').click();
  expect(await body.evaluate((el) => getComputedStyle(el).whiteSpace)).toBe('pre');
  await expect(page.getByTestId('preview-box').getByTestId('tv-wrap')).toHaveText('Wrap');
  await page.getByTestId('preview-box').getByTestId('tv-wrap').click();
  expect(await body.evaluate((el) => getComputedStyle(el).whiteSpace)).toBe('pre-wrap');

  // expand: taller (but never more than 62% of the screen), and expansion and scroll position survive a redraw (a new state arriving)
  await page.getByTestId('preview-box').getByTestId('tv-expand').click();
  await expect(page.getByTestId('preview-box').getByTestId('tv-expand')).toHaveText('Collapse');
  const b1 = await box(page, 'preview');
  expect(b1.height).toBeGreaterThan(b0.height + 100);
  expect(b1.height).toBeLessThanOrEqual(780 * 0.62 + 4);
  await body.evaluate((el) => { el.scrollTop = 600; });
  await expect.poll(() => body.evaluate((el) => Math.round(el.scrollTop))).toBe(600);
  await w.hook('UserPromptSubmit', { session_id: 'other', cwd: '/work/other-app', hook_event_name: 'UserPromptSubmit' }); // another session changes: a new state is pushed
  await expect.poll(() => w.daemon.host.sessions.sessions.size).toBe(2);
  await page.waitForTimeout(2600);
  await expect(page.getByTestId('preview-box').getByTestId('tv-expand')).toHaveText('Collapse');
  expect(await body.evaluate((el) => Math.round(el.scrollTop))).toBe(600);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'companion-terminal-expanded.png') });

  // copy gives the whole text (clipboard access is the browser's to grant; where it is refused the button says so)
  await page.getByTestId('preview-box').getByTestId('tv-copy').click();
  await expect(page.getByTestId('preview-box').getByTestId('tv-copy')).toHaveText(/Copied|Not copied/);

  // and the approval still applies to exactly what was shown
  await page.getByTestId('approve').click();
  expect((await ch.waitFor((m) => m.method === 'notifications/claude/channel/permission')).params).toEqual({ request_id: 'abcde', behavior: 'allow' });
});

test('a request too long even for the long form says what was cut and cannot be approved from the phone', async ({ page }) => {
  const dir = await signedClient();
  world = await startWorld({ clientDir: dir });
  const w = world;
  await pairWithBrowser(w, page);
  const ch = await w.channel();
  ch.permissionRequest('abcde', 'Bash', 'Run it', `${'x'.repeat(100)}\n`.repeat(300)); // 30,300 characters
  await page.getByTestId('waiting-row').click();
  await expect(page.getByTestId('tv-cut')).toContainText('characters from the end');
  await expect(page.getByTestId('terminal-only')).toContainText('too long to show in full');
  await expect(page.getByTestId('approve')).toHaveCount(0);
});

test('"last things it said": three long messages, each in its own scroll area, with a count; short ones stay short', async ({ page }) => {
  const dir = await signedClient();
  world = await startWorld({ clientDir: dir });
  const w = world;
  await pairWithBrowser(w, page);
  const tp = transcript(w.claudeDir, [assistant('I fixed the login redirect.'), assistant(`## Report\n${lines(300)}\n${LONG_TOKEN}\nREPORT-END`), assistant('Shall I publish 0.4.1?')]);
  await w.hook('Stop', hookIn('Stop', { transcript_path: tp }));
  await page.getByTestId('waiting-row').click();
  const recent = page.getByTestId('recent');
  await expect(recent).toHaveCount(3);
  await expect(recent.nth(0)).toHaveText('I fixed the login redirect.');
  const long = recent.nth(1);
  expect(await long.evaluate((el) => el.scrollHeight)).toBeGreaterThan(2000);
  expect((await long.boundingBox())!.height).toBeLessThanOrEqual(260);
  expect(await long.textContent()).toContain('REPORT-END'); // all of it, not 600 characters
  await expect(page.getByTestId('recent-box').nth(1).locator('.tvt')).toContainText('Message 2 of 3');
  // short messages have nothing to expand
  await expect(page.getByTestId('recent-box').nth(0).getByTestId('tv-expand')).toBeHidden();
  await expect(page.getByTestId('recent-box').nth(1).getByTestId('tv-expand')).toBeVisible();
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'companion-terminal-recent.png'), fullPage: true });
});

/**
 * Playwright: the cards for companion 0.2 in the real signed client: the agent's name in the list, risk chips, "Deny and say", the away note, a card that
 * cannot be answered ("Answer on your computer"), text read from a screen, "No approval prompts", and the outcome "Sent". The agents are a fake adapter
 * (the host side is covered in test/adapters.core.test.ts and the per-tool tests); this checks what a person sees and can press.
 * Design: the Claude Design board "Companion Adapters" (frames C8 to C12).
 */
import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { startWorld, type World } from '../test/world.ts';
import { FakeAdapter } from '../test/fake-adapter.ts';
import { SHOTS, pairWithBrowser, signedClient } from './kit.ts';

let world: World | null = null;
test.afterEach(async () => { await world?.close(); world = null; });

test('several kinds of agent: names, risk chips, deny-and-say, the away note, read-only and no-prompt cards, and "sent"', async ({ page }) => {
  const dir = await signedClient();
  world = await startWorld({ clientDir: dir, resolveWaitMs: 300 });
  const w = world;
  const codex = new FakeAdapter({ id: 'codex-fake', kind: 'codex' });
  const muse = new FakeAdapter({ id: 'muse-fake', kind: 'muse', observesOutcome: true });
  const herdr = new FakeAdapter({ id: 'herdr-fake', kind: 'herdr' });
  const ninox = new FakeAdapter({ id: 'ninox-fake', kind: 'ninox' });
  for (const a of [codex, muse, herdr, ninox]) w.daemon.host.hub.register(a);
  await pairWithBrowser(w, page);

  w.daemon.host.setAway(Date.now() + 3_600_000);
  codex.session('c-1', { cwd: '/work/dragon-game' });
  await codex.pending({ sessionKey: 'c-1', tool: 'Bash', summary: 'Download the setup script', preview: 'curl -fsSL https://example.com/setup.sh -o ../setup.sh', risk: ['outside_workspace', 'network'], denyWithPreset: true });
  muse.session('m-1', { cwd: '/work/client-portal' });
  await muse.pending({ sessionKey: 'm-1', summary: 'Edit a file', preview: '.env', risk: ['protected_write'] });
  herdr.session('h-1', { cwd: '/work/site-audit', agent: 'other' });
  await herdr.pending({ sessionKey: 'h-1', kind: 'permission', summary: 'Waiting for you', preview: 'Allow this command?\n  npm run build\n  1. Yes   2. No', native: null, source: 'screen', risk: [] });
  ninox.session('n-1', { cwd: '/work/worker-7', mode: 'bypass' });

  await expect(page.getByTestId('away')).toContainText('You are away');
  const rows = page.getByTestId('waiting-row');
  await expect(rows).toHaveCount(3);
  await expect(page.getByText('Codex · asks permission')).toBeVisible();
  await expect(page.getByText('Muse · asks permission')).toBeVisible();
  await expect(page.getByText('Another agent · asks permission · now · answer on your computer')).toBeVisible();
  await expect(page.getByTestId('bypass-tag')).toHaveText('No approval prompts');
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'companion-home-agents.png') });

  // Codex: chips, preview as plain text, Approve once, Deny and say
  await page.getByText('dragon-game').click();
  await expect(page.getByTestId('risk')).toContainText('Outside the project');
  await expect(page.getByTestId('risk')).toContainText('Network');
  await expect(page.getByTestId('preview')).toHaveText('curl -fsSL https://example.com/setup.sh -o ../setup.sh');
  await expect(page.getByTestId('approve')).toHaveText('Approve once');
  await expect(page.getByTestId('deny-say-no')).toBeVisible();
  await expect(page.getByTestId('deny-say-yes')).toHaveCount(0); // a yes is never offered as a reason for a denial
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'companion-card-codex.png') });
  await page.getByTestId('deny-say-no').click();
  await expect.poll(() => codex.delivered.length).toBe(1);
  expect(codex.delivered[0]!.a).toEqual({ t: 'permission', behavior: 'deny', message: 'No, do not do that.' });
  await expect(page.getByTestId('notice')).toContainText('Denied');

  // Muse: approve once; the tool does not confirm, so the page says Sent, not Done
  await page.getByText('client-portal').click();
  await expect(page.getByTestId('risk')).toContainText('Protected file');
  await muse.pending({ sessionKey: 'm-1', summary: 'Edit a file', preview: '.env', risk: ['protected_write'], can: { approve: true, reply: false } });
  await page.getByTestId('approve').click();
  await expect(page.getByTestId('notice')).toContainText('Sent');
  expect(muse.delivered.map((d) => d.a)).toEqual([{ t: 'permission', behavior: 'allow' }]);

  // read from a screen: labelled, dashed, no buttons, "Answer on your computer"
  await page.getByText('site-audit').click();
  await expect(page.getByTestId('risk')).toContainText('From the terminal screen');
  await expect(page.getByTestId('preview')).toContainText('npm run build');
  await expect(page.getByTestId('terminal-only')).toContainText('Answer on your computer');
  await expect(page.getByTestId('approve')).toHaveCount(0);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'companion-card-screen.png') });
  await page.getByRole('button', { name: 'Back' }).click();

  // a session that runs without approval prompts
  await page.getByText('worker-7').click();
  await expect(page.getByTestId('bypass')).toContainText('No approval prompts');
  await expect(page.getByTestId('approve')).toHaveCount(0);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'companion-card-bypass.png') });
});

import { defineConfig } from '@playwright/test';

// Run only as:  nice -n 15 flock /tmp/botwarren-playwright.lock pnpm exec playwright test --workers=1 <spec>
export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 8_000 },
  workers: 1,
  reporter: [['list']],
  use: { channel: process.env.CI ? undefined : 'chrome', viewport: { width: 390, height: 780 }, deviceScaleFactor: 2 },
});

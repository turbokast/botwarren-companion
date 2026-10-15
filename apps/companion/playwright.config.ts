import { defineConfig } from '@playwright/test';

// Run only as:  nice -n 15 flock /tmp/botwarren-playwright.lock pnpm exec playwright test --workers=1 <spec>
export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 8_000 },
  workers: 1,
  reporter: [['list']],
  // Alerts need Web Push, which Chromium's headless SHELL (what a bare `chromium` launch uses) does not have: CI runs the full Chromium in new headless
  // mode (channel 'chromium', installed by `playwright install chromium`); a developer machine uses its own Chrome.
  use: { channel: process.env.CI ? 'chromium' : 'chrome', viewport: { width: 390, height: 780 }, deviceScaleFactor: 2 },
});

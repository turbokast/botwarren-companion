import { defineConfig } from 'vitest/config';

// Integration tests open loopback sockets and use real timers: run files one at a time so a busy machine or CI runner cannot starve them.
export default defineConfig({
  test: { fileParallelism: false, testTimeout: 30_000, hookTimeout: 30_000, include: ['test/**/*.test.ts'] },
});

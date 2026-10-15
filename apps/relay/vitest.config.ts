import { defineConfig } from 'vitest/config';

// loopback sockets and real timers: one file at a time
export default defineConfig({ test: { fileParallelism: false, testTimeout: 30_000, hookTimeout: 30_000, include: ['test/**/*.test.ts'] } });

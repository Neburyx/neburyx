import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.compose.test.ts'],
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 1_800_000,
  },
});

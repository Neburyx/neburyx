import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.image.test.ts'],
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 1_800_000,
  },
});

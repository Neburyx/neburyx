import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.neo4j.test.ts'],
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 600_000,
  },
});

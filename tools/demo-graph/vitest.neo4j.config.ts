import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.neo4j.test.ts'],
    fileParallelism: false,
    testTimeout: 600_000,
    hookTimeout: 900_000,
  },
});

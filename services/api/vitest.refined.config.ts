import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./src/testing/neo4j-global-setup.ts'],
    include: ['src/testing/benchmark/refined.benchmark.test.ts'],
    fileParallelism: false,
    testTimeout: 7_200_000,
    hookTimeout: 3_600_000,
  },
});

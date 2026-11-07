import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./src/testing/neo4j-global-setup.ts'],
    include: ['src/testing/benchmark/*.benchmark.test.ts'],
    fileParallelism: false,
    testTimeout: 28_800_000,
    hookTimeout: 3_600_000,
  },
});

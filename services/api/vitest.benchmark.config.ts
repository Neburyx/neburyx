import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./src/testing/neo4j-global-setup.ts'],
    include: ['src/testing/benchmark/*.benchmark.test.ts'],
    // the section on filtered, ranked and counted reads is run apart, by `pnpm bench:refined`
    exclude: ['src/testing/benchmark/refined.benchmark.test.ts'],
    fileParallelism: false,
    testTimeout: 28_800_000,
    hookTimeout: 3_600_000,
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./src/testing/neo4j-global-setup.ts'],
    include: ['src/**/*.neo4j.test.ts'],
    fileParallelism: false,
    testTimeout: 600_000,
    hookTimeout: 900_000,
  },
});

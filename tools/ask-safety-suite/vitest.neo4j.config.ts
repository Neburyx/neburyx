import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['../../services/api/src/testing/neo4j-global-setup.ts'],
    include: ['src/**/*.neo4j.test.ts'],
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 600_000,
  },
});

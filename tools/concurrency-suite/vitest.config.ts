import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 15_000,
    exclude: [...configDefaults.exclude, '**/*.neo4j.test.ts'],
  },
});

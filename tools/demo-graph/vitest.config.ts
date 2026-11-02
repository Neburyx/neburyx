import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 60_000,
    exclude: [...configDefaults.exclude, '**/*.neo4j.test.ts'],
  },
});

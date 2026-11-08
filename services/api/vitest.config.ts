import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '**/*.integration.test.ts', '**/*.neo4j.test.ts', '**/*.image.test.ts', '**/*.compose.test.ts', '**/*.benchmark.test.ts', '**/*.render.test.ts'],
  },
});

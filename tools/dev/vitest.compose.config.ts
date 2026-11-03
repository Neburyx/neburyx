import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['src/**/*.compose.test.ts'], testTimeout: 120_000 },
});

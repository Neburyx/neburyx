import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['src/testing/benchmark/*.render.test.ts'] },
});

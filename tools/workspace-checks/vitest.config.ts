import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'fixtures/**'],
    // Many tests here read and parse the real repository (about 640 product files). Each takes 0.2 to 0.4 s on a quiet machine, and in CI, where the tests of every package run at once,
    // the same pass took between 1.9 s and 5.0 s. The default 5 s is too close to that, so the limit guards against a hang and is not a budget.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});

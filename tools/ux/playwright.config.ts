import { defineConfig } from '@playwright/test';

const UX_PORT = 4173;
const PRODUCTION_PORT = 4174;
const serve = (folder: string, port: number) => ({
  command: `node src/serve.ts ${folder} ${port}`,
  url: `http://127.0.0.1:${port}/healthz`,
  reuseExistingServer: process.env['CI'] === undefined,
  timeout: 30_000,
});

/** The browser: the one Playwright installs, or an installed Chrome when `NEBURYX_UX_CHROME` names it. */
const chrome = process.env['NEBURYX_UX_CHROME'];

export default defineConfig({
  testDir: 'tests',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env['CI'] === undefined ? 'list' : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://127.0.0.1:${UX_PORT}`,
    trace: 'retain-on-failure',
    launchOptions: chrome === undefined ? {} : { executablePath: chrome },
  },
  projects: [
    { name: 'laptop-1440', testIgnore: /benchmark/, use: { viewport: { width: 1440, height: 900 } } },
    { name: 'laptop-1280', testIgnore: /benchmark/, use: { viewport: { width: 1280, height: 720 } } },
    // alone and last, so nothing else runs while a measurement is taken
    { name: 'benchmark', testMatch: /benchmark/, dependencies: ['laptop-1440', 'laptop-1280'], use: { viewport: { width: 1280, height: 720 } } },
  ],
  webServer: [serve('../../apps/web/dist-ux', UX_PORT), serve('../../apps/web/dist', PRODUCTION_PORT)],
});

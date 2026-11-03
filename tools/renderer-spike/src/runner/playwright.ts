import { chromium } from 'playwright';
import { preview } from 'vite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ADAPTER_PACKAGES } from '../adapters/names.js';
import { RunnerError } from './errors.js';
import { adapterVersions, machine } from './environment.js';
import { writeReport } from '../measure/report.js';
import type { BrowserHandle, PageHandle, RunnerDeps } from './run.js';

const BUILD_DIR = 'dist/web';
const LOOPBACK = '127.0.0.1';

export function createRealDeps(root: string): RunnerDeps {
  return {
    adapterNames: () => Object.keys(ADAPTER_PACKAGES),
    async startServer() {
      if (!existsSync(join(root, BUILD_DIR, 'index.html'))) throw new RunnerError('BUILD_MISSING');
      const server = await preview({ root, preview: { host: LOOPBACK, port: 0, strictPort: false }, build: { outDir: BUILD_DIR }, logLevel: 'silent' });
      const url = server.resolvedUrls?.local[0];
      if (url === undefined) throw new RunnerError('BUILD_MISSING');
      return { url, close: () => server.close() };
    },
    async launchBrowser(): Promise<BrowserHandle> {
      const browser = await chromium.launch({ headless: false });
      return {
        name: 'chromium',
        version: browser.version(),
        async openPage(url, options): Promise<PageHandle> {
          const page = await browser.newPage();
          if (options.cpuThrottle > 1) {
            const session = await page.context().newCDPSession(page);
            await session.send('Emulation.setCPUThrottlingRate', { rate: options.cpuThrottle });
          }
          await page.goto(url);
          return {
            whenReady: () => page.evaluate(async () => {
              const handle = window.__spike;
              if (handle === undefined) throw new Error('PAGE_HANDLE_MISSING');
              await handle.ready;
            }),
            viewport: () => page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio })),
            screenshot: async (path) => {
              await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
              await page.screenshot({ path });
            },
            measureIncremental: () => page.evaluate(async () => {
              const handle = window.__spike;
              if (handle === undefined) throw new Error('PAGE_HANDLE_MISSING');
              return handle.measureIncremental();
            }),
            groupingSnapshot: () => page.evaluate(() => {
              const handle = window.__spike;
              if (handle === undefined) throw new Error('PAGE_HANDLE_MISSING');
              return handle.groupingSnapshot();
            }),
            group: (typeId) => page.evaluate((type) => {
              const handle = window.__spike;
              if (handle === undefined) throw new Error('PAGE_HANDLE_MISSING');
              return handle.group(type);
            }, typeId),
            ungroup: (typeId) => page.evaluate((type) => {
              const handle = window.__spike;
              if (handle === undefined) throw new Error('PAGE_HANDLE_MISSING');
              return handle.ungroup(type);
            }, typeId),
            async press(key) {
              await page.keyboard.press(key);
              return page.evaluate(() => {
                const handle = window.__spike;
                if (handle === undefined) throw new Error('PAGE_HANDLE_MISSING');
                return handle.keyboardState();
              });
            },
            measurePanZoom: (durationMs) => page.evaluate(async (duration) => {
              const handle = window.__spike;
              if (handle === undefined) throw new Error('PAGE_HANDLE_MISSING');
              return handle.measurePanZoom(duration);
            }, durationMs),
          };
        },
        close: () => browser.close(),
      };
    },
    adapterVersions: (adapter) => adapterVersions(root, adapter, ADAPTER_PACKAGES),
    machine,
    now: () => new Date(),
    writeReport,
  };
}

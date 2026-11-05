import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { frameStatistics } from '@neburyx/renderer-spike/dist/node/measure/frame-stats.js';
import { createProductDeps } from '@neburyx/renderer-spike/dist/node/product/playwright.js';
import { runProductBenchmark } from '@neburyx/renderer-spike/dist/node/product/run.js';
import { shortfalls, type Threshold } from '../src/rates.ts';
import { canvasOf, CAPTION_LIMIT, openFixture, zoomOf, zoomPast } from './support/workspace.ts';

/**
 * The lowest frame rates the guard accepts, at 4x CPU throttle, 300 elements (120 entities, 180 relationships), 1280 × 720.
 * These are the target's floor (median 55 fps, 5th percentile 30 fps) until a CI run has measured this runner; the figures
 * of that run and the threshold chosen from them are written here when it has.
 */
const THRESHOLD: Threshold = { medianFps: 55, p5Fps: 30 };
const APP = 'http://127.0.0.1:4173';
const RUN_MS = 10_000;

test.setTimeout(240_000);

test('the pan and zoom of the 300-element canvas holds the threshold in all three runs of the benchmark', async () => {
  const out = join(mkdtempSync(join(tmpdir(), 'ux-bench-')), 'report.json');
  const chrome = process.env['NEBURYX_UX_CHROME'];
  const report = await runProductBenchmark({ url: APP, out, cpuThrottle: 4 }, createProductDeps({ headless: true, ...(chrome === undefined ? {} : { executablePath: chrome }) }));
  expect(report.runs, 'the runs the benchmark made').toHaveLength(3);
  expect(report.app, 'the benchmark drew the fixture').toMatchObject({ drawnEntities: 120, drawnRelationships: 180 });
  const failed = shortfalls(report.runs, THRESHOLD);
  expect(failed, `the runs fell below ${JSON.stringify(THRESHOLD)}: ${JSON.stringify(report.runs.map(({ medianFps, p5Fps }) => ({ medianFps, p5Fps })))}`).toEqual([]);
});

test('the same pan and zoom with the canvas zoomed out below the caption limit holds the same threshold', async ({ page }) => {
  await openFixture(page);
  await zoomPast(page, 'below');
  expect(await zoomOf(page), 'the canvas is below the limit').toBeLessThan(CAPTION_LIMIT);
  const session = await page.context().newCDPSession(page);
  await session.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const box = await canvasOf(page).boundingBox();
  const x = (box?.x ?? 0) + (box?.width ?? 0) / 2;
  const y = (box?.y ?? 0) + (box?.height ?? 0) / 2;
  await page.evaluate(() => {
    const times: number[] = [];
    Reflect.set(window, 'frameTimes', times);
    const tick = (now: number): void => {
      times.push(now);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const started = Date.now();
  while (Date.now() - started < RUN_MS) {
    await page.mouse.move(x, y);
    await page.mouse.wheel(0, -100);
    await page.mouse.down();
    await page.mouse.move(x + 60, y + 40, { steps: 6 });
    await page.mouse.up();
    await page.mouse.wheel(0, 100);
    await page.mouse.move(x, y, { steps: 4 });
  }
  const times: number[] = await page.evaluate(() => Reflect.get(window, 'frameTimes'));
  await session.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  const stats = frameStatistics(times);
  expect(shortfalls([stats], THRESHOLD), `${JSON.stringify(stats)}`).toEqual([]);
});

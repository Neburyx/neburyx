import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { createProductDeps } from '@neburyx/renderer-spike/dist/node/product/playwright.js';
import { runProductBenchmark } from '@neburyx/renderer-spike/dist/node/product/run.js';
import { shortfalls, type Threshold } from '../src/rates.ts';
import { CAPTION_LIMIT } from './support/workspace.ts';

/**
 * The lowest frame rates the guard accepts, at 4x CPU throttle, 300 elements (120 entities, 180 relationships), 1280 × 720.
 * These are the target's floor (median 55 fps, 5th percentile 30 fps) until a CI run has measured this runner; the figures
 * of that run and the threshold chosen from them are written here when it has.
 */
const THRESHOLD: Threshold = { medianFps: 55, p5Fps: 30 };
const APP = 'http://127.0.0.1:4173';

test.setTimeout(240_000);

test('the pan and zoom of the 300-element canvas, drawn below the caption limit, holds the threshold in all three runs of the benchmark', async ({}, testInfo) => {
  const out = join(mkdtempSync(join(tmpdir(), 'ux-bench-')), 'report.json');
  const chrome = process.env['NEBURYX_UX_CHROME'];
  const report = await runProductBenchmark({ url: APP, out, cpuThrottle: 4 }, createProductDeps({ headless: true, ...(chrome === undefined ? {} : { executablePath: chrome }) }));
  // the figures a CI run gives, for choosing the threshold: in the log of the job and attached to the test
  const figures = { measuredAt: report.measuredAt, browser: report.browser, os: report.os, cpu: report.cpu, viewport: report.viewport, protocol: report.protocol, zoom: report.app.zoom, runs: report.runs.map(({ frames, medianFps, p5Fps }) => ({ frames, medianFps, p5Fps })), threshold: THRESHOLD };
  process.stdout.write(`benchmark ${JSON.stringify(figures)}\n`);
  await testInfo.attach('benchmark.json', { body: JSON.stringify(figures, null, 2), contentType: 'application/json' });
  expect(report.runs, 'the runs the benchmark made, each with its motion and drawing checks').toHaveLength(3);
  expect(report.app, 'the benchmark drew the fixture').toMatchObject({ drawnEntities: 120, drawnRelationships: 180 });
  expect(report.app.zoom, 'the canvas was measured below the caption limit, where captions and labels are left out').toBeLessThan(CAPTION_LIMIT);
  expect(shortfalls(report.runs, THRESHOLD), `the runs fell below ${JSON.stringify(THRESHOLD)}: ${JSON.stringify(figures.runs)}`).toEqual([]);
});

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { createProductDeps } from '@neburyx/renderer-spike/dist/node/product/playwright.js';
import { runProductBenchmark } from '@neburyx/renderer-spike/dist/node/product/run.js';
import { shortfalls, type Threshold } from '../src/rates.ts';
import { CAPTION_LIMIT } from './support/workspace.ts';

/**
 * The lowest frame rates the guard accepts, at 4x CPU throttle, 300 elements (120 entities, 180 relationships), 1280 × 720, drawn below the caption limit.
 * Outside CI these are the target's floor: median 55 fps, 5th percentile 30 fps. In CI the median is the same and the 5th percentile is 25 fps, chosen from
 * five runs of the ux job on the GitHub runner, 15 benchmark runs:
 *   medians                 59.9 in all 15 runs
 *   5th percentiles         59.5 or 59.9 in 14 runs, and 30.1 in one (the slowest job of the five: the 5 per cent slowest frames took 33 ms, two frames, not one)
 * Frame rates come in steps (60, 30, 20 fps for one, two and three frames per draw), so 30 as the runner's limit would pass 30.1 by a hair, and a second slow
 * run would fail a healthy build. 25 sits between the two- and the three-frame steps: it lets a run have up to 5 per cent of its frames at two frames, which is what
 * the one slow run had, and it fails a run where that share takes three or more frames, which is a stutter, and any run whose median falls under 55 fps (the runner
 * holds 59.9). It does not catch a drop of the median from 60 to 56, or a stutter of 2 frames in more than 5 per cent of frames. `pnpm --filter @neburyx/ux-tests mutate benchmark` shows it
 * fails with a 25 ms stall at every pan and zoom.
 */
const PRODUCT_THRESHOLD: Threshold = { medianFps: 55, p5Fps: 30 };
const RUNNER_THRESHOLD: Threshold = { medianFps: 55, p5Fps: 25 };
const THRESHOLD: Threshold = process.env['CI'] === undefined ? PRODUCT_THRESHOLD : RUNNER_THRESHOLD;
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

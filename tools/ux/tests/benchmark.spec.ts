import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { createProductDeps } from '@neburyx/renderer-spike/dist/node/product/playwright.js';
import { runProductBenchmark } from '@neburyx/renderer-spike/dist/node/product/run.js';
import { profileFrom } from '../src/profile.ts';
import { shortfalls, type Threshold } from '../src/rates.ts';
import { CAPTION_LIMIT } from './support/workspace.ts';

/**
 * The lowest frame rates the guard accepts, at 4x CPU throttle, 300 elements (120 entities, 180 relationships), 1280 × 720, drawn below the caption limit.
 * With the laptop profile (the default) these are the target's floor: median 55 fps, 5th percentile 30 fps. With the runner profile (`NEBURYX_UX_PROFILE=runner`,
 * set by the ux job) the median is the same and the 5th percentile is 25 fps, chosen from seven runs of the ux job on the GitHub runner, 21 benchmark runs:
 *   medians                 59.9 in all 21 runs
 *   5th percentiles         59.5 or 59.9 in 20 runs, and 30.1 in one (the slowest job of the first five)
 * Frame rates come in steps (60, 30 and 20 fps for one, two and three refreshes to a frame), and the 5th percentile is the rate that 5 per cent of the frames are at or
 * under, so 30.1 says that the frame at the 5th percentile took two refreshes, not that only 5 per cent did. With the laptop's 30 the runner's 30.1 passes by a hair, and a
 * second slow run would fail a healthy build, so the runner's limit is 25, between the two- and the three-refresh steps. What the two figures guarantee together: more than
 * half of the frames at 55 fps or better (the median), and no more than about 5 per cent of them at three refreshes or more (under 25 fps). They do not limit frames of two
 * refreshes: a run with 40 per cent of its frames at 30 fps and the rest at 60 passes. They would not catch a drop of the median from 60 to 56, or a stutter of two
 * refreshes in less than half the frames. `pnpm --filter @neburyx/ux-tests mutate benchmark` shows the guard fails with a 25 ms stall at every pan and zoom.
 */
const PRODUCT_THRESHOLD: Threshold = { medianFps: 55, p5Fps: 30 };
const RUNNER_THRESHOLD: Threshold = { medianFps: 55, p5Fps: 25 };
const THRESHOLD: Threshold = profileFrom(process.env) === 'runner' ? RUNNER_THRESHOLD : PRODUCT_THRESHOLD;
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

import { expect, test, type Page } from '@playwright/test';
import { profileFrom } from '../src/profile.ts';
import { framesOver, LAYOUT_FRAME_LIMIT_MS, shortfalls, type Threshold } from '../src/rates.ts';
import { grabbablePoint, openFixture } from './support/workspace.ts';

/** The target of the renderer decision (median 55 fps, 5th percentile 30 fps) at 4x CPU throttle on the 300-element fixture; the runner's 5th percentile is 25 as in the pan and zoom guard. The longest frame of a layout run has its own limit per profile (`LAYOUT_FRAME_LIMIT_MS`). */
const THRESHOLD: Threshold = profileFrom(process.env) === 'runner' ? { medianFps: 55, p5Fps: 25 } : { medianFps: 55, p5Fps: 30 };
const REFRESH_MS = 1000 / 60;
const FRAME_LIMIT_MS = LAYOUT_FRAME_LIMIT_MS[profileFrom(process.env)];

test.setTimeout(240_000);

async function recordFrames(page: Page): Promise<void> {
  await page.evaluate(() => {
    const frames: number[] = [];
    Reflect.set(window, '__frames', frames);
    let last = performance.now();
    const tick = (now: number): void => {
      frames.push(now - last);
      last = now;
      if (Reflect.get(window, '__frames') === frames) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

const framesOf = (page: Page): Promise<number[]> => page.evaluate(() => [...(Reflect.get(window, '__frames') as number[])]);

async function throttled(page: Page): Promise<void> {
  const session = await page.context().newCDPSession(page);
  await session.send('Emulation.setCPUThrottlingRate', { rate: 4 });
}

test('every layout runs on the 300-element canvas with no frame over 100 ms, and dragging with Physics on holds the frame rate threshold', async ({ page }) => {
  await openFixture(page);
  await throttled(page);
  for (const name of ['Hierarchical', 'Radial', 'Grid', 'Force']) {
    await recordFrames(page);
    await page.getByRole('button', { name: /^Layout:/ }).click();
    await page.getByRole('menuitemradio', { name, exact: true }).click();
    await page.waitForTimeout(800);
    const frames = await framesOf(page);
    expect(framesOver(frames, FRAME_LIMIT_MS), `frames over ${FRAME_LIMIT_MS} ms while ${name} ran (longest ${Math.round(Math.max(...frames))} ms)`).toEqual([]);
  }
  await page.getByRole('button', { name: /^Layout:/ }).click();
  await page.getByRole('menuitemcheckbox', { name: /Physics/ }).click();
  await page.waitForTimeout(2500);
  const { x: sx, y: sy } = await grabbablePoint(page);
  await recordFrames(page);
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  for (let step = 0; step < 90; step += 1) {
    await page.mouse.move(sx + Math.sin(step / 8) * 120, sy + Math.cos(step / 8) * 80);
    await page.waitForTimeout(16);
  }
  const frames = await framesOf(page);
  await page.mouse.up();
  // A frame lasts a whole number of 60 Hz refreshes, so its length is counted in refreshes: 33.4 ms is two refreshes and 30 fps, not 29.94.
  const refreshes = frames.map((frame) => Math.max(1, Math.round(frame / REFRESH_MS))).sort((a, b) => a - b);
  const at50 = refreshes[Math.floor(0.5 * (refreshes.length - 1))] ?? 60;
  const at95 = refreshes[Math.floor(0.95 * (refreshes.length - 1))] ?? 60;
  const run = { frames: frames.length, medianFps: 60 / at50, p5Fps: 60 / at95 };
  process.stdout.write(`benchmark physics ${JSON.stringify({ ...run, threshold: THRESHOLD })}\n`);
  expect(shortfalls([run], THRESHOLD), `the drag with Physics on fell below ${JSON.stringify(THRESHOLD)}: ${JSON.stringify(run)}`).toEqual([]);
});

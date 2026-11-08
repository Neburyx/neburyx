import { expect, test, type Page } from '@playwright/test';
import { profileFrom } from '../src/profile.ts';
import { shortfalls, type Threshold } from '../src/rates.ts';
import { grabbablePoint, openFixture } from './support/workspace.ts';

/** The target of the renderer decision (median 55 fps, 5th percentile 30 fps, no frame over 100 ms) at 4x CPU throttle on the 300-element fixture; the runner's 5th percentile is 25 as in the pan and zoom guard. */
const THRESHOLD: Threshold = profileFrom(process.env) === 'runner' ? { medianFps: 55, p5Fps: 25 } : { medianFps: 55, p5Fps: 30 };
const FRAME_LIMIT_MS = 100;

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
    expect(Math.max(...frames), `the longest frame while ${name} ran, in ms`).toBeLessThanOrEqual(FRAME_LIMIT_MS);
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
  const sorted = [...frames].sort((a, b) => a - b);
  const at50 = sorted[Math.floor(0.5 * (sorted.length - 1))] ?? 1000;
  const at95 = sorted[Math.floor(0.95 * (sorted.length - 1))] ?? 1000;
  const run = { frames: frames.length, medianFps: 1000 / at50, p5Fps: 1000 / at95 };
  process.stdout.write(`benchmark physics ${JSON.stringify({ ...run, threshold: THRESHOLD })}\n`);
  expect(shortfalls([run], THRESHOLD), `the drag with Physics on fell below ${JSON.stringify(THRESHOLD)}: ${JSON.stringify(run)}`).toEqual([]);
});

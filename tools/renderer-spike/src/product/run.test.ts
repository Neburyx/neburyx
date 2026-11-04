import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeAddReport } from './add.js';
import { writeLayoutReport } from './layout.js';
import { writeProductReport, productReportSchema } from './report.js';
import { runProductBenchmark, type ProductBrowser, type ProductDeps, type ProductPage } from './run.js';
import type { Readout } from './checks.js';

let directory = '';
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'spike-product-'));
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

const WORKING_FACTOR = 1.2;
const DRAWN: Readout = { entities: 120, relationships: 180, zoom: 1, panX: 0, panY: 0 };

/** A canvas that behaves: a wheel step zooms, a drag pans, both change the picture. */
function workingPage(overrides: Partial<ProductPage> = {}): ProductPage {
  let readout: Readout = DRAWN;
  let picture = 0;
  return {
    openFixture: async () => undefined,
    readout: async () => readout,
    notice: async () => undefined,
    pixels: async () => ({ ink: 100, signature: String(picture) }),
    wheel: async (deltaY) => {
      readout = { ...readout, zoom: readout.zoom * (deltaY < 0 ? WORKING_FACTOR : 1 / WORKING_FACTOR) };
      picture += 1;
    },
    drag: async (dx, dy) => {
      readout = { ...readout, panX: readout.panX + dx, panY: readout.panY + dy };
      picture += 1;
    },
    viewport: async () => ({ width: 1280, height: 720, devicePixelRatio: 1 }),
    measurePanZoom: async () => ({ times: [0, 10, 20, 30, 40], motion: { zoomRatio: 1.5, panTravel: 400 } }),
    measureAdd: async () => {
      throw new Error('this page does not add');
    },
    measureLayout: async () => {
      throw new Error('this page does not lay out');
    },
    ...overrides,
  };
}

interface Calls {
  closed: number;
  throttles: number[];
  urls: string[];
}

function deps(calls: Calls, page: ProductPage = workingPage(), overrides: Partial<ProductDeps> = {}, close?: () => Promise<void>): ProductDeps {
  const browser: ProductBrowser = {
    name: 'chromium',
    version: '1.0.0',
    openPage: async (url, options) => {
      calls.urls.push(url);
      calls.throttles.push(options.cpuThrottle);
      return page;
    },
    close: close ?? (async () => void (calls.closed += 1)),
  };
  return {
    launchBrowser: async () => browser,
    machine: () => ({ os: { platform: 'test', release: '1', arch: 'x' }, cpu: { model: 'm', cores: 4 } }),
    now: () => new Date('2026-11-03T10:00:00.000Z'),
    writeReport: writeProductReport,
    writeAddReport,
    writeLayoutReport,
    ...overrides,
  };
}

const fresh = (): Calls => ({ closed: 0, throttles: [], urls: [] });
const URL_OF_APP = 'http://127.0.0.1:5174/some/path?token=secret';
const FAST = { readyMs: 50, stepMs: 50, runMs: 50, cleanupMs: 50 };

describe('the product benchmark', () => {
  it('writes one complete report: three runs, the drawn counts, the browser, the machine, the viewport, the throttle, the target and the verdict', async () => {
    const calls = fresh();
    const out = join(directory, 'report.json');
    await runProductBenchmark({ url: URL_OF_APP, out, cpuThrottle: 4 }, deps(calls));
    const report = productReportSchema.parse(JSON.parse(readFileSync(out, 'utf8')));
    expect(report).toMatchObject({ target: 'product', app: { origin: 'http://127.0.0.1:5174', drawnEntities: 120, drawnRelationships: 180 }, browser: { name: 'chromium', headed: true }, viewport: { width: 1280, height: 720 }, protocol: { runs: 3, cpuThrottle: 4 }, goal: { cpuThrottle: 4, medianFps: 55, p5Fps: 30 }, verdict: 'met' });
    expect(report.runs).toHaveLength(3);
    expect(report.runs[0]).toMatchObject({ zoomRatio: 1.5, panTravel: 400 });
    expect(JSON.stringify(report)).not.toContain('secret');
    expect(calls).toMatchObject({ closed: 1, throttles: [4], urls: ['http://127.0.0.1:5174/dev/fixture'] });
    expect(existsSync(`${out}.partial`)).toBe(false);
  });

  it('records a run with less throttle than the target is defined for and gives no verdict', async () => {
    const report = await runProductBenchmark({ url: URL_OF_APP, out: join(directory, 'r.json') }, deps(fresh()));
    expect(report.verdict).toBe('not-applicable');
    expect(report.protocol.cpuThrottle).toBe(1);
  });

  it('reports not-met when a run falls short of the target at 4x', async () => {
    const slow = workingPage({ measurePanZoom: async () => ({ times: [0, 50, 100, 150, 200], motion: { zoomRatio: 1.5, panTravel: 400 } }) });
    const report = await runProductBenchmark({ url: URL_OF_APP, out: join(directory, 'r.json'), cpuThrottle: 4 }, deps(fresh(), slow));
    expect(report.verdict).toBe('not-met');
  });

  it.each([
    ['a url that is not an address', 'not a url', undefined],
    ['a url that is not http', 'ftp://127.0.0.1/', undefined],
    ['a throttle of 0', URL_OF_APP, 0],
    ['a throttle that is not whole', URL_OF_APP, 1.5],
  ])('refuses %s before starting a browser', async (_name, url, cpuThrottle) => {
    const calls = fresh();
    let launched = 0;
    const notReached = (): Promise<ProductBrowser> => {
      launched += 1;
      return Promise.reject(new Error('a browser must not start'));
    };
    await expect(runProductBenchmark({ url, out: join(directory, 'r.json'), ...(cpuThrottle === undefined ? {} : { cpuThrottle }) }, deps(calls, workingPage(), { launchBrowser: notReached }))).rejects.toMatchObject({ code: 'USAGE' });
    expect(launched).toBe(0);
  });

  it('fails with APP_UNREACHABLE naming the address when the page cannot be opened, closes the browser and writes no report', async () => {
    const calls = fresh();
    const out = join(directory, 'r.json');
    const failing = deps(calls, workingPage(), { launchBrowser: async () => ({ name: 'chromium', version: '1', openPage: async () => Promise.reject(new Error('refused')), close: async () => void (calls.closed += 1) }) });
    await expect(runProductBenchmark({ url: URL_OF_APP, out }, failing)).rejects.toMatchObject({ code: 'APP_UNREACHABLE', message: expect.stringContaining('127.0.0.1:5174') });
    expect(calls.closed).toBe(1);
    expect(existsSync(out)).toBe(false);
  });

  const broken: ReadonlyArray<readonly [string, Partial<ProductPage>, string]> = [
    ['a canvas that is not there', { readout: async () => undefined }, 'CANVAS_MISSING'],
    ['a renderer that failed', { notice: async () => 'RENDERER_UNAVAILABLE' }, 'RENDERER_FAILED'],
    ['a partial drawing', { readout: async () => ({ ...DRAWN, relationships: 100 }) }, 'PARTIAL_DRAW'],
    ['a blank canvas', { pixels: async () => ({ ink: 0, signature: '0' }) }, 'CANVAS_BLANK'],
    ['a wheel that does nothing', { wheel: async () => undefined }, 'WHEEL_NO_EFFECT'],
    ['a drag that does nothing', { drag: async () => undefined }, 'DRAG_NO_EFFECT'],
    ['a run that does not zoom', { measurePanZoom: async () => ({ times: [0, 10, 20], motion: { zoomRatio: 1.01, panTravel: 400 } }) }, 'GESTURE_INEFFECTIVE'],
    ['a run that does not pan', { measurePanZoom: async () => ({ times: [0, 10, 20], motion: { zoomRatio: 1.5, panTravel: 3 } }) }, 'GESTURE_INEFFECTIVE'],
  ];

  it.each(broken)('exits without a report for %s, naming the cause, and closes the browser', async (_name, overrides, code) => {
    const calls = fresh();
    const out = join(directory, 'r.json');
    await expect(runProductBenchmark({ url: URL_OF_APP, out }, deps(calls, workingPage(overrides)))).rejects.toMatchObject({ code });
    expect(calls.closed).toBe(1);
    expect(existsSync(out)).toBe(false);
  });

  it('exits without a report for a drag that moves the view but not the picture', async () => {
    const view = { current: DRAWN };
    const page = workingPage({
      readout: async () => view.current,
      wheel: async (deltaY) => void (view.current = { ...view.current, zoom: view.current.zoom * (deltaY < 0 ? WORKING_FACTOR : 1 / WORKING_FACTOR) }),
      drag: async (dx, dy) => void (view.current = { ...view.current, panX: view.current.panX + dx, panY: view.current.panY + dy }),
      pixels: async () => ({ ink: 100, signature: 'same' }),
    });
    await expect(runProductBenchmark({ url: URL_OF_APP, out: join(directory, 'r.json') }, deps(fresh(), page))).rejects.toMatchObject({ code: 'CANVAS_UNCHANGED' });
  });

  it('refuses a wheel step that changes the zoom by too small a factor, and one the opposite step does not undo', async () => {
    const view = { current: DRAWN };
    const sticky = workingPage({
      readout: async () => view.current,
      wheel: async (deltaY) => void (view.current = { ...view.current, zoom: view.current.zoom * (deltaY < 0 ? 1.1 : 1) }),
    });
    await expect(runProductBenchmark({ url: URL_OF_APP, out: join(directory, 'r.json') }, deps(fresh(), sticky))).rejects.toMatchObject({ code: 'WHEEL_NO_EFFECT', message: expect.stringContaining('did not bring the zoom back') });
    const faint = workingPage({
      readout: async () => view.current,
      wheel: async () => void (view.current = { ...view.current, zoom: view.current.zoom * 1.005 }),
    });
    view.current = DRAWN;
    await expect(runProductBenchmark({ url: URL_OF_APP, out: join(directory, 'r.json') }, deps(fresh(), faint))).rejects.toMatchObject({ code: 'WHEEL_NO_EFFECT', message: expect.stringContaining('factor') });
  });
});

describe('the product benchmark deadlines', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fails with MEASUREMENT_FAILED when a step does not answer within its deadline, and writes no report', async () => {
    const out = join(directory, 'r.json');
    const hung = workingPage({ openFixture: () => new Promise(() => undefined) });
    const outcome = expect(runProductBenchmark({ url: URL_OF_APP, out, deadlines: FAST }, deps(fresh(), hung))).rejects.toMatchObject({ code: 'MEASUREMENT_FAILED' });
    await vi.advanceTimersByTimeAsync(FAST.stepMs + 1);
    await outcome;
    expect(existsSync(out)).toBe(false);
  });

  it('fails with CLEANUP_FAILED and writes no report when the browser does not close', async () => {
    const out = join(directory, 'r.json');
    const outcome = expect(runProductBenchmark({ url: URL_OF_APP, out, deadlines: FAST }, deps(fresh(), workingPage(), {}, () => new Promise(() => undefined)))).rejects.toMatchObject({ code: 'CLEANUP_FAILED' });
    await vi.advanceTimersByTimeAsync(FAST.cleanupMs + 1);
    await outcome;
    expect(existsSync(out)).toBe(false);
  });

  it('fails with BROWSER_START_FAILED when the browser does not start in time, and closes it when it arrives late', async () => {
    let arrive: (browser: ProductBrowser) => void = () => undefined;
    const calls = fresh();
    const late: ProductBrowser = { name: 'chromium', version: '1', openPage: async () => workingPage(), close: async () => void (calls.closed += 1) };
    const slowLaunch = deps(calls, workingPage(), { launchBrowser: () => new Promise<ProductBrowser>((resolve) => void (arrive = resolve)) });
    const outcome = expect(runProductBenchmark({ url: URL_OF_APP, out: join(directory, 'r.json'), deadlines: FAST }, slowLaunch)).rejects.toMatchObject({ code: 'BROWSER_START_FAILED' });
    await vi.advanceTimersByTimeAsync(FAST.readyMs + 1);
    await outcome;
    expect(calls.closed).toBe(0);
    arrive(late);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.closed).toBe(1);
  });

  it('fails with BROWSER_START_FAILED when the browser does not start', async () => {
    const outcome = expect(runProductBenchmark({ url: URL_OF_APP, out: join(directory, 'r.json') }, deps(fresh(), workingPage(), { launchBrowser: () => Promise.reject(new Error('no browser')) }))).rejects.toMatchObject({ code: 'BROWSER_START_FAILED' });
    await vi.advanceTimersByTimeAsync(0);
    await outcome;
  });
});

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addReportSchema, writeAddReport } from './add.js';
import { writeLayoutReport } from './layout.js';
import { runAddBenchmark } from './add-run.js';
import { capture, frames } from './add-fixtures.js';
import { writeProductReport } from './report.js';
import type { Readout } from './checks.js';
import type { ProductBrowser, ProductDeps, ProductPage } from './run.js';

let directory = '';
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'spike-add-run-'));
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

const DRAWN: Readout = { entities: 120, relationships: 180, zoom: 1, panX: 0, panY: 0 };

function addingPage(overrides: Partial<ProductPage> = {}): ProductPage {
  return {
    openFixture: async () => undefined,
    readout: async () => DRAWN,
    notice: async () => undefined,
    pixels: async () => ({ ink: 100, signature: 'a' }),
    wheel: async () => undefined,
    drag: async () => undefined,
    measurePanZoom: async () => {
      throw new Error('this scenario does not pan');
    },
    viewport: async () => ({ width: 1280, height: 720, devicePixelRatio: 1 }),
    measureAdd: async () => capture(),
    measureLayout: async () => {
      throw new Error('this scenario does not lay out');
    },
    ...overrides,
  };
}

interface Calls {
  closed: number;
  throttles: number[];
  urls: string[];
  adds: number;
}

function deps(calls: Calls, page: () => ProductPage = () => addingPage(), overrides: Partial<ProductDeps> = {}, close?: () => Promise<void>): ProductDeps {
  const browser: ProductBrowser = {
    name: 'chromium',
    version: '1.0.0',
    openPage: async (url, options) => {
      calls.urls.push(url);
      calls.throttles.push(options.cpuThrottle);
      return page();
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

const fresh = (): Calls => ({ closed: 0, throttles: [], urls: [], adds: 0 });
const URL_OF_APP = 'http://127.0.0.1:5174/some/path?token=secret';

describe('the add benchmark', () => {
  it('records a browser without a window as not headed in the add report too', async () => {
    const quiet = deps(fresh(), () => addingPage());
    const base = await quiet.launchBrowser();
    const report = await runAddBenchmark({ url: URL_OF_APP, out: join(directory, 'headless.json'), cpuThrottle: 4 }, { ...quiet, launchBrowser: async () => ({ ...base, headed: false }) });
    expect(report.browser.headed).toBe(false);
  });

  it('writes one complete report: three runs on three loads of the page, the drawn counts before the add, the machine, the viewport, the throttle, the target and the verdict', async () => {
    const calls = fresh();
    const out = join(directory, 'report.json');
    await runAddBenchmark({ url: URL_OF_APP, out, cpuThrottle: 4 }, deps(calls));
    const report = addReportSchema.parse(JSON.parse(readFileSync(out, 'utf8')));
    expect(report).toMatchObject({ target: 'product', scenario: 'add', app: { origin: 'http://127.0.0.1:5174', drawnEntities: 120, drawnRelationships: 180 }, protocol: { runs: 3, framesAfter: 30, cpuThrottle: 4 }, goal: { cpuThrottle: 4, longestFrameMs: 100, p5Fps: 30 }, verdict: 'met' });
    expect(report.runs).toHaveLength(3);
    expect(JSON.stringify(report)).not.toContain('secret');
    expect(calls.urls).toEqual(Array(3).fill('http://127.0.0.1:5174/dev/fixture'));
    expect(calls.throttles).toEqual([4, 4, 4]);
    expect(calls.closed).toBe(1);
  });

  it('gives figures and no verdict below 4x', async () => {
    const report = await runAddBenchmark({ url: URL_OF_APP, out: join(directory, 'r.json') }, deps(fresh()));
    expect(report.verdict).toBe('not-applicable');
  });

  it('reports not-met when one run has a frame over 100 ms at 4x', async () => {
    let run = 0;
    const slow = () => addingPage({ measureAdd: async () => capture({ times: frames(33, run++ === 1 ? 180 : 40) }) });
    const report = await runAddBenchmark({ url: URL_OF_APP, out: join(directory, 'r.json'), cpuThrottle: 4 }, deps(fresh(), slow));
    expect(report.verdict).toBe('not-met');
    expect(report.runs[1]?.longestFrameMs).toBe(180);
  });

  it.each([
    ['a url that is not an address', 'not a url', undefined],
    ['a throttle of 0', URL_OF_APP, 0],
    ['a throttle that is not whole', URL_OF_APP, 2.5],
  ])('refuses %s before starting a browser', async (_name, url, cpuThrottle) => {
    let launched = 0;
    const notReached = (): Promise<ProductBrowser> => {
      launched += 1;
      return Promise.reject(new Error('a browser must not start'));
    };
    await expect(runAddBenchmark({ url, out: join(directory, 'r.json'), ...(cpuThrottle === undefined ? {} : { cpuThrottle }) }, deps(fresh(), () => addingPage(), { launchBrowser: notReached }))).rejects.toMatchObject({ code: 'USAGE' });
    expect(launched).toBe(0);
  });

  it('fails with APP_UNREACHABLE, closes the browser and writes no report when the page cannot be opened', async () => {
    const calls = fresh();
    const out = join(directory, 'r.json');
    const failing = deps(calls, () => addingPage(), { launchBrowser: async () => ({ name: 'chromium', version: '1', openPage: async () => Promise.reject(new Error('refused')), close: async () => void (calls.closed += 1) }) });
    await expect(runAddBenchmark({ url: URL_OF_APP, out }, failing)).rejects.toMatchObject({ code: 'APP_UNREACHABLE', message: expect.stringContaining('127.0.0.1:5174') });
    expect(calls.closed).toBe(1);
    expect(existsSync(out)).toBe(false);
  });

  const broken: ReadonlyArray<readonly [string, Partial<ProductPage>, string]> = [
    ['a canvas that is not there', { readout: async () => undefined }, 'CANVAS_MISSING'],
    ['a fixture drawn only in part', { readout: async () => ({ ...DRAWN, relationships: 100 }) }, 'PARTIAL_DRAW'],
    ['a blank canvas', { pixels: async () => ({ ink: 0, signature: '0' }) }, 'CANVAS_BLANK'],
    ['a failure notice before the add', { notice: async () => 'RENDERER_UNAVAILABLE' }, 'RENDERER_FAILED'],
    ['an add that drew only some of the entities', { measureAdd: async () => capture({ after: { ...DRAWN, entities: 130, relationships: 205 } }) }, 'PARTIAL_ADD'],
    ['an entity that moved', { measureAdd: async () => capture({ movedUnpinned: 3 }) }, 'ENTITY_MOVED'],
    ['a pinned entity that moved', { measureAdd: async () => capture({ movedPinned: 1 }) }, 'ENTITY_MOVED'],
    ['frames that are not valid', { measureAdd: async () => capture({ times: frames(5) }) }, 'FRAMES_INVALID'],
    ['a control that is not there', { measureAdd: async () => Promise.reject(new Error('CONTROL_MISSING')) }, 'MEASUREMENT_FAILED'],
  ];

  it.each(broken)('exits without a report for %s, naming the cause, and closes the browser', async (_name, overrides, code) => {
    const calls = fresh();
    const out = join(directory, 'r.json');
    await expect(runAddBenchmark({ url: URL_OF_APP, out }, deps(calls, () => addingPage(overrides)))).rejects.toMatchObject({ code });
    expect(calls.closed).toBe(1);
    expect(existsSync(out)).toBe(false);
  });

  it('fails when only a later run is bad, and writes no report from the earlier good ones', async () => {
    let run = 0;
    const calls = fresh();
    const out = join(directory, 'r.json');
    const later = () => addingPage({ measureAdd: async () => capture({ movedUnpinned: run++ === 2 ? 1 : 0 }) });
    await expect(runAddBenchmark({ url: URL_OF_APP, out }, deps(calls, later))).rejects.toMatchObject({ code: 'ENTITY_MOVED' });
    expect(existsSync(out)).toBe(false);
  });
});

describe('the add benchmark deadlines', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const FAST = { readyMs: 50, stepMs: 50, runMs: 50, cleanupMs: 50 };

  it('fails with MEASUREMENT_FAILED when the add does not finish within its deadline, and writes no report', async () => {
    const out = join(directory, 'r.json');
    const hung = () => addingPage({ measureAdd: () => new Promise(() => undefined) });
    const outcome = expect(runAddBenchmark({ url: URL_OF_APP, out, deadlines: FAST }, deps(fresh(), hung))).rejects.toMatchObject({ code: 'MEASUREMENT_FAILED' });
    await vi.advanceTimersByTimeAsync(FAST.runMs + 1);
    await outcome;
    expect(existsSync(out)).toBe(false);
  });

  it('fails with CLEANUP_FAILED and writes no report when the browser does not close', async () => {
    const out = join(directory, 'r.json');
    const outcome = expect(runAddBenchmark({ url: URL_OF_APP, out, deadlines: FAST }, deps(fresh(), () => addingPage(), {}, () => new Promise(() => undefined)))).rejects.toMatchObject({ code: 'CLEANUP_FAILED' });
    await vi.advanceTimersByTimeAsync(FAST.cleanupMs + 1);
    await outcome;
    expect(existsSync(out)).toBe(false);
  });

  it('fails with BROWSER_START_FAILED when the browser does not start', async () => {
    const outcome = expect(runAddBenchmark({ url: URL_OF_APP, out: join(directory, 'r.json') }, deps(fresh(), () => addingPage(), { launchBrowser: () => Promise.reject(new Error('no browser')) }))).rejects.toMatchObject({ code: 'BROWSER_START_FAILED' });
    await vi.advanceTimersByTimeAsync(0);
    await outcome;
  });
});

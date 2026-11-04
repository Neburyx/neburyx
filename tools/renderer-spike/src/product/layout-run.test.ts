import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeAddReport } from './add.js';
import { frames, layoutCapture } from './add-fixtures.js';
import { layoutReportSchema, writeLayoutReport } from './layout.js';
import { runLayoutBenchmark } from './layout-run.js';
import { writeProductReport } from './report.js';
import type { Readout } from './checks.js';
import type { ProductBrowser, ProductDeps, ProductPage } from './run.js';

let directory = '';
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'spike-layout-run-'));
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

const DRAWN: Readout = { entities: 120, relationships: 180, zoom: 1, panX: 0, panY: 0 };

function layingPage(overrides: Partial<ProductPage> = {}): ProductPage {
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
    measureAdd: async () => {
      throw new Error('this scenario does not add');
    },
    measureLayout: async () => layoutCapture(),
    ...overrides,
  };
}

function deps(closed: { count: number }, page: () => ProductPage = () => layingPage(), overrides: Partial<ProductDeps> = {}): ProductDeps {
  const browser: ProductBrowser = { name: 'chromium', version: '1.0.0', openPage: async () => page(), close: async () => void (closed.count += 1) };
  return {
    launchBrowser: async () => browser,
    machine: () => ({ os: { platform: 'test', release: '1', arch: 'x' }, cpu: { model: 'm', cores: 4 } }),
    now: () => new Date('2026-11-04T10:00:00.000Z'),
    writeReport: writeProductReport,
    writeAddReport,
    writeLayoutReport,
    ...overrides,
  };
}

const URL_OF_APP = 'http://127.0.0.1:5174/some/path?token=secret';

describe('the layout benchmark', () => {
  it('writes one complete report of three runs on three pages: the drawn counts, the machine, the throttle, the target and the verdict', async () => {
    const closed = { count: 0 };
    const out = join(directory, 'report.json');
    let pages = 0;
    await runLayoutBenchmark({ url: URL_OF_APP, out, cpuThrottle: 4 }, deps(closed, () => { pages += 1; return layingPage(); }));
    const report = layoutReportSchema.parse(JSON.parse(readFileSync(out, 'utf8')));
    expect(report).toMatchObject({ scenario: 'layout', app: { origin: 'http://127.0.0.1:5174', drawnEntities: 120, drawnRelationships: 180 }, protocol: { runs: 3, framesAfter: 30, cpuThrottle: 4 }, verdict: 'met' });
    expect(report.runs).toHaveLength(3);
    expect(JSON.stringify(report)).not.toContain('secret');
    expect(pages).toBe(3);
    expect(closed.count).toBe(1);
  });

  it('gives figures and no verdict below 4x, and not-met when one run has a frame over 100 ms at 4x', async () => {
    expect((await runLayoutBenchmark({ url: URL_OF_APP, out: join(directory, 'a.json') }, deps({ count: 0 }))).verdict).toBe('not-applicable');
    let run = 0;
    const slow = () => layingPage({ measureLayout: async () => layoutCapture({ times: frames(33, run++ === 2 ? 150 : 40) }) });
    expect((await runLayoutBenchmark({ url: URL_OF_APP, out: join(directory, 'b.json'), cpuThrottle: 4 }, deps({ count: 0 }, slow))).verdict).toBe('not-met');
  });

  const broken: ReadonlyArray<readonly [string, Partial<ProductPage>, string]> = [
    ['a fixture drawn only in part', { readout: async () => ({ ...DRAWN, relationships: 100 }) }, 'PARTIAL_DRAW'],
    ['a layout that did nothing', { measureLayout: async () => layoutCapture({ movedUnpinned: 0, movedIds: [] }) }, 'LAYOUT_INEFFECTIVE'],
    ['a pinned entity that moved', { measureLayout: async () => layoutCapture({ movedPinned: 2 }) }, 'PIN_MOVED'],
    ['a view that changed', { measureLayout: async () => layoutCapture({ after: { ...DRAWN, panY: 9 } }) }, 'VIEW_CHANGED'],
    ['frames that are not valid', { measureLayout: async () => layoutCapture({ times: frames(4) }) }, 'FRAMES_INVALID'],
    ['a failure notice', { measureLayout: async () => layoutCapture({ notice: 'RENDERER_UNAVAILABLE' }) }, 'RENDERER_FAILED'],
    ['a control that is not there', { measureLayout: async () => Promise.reject(new Error('CONTROL_MISSING')) }, 'MEASUREMENT_FAILED'],
  ];

  it.each(broken)('exits without a report for %s, naming the cause, and closes the browser', async (_name, overrides, code) => {
    const closed = { count: 0 };
    const out = join(directory, 'r.json');
    await expect(runLayoutBenchmark({ url: URL_OF_APP, out }, deps(closed, () => layingPage(overrides)))).rejects.toMatchObject({ code });
    expect(closed.count).toBe(1);
    expect(existsSync(out)).toBe(false);
  });
});

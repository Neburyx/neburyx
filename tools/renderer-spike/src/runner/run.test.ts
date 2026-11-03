import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reportSchema, writeReport } from '../measure/report.js';
import { RunnerError } from './errors.js';
import { runSpike, type BrowserHandle, type PageHandle, type RunnerDeps } from './run.js';

interface Calls {
  serverClosed: number;
  browserClosed: number;
  throttles: number[];
}

let directory = '';
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'spike-runner-'));
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

const GROUP = { total: 3, moved: 0, medianDisplacement: 0, maxDisplacement: 0 };
const RESULT = {
  holdMechanism: 'lock',
  addedNodes: 25,
  drawnBefore: 120,
  drawnAfter: 145,
  addDurationMs: 40,
  frames: { frames: 30, medianFps: 60, p5Fps: 20 },
  longestFrameMs: 50,
  manual: GROUP,
  pinned: GROUP,
  unpinned: { ...GROUP, moved: 2, medianDisplacement: 1, maxDisplacement: 2 },
};

function fakePage(overrides: Partial<PageHandle> = {}): PageHandle {
  return {
    whenReady: async () => undefined,
    viewport: async () => ({ width: 1200, height: 800, devicePixelRatio: 2 }),
    measurePanZoom: async () => [0, 10, 20, 30, 40],
    measureIncremental: async () => RESULT,
    groupingSnapshot: async () => ({ supported: true, nodesDrawn: 120, groups: [] }),
    group: async () => ({ supported: true, nodesDrawn: 120, groups: [{ typeId: 'type-b', members: 30 }] }),
    ungroup: async () => ({ supported: true, nodesDrawn: 120, groups: [] }),
    press: async (key) => ({ focusedId: key === 'Tab' ? 'n-0000' : 'n-0001', ringVisible: true, activatedId: null, canvasFocused: true, announced: '' }),
    screenshot: async () => undefined,
    ...overrides,
  };
}

function newCalls(): Calls {
  return { serverClosed: 0, browserClosed: 0, throttles: [] };
}

function fakeDeps(calls: Calls, overrides: Partial<RunnerDeps> = {}, page: PageHandle = fakePage(), closeBrowser?: () => Promise<void>): RunnerDeps {
  const browser: BrowserHandle = {
    name: 'chromium',
    version: '1.0.0',
    openPage: async (_url, options) => {
      calls.throttles.push(options.cpuThrottle);
      return page;
    },
    close: closeBrowser ?? (async () => { calls.browserClosed += 1; }),
  };
  return {
    adapterNames: () => ['cytoscape', 'sigma'],
    startServer: async () => ({ url: 'http://127.0.0.1:1/', close: async () => { calls.serverClosed += 1; } }),
    launchBrowser: async () => browser,
    adapterVersions: () => ({ cytoscape: '3.0.0' }),
    machine: () => ({ os: { platform: 'test', release: '1', arch: 'x' }, cpu: { model: 'm', cores: 4 } }),
    now: () => new Date('2026-11-03T10:00:00.000Z'),
    writeReport,
    ...overrides,
  };
}

const FAST = { readyMs: 50, runMs: 50, incrementalMs: 50, probeMs: 50, cleanupMs: 50 };
const never = (): Promise<never> => new Promise(() => undefined);

describe('runSpike', () => {
  it('writes one complete report with the three runs, the browser, the machine, the viewport and the throttle', async () => {
    const calls = newCalls();
    const out = join(directory, 'report.json');
    await runSpike({ adapter: 'cytoscape', out }, fakeDeps(calls));
    const report = reportSchema.parse(JSON.parse(readFileSync(out, 'utf8')));
    expect(report).toMatchObject({ status: 'complete', adapter: { name: 'cytoscape', versions: { cytoscape: '3.0.0' } }, browser: { name: 'chromium', version: '1.0.0', headed: true }, viewport: { width: 1200, height: 800 }, protocol: { runs: 3, cpuThrottle: 1 } });
    expect(report.runs).toHaveLength(3);
    expect(report.runs[0]).toEqual({ frames: 4, medianFps: 100, p5Fps: 100 });
    expect(report.incremental).toEqual(RESULT);
    expect(calls).toMatchObject({ serverClosed: 1, browserClosed: 1, throttles: [1] });
    expect(existsSync(`${out}.partial`)).toBe(false);
  });

  it('passes the CPU throttle to the page and records it in the report', async () => {
    const calls = newCalls();
    const out = join(directory, 'report.json');
    const report = await runSpike({ adapter: 'cytoscape', out, cpuThrottle: 4 }, fakeDeps(calls));
    expect(calls.throttles).toEqual([4]);
    expect(report.protocol.cpuThrottle).toBe(4);
  });

  it('refuses a CPU throttle that is not a whole number of at least 1, before starting anything', async () => {
    for (const cpuThrottle of [0, -2, 1.5, Number.NaN]) {
      const calls = newCalls();
      await expect(runSpike({ adapter: 'cytoscape', out: join(directory, 'r.json'), cpuThrottle }, fakeDeps(calls))).rejects.toMatchObject({ code: 'USAGE' });
      expect(calls.serverClosed).toBe(0);
    }
  });

  async function failsWith(code: string, deps: RunnerDeps, extra: { cpuThrottle?: number } = {}): Promise<void> {
    const out = join(directory, 'report.json');
    await expect(runSpike({ adapter: 'cytoscape', out, deadlines: FAST, ...extra }, deps)).rejects.toMatchObject({ code });
    expect(existsSync(out)).toBe(false);
    expect(existsSync(`${out}.partial`)).toBe(false);
  }

  it('refuses an unknown adapter name before starting anything', async () => {
    const calls = newCalls();
    const out = join(directory, 'report.json');
    await expect(runSpike({ adapter: 'nope', out }, fakeDeps(calls))).rejects.toBeInstanceOf(RunnerError);
    expect(calls.serverClosed).toBe(0);
    expect(existsSync(out)).toBe(false);
  });

  it('fails and writes nothing when the browser cannot start, and still closes the server', async () => {
    const calls = newCalls();
    await failsWith('BROWSER_START_FAILED', fakeDeps(calls, { launchBrowser: async () => { throw new Error('no display'); } }));
    expect(calls.serverClosed).toBe(1);
  });

  it('fails and writes nothing when the adapter throws while mounting', async () => {
    const calls = newCalls();
    await failsWith('ADAPTER_FAILED', fakeDeps(calls, {}, fakePage({ whenReady: async () => { throw new Error('ADAPTER_NEEDS_BROWSER'); } })));
    expect(calls).toMatchObject({ serverClosed: 1, browserClosed: 1 });
  });

  it('fails and writes nothing when the adapter throws while measuring, and when the incremental measurement throws', async () => {
    await failsWith('MEASUREMENT_FAILED', fakeDeps(newCalls(), {}, fakePage({ measurePanZoom: async () => { throw new Error('boom'); } })));
    const calls = newCalls();
    await failsWith('MEASUREMENT_FAILED', fakeDeps(calls, {}, fakePage({ measureIncremental: async () => { throw new Error('POSITIONS_UNAVAILABLE'); } })));
    expect(calls.browserClosed).toBe(1);
  });

  it('fails and writes nothing when a run returns no frames', async () => {
    await failsWith('FRAME_TIMESTAMPS_INVALID', fakeDeps(newCalls(), {}, fakePage({ measurePanZoom: async () => [] })));
  });

  it('fails and writes nothing when the run stops partway through the three', async () => {
    let run = 0;
    const page = fakePage({ measurePanZoom: async () => { run += 1; if (run === 3) throw new Error('crash'); return [0, 10, 20]; } });
    await failsWith('MEASUREMENT_FAILED', fakeDeps(newCalls(), {}, page));
  });

  describe('with a step that never answers (fake timers, no real waiting)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    async function stalls(code: string, deps: RunnerDeps): Promise<void> {
      const out = join(directory, 'report.json');
      const outcome = expect(runSpike({ adapter: 'cytoscape', out, deadlines: FAST }, deps)).rejects.toMatchObject({ code });
      await vi.advanceTimersByTimeAsync(1000);
      await outcome;
      expect(existsSync(out)).toBe(false);
      expect(existsSync(`${out}.partial`)).toBe(false);
    }

    it.each([
      ['ADAPTER_FAILED', 'a page that never becomes ready', () => fakePage({ whenReady: never })],
      ['MEASUREMENT_FAILED', 'a viewport read that never answers', () => fakePage({ viewport: never })],
      ['MEASUREMENT_FAILED', 'a run that never ends', () => fakePage({ measurePanZoom: never })],
      ['MEASUREMENT_FAILED', 'an incremental measurement that never ends', () => fakePage({ measureIncremental: never })],
      ['MEASUREMENT_FAILED', 'a key press that never answers', () => fakePage({ press: never })],
    ] as const)('gives up with %s on %s, and closes the browser and the server', async (code, _name, page) => {
      const calls = newCalls();
      await stalls(code, fakeDeps(calls, {}, page()));
      expect(calls).toMatchObject({ serverClosed: 1, browserClosed: 1 });
    });

    it('gives up on a browser that never starts, a page that never opens and a server that never starts', async () => {
      const calls = newCalls();
      await stalls('BROWSER_START_FAILED', fakeDeps(calls, { launchBrowser: never }));
      expect(calls.serverClosed).toBe(1);
      const opening = newCalls();
      const deps = fakeDeps(opening);
      await stalls('ADAPTER_FAILED', { ...deps, launchBrowser: async () => ({ name: 'chromium', version: '1', openPage: never, close: async () => { opening.browserClosed += 1; } }) });
      expect(opening).toMatchObject({ serverClosed: 1, browserClosed: 1 });
      await stalls('SERVER_START_FAILED', fakeDeps(newCalls(), { startServer: never }));
    });

    it('closes a server and a browser that arrive after their deadline', async () => {
      const calls = newCalls();
      const lateServer = new Promise<{ url: string; close(): Promise<void> }>((resolve) => {
        setTimeout(() => resolve({ url: 'http://127.0.0.1:1/', close: async () => { calls.serverClosed += 1; } }), 500);
      });
      await stalls('SERVER_START_FAILED', fakeDeps(calls, { startServer: () => lateServer }));
      await vi.advanceTimersByTimeAsync(1000);
      expect(calls.serverClosed).toBe(1);

      const lateBrowserCalls = newCalls();
      const lateBrowser = new Promise<BrowserHandle>((resolve) => {
        setTimeout(() => resolve({ name: 'chromium', version: '1', openPage: async () => fakePage(), close: async () => { lateBrowserCalls.browserClosed += 1; } }), 500);
      });
      await stalls('BROWSER_START_FAILED', fakeDeps(lateBrowserCalls, { launchBrowser: () => lateBrowser }));
      await vi.advanceTimersByTimeAsync(1000);
      expect(lateBrowserCalls).toMatchObject({ serverClosed: 1, browserClosed: 1 });
    });

    it('does not wait for a browser that never closes, still closes the server, and writes nothing', async () => {
      const calls = newCalls();
      await stalls('CLEANUP_FAILED', fakeDeps(calls, {}, fakePage(), never));
      expect(calls.serverClosed).toBe(1);
    });
  });

  it('fails and writes nothing when the browser does not close cleanly after a complete measurement', async () => {
    await failsWith('CLEANUP_FAILED', fakeDeps(newCalls(), {}, fakePage(), async () => { throw new Error('hung'); }));
  });

  it('fails and writes nothing when the server does not close cleanly', async () => {
    const calls = newCalls();
    await failsWith('CLEANUP_FAILED', fakeDeps(calls, { startServer: async () => ({ url: 'http://127.0.0.1:1/', close: async () => { throw new Error('busy'); } }) }));
    expect(calls.browserClosed).toBe(1);
  });

  it('keeps the first failure when the cleanup fails as well', async () => {
    await failsWith('MEASUREMENT_FAILED', fakeDeps(newCalls(), {}, fakePage({ measurePanZoom: async () => { throw new Error('boom'); } }), async () => { throw new Error('hung'); }));
  });

  it('fails and writes nothing when the report cannot be written', async () => {
    writeFileSync(join(directory, 'blocker'), 'a file where a folder is needed');
    const out = join(directory, 'blocker', 'report.json');
    await expect(runSpike({ adapter: 'cytoscape', out }, fakeDeps(newCalls()))).rejects.toMatchObject({ code: 'REPORT_WRITE_FAILED' });
    expect(existsSync(`${out}.partial`)).toBe(false);
  });

  it('takes the screenshots after each probe when asked', async () => {
    const taken: string[] = [];
    await runSpike({ adapter: 'cytoscape', out: join(directory, 'report.json'), screenshots: directory }, fakeDeps(newCalls(), {}, fakePage({ screenshot: async (path) => { taken.push(path); } })));
    expect(taken.map((path) => path.slice(directory.length + 1))).toEqual(['cytoscape-grouped.png', 'cytoscape-focus-ring.png', 'cytoscape-after-25-added.png']);
  });
});

function reportExample(): unknown {
  return {
    status: 'complete',
    measuredAt: '2026-11-03T10:00:00.000Z',
    adapter: { name: 'x', versions: { x: '1' } },
    browser: { name: 'chromium', version: '1', headed: true },
    os: { platform: 't', release: '1', arch: 'x' },
    cpu: { model: 'm', cores: 1 },
    viewport: { width: 1, height: 1, devicePixelRatio: 1 },
    protocol: { runDurationMs: 1, runs: 1, cpuThrottle: 1 },
    runs: [{ frames: 1, medianFps: 1, p5Fps: 1 }],
    grouping: { typeId: 't', supported: true, members: 1, nodesBefore: 1, nodesWhileGrouped: 1, nodesAfter: 1, restored: true },
    keyboard: { steps: [{ key: 'Tab', focusedId: null, ringVisible: false, activatedId: null, canvasFocused: false, announced: '' }], wrapsFromLast: true, ignoredWithoutFocus: true },
    incremental: RESULT,
  };
}

describe('writeReport', () => {
  it('writes a complete report whole, with no temporary file left', () => {
    const out = join(directory, 'report.json');
    writeReport(out, reportExample());
    expect(reportSchema.parse(JSON.parse(readFileSync(out, 'utf8'))).status).toBe('complete');
    expect(existsSync(`${out}.partial`)).toBe(false);
  });

  it('refuses a report that is not complete and writes no file', () => {
    const out = join(directory, 'report.json');
    expect(() => writeReport(out, { status: 'partial' })).toThrowError(expect.objectContaining({ code: 'REPORT_INVALID' }));
    expect(existsSync(out)).toBe(false);
    expect(existsSync(`${out}.partial`)).toBe(false);
  });

  it('removes its temporary file and names the failure when the folder cannot be made or the target cannot be replaced', () => {
    writeFileSync(join(directory, 'blocker'), 'a file where a folder is needed');
    expect(() => writeReport(join(directory, 'blocker', 'report.json'), reportExample())).toThrowError(expect.objectContaining({ code: 'REPORT_WRITE_FAILED' }));
    mkdirSync(join(directory, 'taken'));
    expect(() => writeReport(join(directory, 'taken'), reportExample())).toThrowError(expect.objectContaining({ code: 'REPORT_WRITE_FAILED' }));
    expect(existsSync(join(directory, 'taken.partial'))).toBe(false);
  });
});

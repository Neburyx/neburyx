import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AdapterError } from '../adapter.js';
import { FixtureError } from '../fixture/errors.js';
import { MeasureError } from '../measure/errors.js';
import { writeReport } from '../measure/report.js';
import { describeFailure, runCli } from './cli.js';
import { RunnerError } from './errors.js';
import type { PageHandle, RunnerDeps } from './run.js';

let directory = '';
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'spike-cli-'));
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

const GROUP = { total: 3, moved: 0, medianDisplacement: 0, maxDisplacement: 0 };

function page(overrides: Partial<PageHandle> = {}): PageHandle {
  return {
    whenReady: async () => undefined,
    viewport: async () => ({ width: 1, height: 1, devicePixelRatio: 1 }),
    measurePanZoom: async () => [0, 10, 20],
    measureIncremental: async () => ({ holdMechanism: 'lock', addedNodes: 25, drawnBefore: 1, drawnAfter: 26, addDurationMs: 1, frames: { frames: 1, medianFps: 60, p5Fps: 60 }, longestFrameMs: 1, manual: GROUP, pinned: GROUP, unpinned: GROUP }),
    groupingSnapshot: async () => ({ supported: true, nodesDrawn: 1, groups: [] }),
    group: async () => ({ supported: true, nodesDrawn: 1, groups: [{ typeId: 'type-b', members: 1 }] }),
    ungroup: async () => ({ supported: true, nodesDrawn: 1, groups: [] }),
    press: async () => ({ focusedId: 'a', ringVisible: true, activatedId: null, canvasFocused: true, announced: '' }),
    screenshot: async () => undefined,
    ...overrides,
  };
}

function deps(handle: PageHandle): RunnerDeps {
  return {
    adapterNames: () => ['cytoscape'],
    startServer: async () => ({ url: 'http://127.0.0.1:1/', close: async () => undefined }),
    launchBrowser: async () => ({ name: 'chromium', version: '1', openPage: async () => handle, close: async () => undefined }),
    adapterVersions: () => ({ cytoscape: '1' }),
    machine: () => ({ os: { platform: 't', release: '1', arch: 'x' }, cpu: { model: 'm', cores: 1 } }),
    now: () => new Date('2026-11-03T10:00:00.000Z'),
    writeReport,
  };
}

function io(): { readonly out: string[]; readonly err: string[]; readonly sink: { out(text: string): void; err(text: string): void } } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, sink: { out: (text) => out.push(text), err: (text) => err.push(text) } };
}

describe('runCli', () => {
  it('exits 0, prints one line per probe and writes the report', async () => {
    const capture = io();
    const code = await runCli(['--adapter', 'cytoscape', '--out', join(directory, 'r.json')], deps(page()), capture.sink);
    expect(code).toBe(0);
    expect(capture.out.join('')).toMatch(/cytoscape at 1x CPU/);
    expect(capture.err).toEqual([]);
  });

  it('exits 1 and names the cause when a run returns no frames', async () => {
    const capture = io();
    const code = await runCli(['--adapter', 'cytoscape', '--out', join(directory, 'r.json')], deps(page({ measurePanZoom: async () => [] })), capture.sink);
    expect(code).toBe(1);
    expect(capture.err.join('')).toBe('FRAME_TIMESTAMPS_INVALID\n');
  });

  it('exits 1 with a usage message when the adapter or the output is missing, and for an unknown adapter', async () => {
    const missing = io();
    expect(await runCli(['--adapter', 'cytoscape'], deps(page()), missing.sink)).toBe(1);
    expect(missing.err.join('')).toMatch(/^USAGE/);
    const unknown = io();
    expect(await runCli(['--adapter', 'nope', '--out', join(directory, 'r.json')], deps(page()), unknown.sink)).toBe(1);
    expect(unknown.err.join('')).toBe('ADAPTER_UNKNOWN\n');
  });

  it('exits 1 with USAGE, before starting anything, when an option is given without its value', async () => {
    for (const args of [['--adapter', 'cytoscape', '--out', join(directory, 'r.json'), '--cpu-throttle'], ['--adapter', 'cytoscape', '--out', join(directory, 'r.json'), '--cpu-throttle', '--screenshots'], ['--adapter', '--out', join(directory, 'r.json')]]) {
      const capture = io();
      let started = 0;
      const counting = { ...deps(page()), startServer: async () => { started += 1; return { url: 'http://127.0.0.1:1/', close: async () => undefined }; } };
      expect(await runCli(args, counting, capture.sink)).toBe(1);
      expect(capture.err.join('')).toMatch(/^USAGE: .* needs a value/);
      expect(started).toBe(0);
    }
  });

  it('exits 1 with USAGE for a throttle that is not a whole number', async () => {
    const capture = io();
    expect(await runCli(['--adapter', 'cytoscape', '--out', join(directory, 'r.json'), '--cpu-throttle', 'fast'], deps(page()), capture.sink)).toBe(1);
    expect(capture.err.join('')).toMatch(/^USAGE/);
  });
});

describe('describeFailure', () => {
  it('keeps the code of every error type the tool throws and hides anything else', () => {
    expect(describeFailure(new MeasureError('DURATION_INVALID'))).toBe('DURATION_INVALID');
    expect(describeFailure(new AdapterError('ADAPTER_UNSUPPORTED'))).toBe('ADAPTER_UNSUPPORTED');
    expect(describeFailure(new FixtureError('FIXTURE_INVALID'))).toBe('FIXTURE_INVALID');
    expect(describeFailure(new RunnerError('BUILD_MISSING'))).toBe('BUILD_MISSING');
    expect(describeFailure(new Error('secret detail'))).toBe('UNEXPECTED_ERROR');
  });
});

describe('runCli with --target product', () => {
  const sink = () => io();

  it('explains the usage when the address or the report path is missing, without starting anything', async () => {
    const { err, sink: streams } = sink();
    expect(await runCli(['--target', 'product', '--out', join(directory, 'r.json')], deps(page()), streams)).toBe(1);
    expect(await runCli(['--target', 'product', '--url', 'http://127.0.0.1:1'], deps(page()), streams)).toBe(1);
    expect(err.join('')).toContain('--target product --url');
  });

  it('refuses a target it does not know', async () => {
    const { err, sink: streams } = sink();
    expect(await runCli(['--target', 'sigma', '--out', 'x.json'], deps(page()), streams)).toBe(1);
    expect(err.join('')).toContain('--target takes product');
  });
});

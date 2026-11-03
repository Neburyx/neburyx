import { join } from 'node:path';
import { frameStatistics } from '../measure/frame-stats.js';
import type { IncrementalResult } from '../measure/incremental.js';
import { RUN_DURATION_MS, RUNS } from '../measure/pan-zoom.js';
import { GROUPED_TYPE, KEYBOARD_KEYS, summarizeGrouping, summarizeKeyboard, type GroupingSnapshot, type KeyboardState } from '../measure/probes.js';
import type { Report } from '../measure/report.js';
import { RunnerError } from './errors.js';

export interface PageHandle {
  whenReady(): Promise<void>;
  viewport(): Promise<{ readonly width: number; readonly height: number; readonly devicePixelRatio: number }>;
  measurePanZoom(durationMs: number): Promise<number[]>;
  measureIncremental(): Promise<IncrementalResult>;
  groupingSnapshot(): Promise<GroupingSnapshot>;
  group(typeId: string): Promise<GroupingSnapshot>;
  ungroup(typeId: string): Promise<GroupingSnapshot>;
  press(key: string): Promise<KeyboardState>;
  screenshot(path: string): Promise<void>;
}

export interface BrowserHandle {
  readonly name: string;
  readonly version: string;
  openPage(url: string, options: { readonly cpuThrottle: number }): Promise<PageHandle>;
  close(): Promise<void>;
}

export interface RunnerDeps {
  adapterNames(): readonly string[];
  startServer(): Promise<{ readonly url: string; close(): Promise<void> }>;
  launchBrowser(): Promise<BrowserHandle>;
  adapterVersions(adapter: string): Record<string, string>;
  machine(): Pick<Report, 'os' | 'cpu'>;
  now(): Date;
  writeReport(path: string, report: Report): void;
}

export interface Deadlines {
  readonly readyMs: number;
  readonly runMs: number;
  readonly incrementalMs: number;
  readonly probeMs: number;
  readonly cleanupMs: number;
}

export interface RunOptions {
  readonly adapter: string;
  readonly out: string;
  readonly screenshots?: string;
  readonly cpuThrottle?: number;
  readonly deadlines?: Partial<Deadlines>;
}

const SEED = 1;
const RUN_DEADLINE_FACTOR = 3;

export const DEFAULT_DEADLINES: Deadlines = { readyMs: 30_000, runMs: RUN_DURATION_MS * RUN_DEADLINE_FACTOR, incrementalMs: 60_000, probeMs: 30_000, cleanupMs: 30_000 };

function withDeadline<T>(action: Promise<T>, deadlineMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new RunnerError('MEASUREMENT_FAILED', 'DEADLINE')), deadlineMs);
  });
  return Promise.race([action, expired]).finally(() => clearTimeout(timer));
}

/** A resource that arrives after its deadline has no owner, so it is closed when it does. */
function withDeadlineOrDispose<T>(action: Promise<T>, deadlineMs: number, dispose: (late: T) => Promise<void>): Promise<T> {
  let expired = false;
  action.then(
    (late) => (expired ? dispose(late).catch(() => undefined) : undefined),
    () => undefined,
  );
  return withDeadline(action, deadlineMs).catch((error: unknown) => {
    expired = true;
    throw error;
  });
}

async function guarded<T>(action: () => Promise<T>, deadlineMs: number): Promise<T> {
  try {
    return await withDeadline(action(), deadlineMs);
  } catch (error) {
    if (error instanceof RunnerError) throw error;
    throw new RunnerError('MEASUREMENT_FAILED', error instanceof Error ? error.message : undefined);
  }
}

async function measureAll(options: RunOptions, deps: RunnerDeps, deadlines: Deadlines, cpuThrottle: number, server: { readonly url: string }, onBrowser: (browser: BrowserHandle) => void): Promise<Report> {
  let browser: BrowserHandle;
  try {
    browser = await withDeadlineOrDispose(deps.launchBrowser(), deadlines.readyMs, (late) => late.close());
  } catch {
    throw new RunnerError('BROWSER_START_FAILED');
  }
  onBrowser(browser);
  let page: PageHandle;
  try {
    page = await withDeadline(browser.openPage(`${server.url}?adapter=${encodeURIComponent(options.adapter)}&seed=${SEED}`, { cpuThrottle }), deadlines.readyMs);
    await withDeadline(page.whenReady(), deadlines.readyMs);
  } catch (error) {
    throw new RunnerError('ADAPTER_FAILED', error instanceof Error ? error.message : undefined);
  }
  const shot = async (name: string): Promise<void> => {
    if (options.screenshots !== undefined) await guarded(() => page.screenshot(join(options.screenshots ?? '', `${options.adapter}-${name}.png`)), deadlines.probeMs);
  };
  const viewport = await guarded(() => page.viewport(), deadlines.probeMs);
  const runs: Report['runs'] = [];
  for (let run = 0; run < RUNS; run += 1) runs.push(frameStatistics(await guarded(() => page.measurePanZoom(RUN_DURATION_MS), deadlines.runMs)));

  const before = await guarded(() => page.groupingSnapshot(), deadlines.probeMs);
  const grouped = await guarded(() => page.group(GROUPED_TYPE), deadlines.probeMs);
  await shot('grouped');
  const after = await guarded(() => page.ungroup(GROUPED_TYPE), deadlines.probeMs);
  const states: KeyboardState[] = [];
  for (const [index, key] of KEYBOARD_KEYS.entries()) {
    states.push(await guarded(() => page.press(key), deadlines.probeMs));
    if (index === 2) await shot('focus-ring');
  }
  const incremental = await guarded(() => page.measureIncremental(), deadlines.incrementalMs);
  await shot('after-25-added');
  return {
    status: 'complete',
    measuredAt: deps.now().toISOString(),
    adapter: { name: options.adapter, versions: deps.adapterVersions(options.adapter) },
    browser: { name: browser.name, version: browser.version, headed: true },
    ...deps.machine(),
    viewport,
    protocol: { runDurationMs: RUN_DURATION_MS, runs: RUNS, cpuThrottle },
    runs,
    grouping: summarizeGrouping(GROUPED_TYPE, before, grouped, after),
    keyboard: summarizeKeyboard(KEYBOARD_KEYS, states),
    incremental,
  };
}

/** The report is written only after the browser and the server have closed cleanly. */
export async function runSpike(options: RunOptions, deps: RunnerDeps): Promise<Report> {
  const cpuThrottle = options.cpuThrottle ?? 1;
  if (!deps.adapterNames().includes(options.adapter)) throw new RunnerError('ADAPTER_UNKNOWN');
  if (!Number.isInteger(cpuThrottle) || cpuThrottle < 1) throw new RunnerError('USAGE', 'the CPU throttle is a whole number of at least 1');
  const deadlines = { ...DEFAULT_DEADLINES, ...options.deadlines };
  let server: { readonly url: string; close(): Promise<void> };
  try {
    server = await withDeadlineOrDispose(deps.startServer(), deadlines.readyMs, (late) => late.close());
  } catch (error) {
    throw error instanceof RunnerError && error.code === 'BUILD_MISSING' ? error : new RunnerError('SERVER_START_FAILED');
  }
  const closers: Array<() => Promise<void>> = [() => server.close()];
  let report: Report | undefined;
  let failure: unknown;
  try {
    report = await measureAll(options, deps, deadlines, cpuThrottle, server, (browser) => closers.push(() => browser.close()));
  } catch (error) {
    failure = error;
  }
  let cleanupFailed = false;
  for (const close of closers.reverse()) {
    try {
      await withDeadline(close(), deadlines.cleanupMs);
    } catch {
      cleanupFailed = true;
    }
  }
  if (failure !== undefined) throw failure;
  if (cleanupFailed || report === undefined) throw new RunnerError('CLEANUP_FAILED');
  deps.writeReport(options.out, report);
  return report;
}

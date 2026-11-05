import { frameStatistics } from '../measure/frame-stats.js';
import { RUN_DURATION_MS, RUNS } from '../measure/pan-zoom.js';
import { RunnerError } from '../runner/errors.js';
import { checkDrag, checkDrawn, checkMotion, checkWheel, checkWheelReturn, type CanvasPixels, type Motion, type Readout } from './checks.js';
import { writeProductReport, type ProductReport } from './report.js';
import { evaluateTarget, TARGET } from './target.js';
import type { AddCapture, AddReport } from './add.js';
import type { LayoutCapture, LayoutReport } from './layout.js';

export const WHEEL_STEP = -100;
export const DRAG_STEP = { dx: 60, dy: 40 } as const;
const READY_MS = 30_000;
const STEP_MS = 30_000;
const RUN_DEADLINE_FACTOR = 3;
const CLEANUP_MS = 30_000;

export interface ProductPage {
  /** Loads the development fixture through the app's own loader and opens Explore. */
  openFixture(): Promise<void>;
  readout(): Promise<Readout | undefined>;
  /** The text of the canvas's failure notice, when it shows one. */
  notice(): Promise<string | undefined>;
  pixels(): Promise<CanvasPixels>;
  /** One real wheel step over the canvas. */
  wheel(deltaY: number): Promise<void>;
  /** One real drag from empty canvas by this distance. */
  drag(dx: number, dy: number): Promise<void>;
  /** Runs the harness's scripted pan and zoom with wheel and drag events on the canvas and returns the frame times and what the run did to the view. */
  measurePanZoom(durationMs: number, wheelStep: number): Promise<{ readonly times: number[]; readonly motion: Motion }>;
  viewport(): Promise<{ readonly width: number; readonly height: number; readonly devicePixelRatio: number }>;
  /** Marks where every entity is drawn, records frame times from just before pressing the app's development control that adds entities, and returns them with the read-outs before and after, once the add is drawn and the frames after it have passed. */
  measureAdd(framesAfter: number): Promise<AddCapture>;
  /** Displaces ten unpinned entities with the app's development control, marks where every entity is drawn, records frame times from just before the layout control is pressed and Force chosen, and returns them with the read-outs before and after, once the run is drawn and the frames after it have passed. */
  measureLayout(framesAfter: number): Promise<LayoutCapture>;
}

export interface ProductBrowser {
  readonly name: string;
  readonly version: string;
  /** Whether the browser has a window; headed when not said. */
  readonly headed?: boolean;
  openPage(url: string, options: { readonly cpuThrottle: number }): Promise<ProductPage>;
  close(): Promise<void>;
}

export interface ProductDeps {
  launchBrowser(): Promise<ProductBrowser>;
  machine(): Pick<ProductReport, 'os' | 'cpu'>;
  now(): Date;
  writeReport(path: string, report: unknown): ProductReport;
  writeAddReport(path: string, report: unknown): AddReport;
  writeLayoutReport(path: string, report: unknown): LayoutReport;
}

export interface ProductOptions {
  readonly url: string;
  readonly out: string;
  readonly cpuThrottle?: number;
  readonly deadlines?: { readonly readyMs?: number; readonly stepMs?: number; readonly runMs?: number; readonly cleanupMs?: number };
}

export function withDeadline<T>(action: Promise<T>, deadlineMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new RunnerError('MEASUREMENT_FAILED', 'DEADLINE')), deadlineMs);
  });
  return Promise.race([action, expired]).finally(() => clearTimeout(timer));
}

export async function step<T>(action: () => Promise<T>, deadlineMs: number): Promise<T> {
  try {
    return await withDeadline(action(), deadlineMs);
  } catch (error) {
    if (error instanceof RunnerError) throw error;
    throw new RunnerError('MEASUREMENT_FAILED', error instanceof Error ? error.message : undefined);
  }
}

/** A browser that arrives after its deadline has no owner, so it is closed when it does. */
export async function launch(deps: ProductDeps, deadlineMs: number): Promise<ProductBrowser> {
  const attempt = deps.launchBrowser();
  let expired = false;
  attempt.then(
    (late) => (expired ? late.close().catch(() => undefined) : undefined),
    () => undefined,
  );
  try {
    return await withDeadline(attempt, deadlineMs);
  } catch (error) {
    expired = true;
    throw error;
  }
}

export function parseUrl(url: string): URL {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('not http');
    return parsed;
  } catch {
    throw new RunnerError('USAGE', '--url needs the address of the running app, for example http://127.0.0.1:5173');
  }
}

/** The checks that tell a drawing from a page that only loaded the records, made before any figure is taken. */
async function prepare(page: ProductPage, stepMs: number): Promise<Readout> {
  await step(() => page.openFixture(), stepMs);
  const readout = checkDrawn(await step(() => page.readout(), stepMs), await step(() => page.notice(), stepMs), await step(() => page.pixels(), stepMs));
  await step(() => page.wheel(WHEEL_STEP), stepMs);
  const zoomed = await step(() => page.readout(), stepMs);
  if (zoomed === undefined) throw new RunnerError('CANVAS_MISSING');
  checkWheel(readout, zoomed, WHEEL_STEP);
  await step(() => page.wheel(-WHEEL_STEP), stepMs);
  const back = await step(() => page.readout(), stepMs);
  if (back === undefined) throw new RunnerError('CANVAS_MISSING');
  checkWheelReturn(readout, back);
  const pictureBefore = await step(() => page.pixels(), stepMs);
  await step(() => page.drag(DRAG_STEP.dx, DRAG_STEP.dy), stepMs);
  const panned = await step(() => page.readout(), stepMs);
  if (panned === undefined) throw new RunnerError('CANVAS_MISSING');
  checkDrag(back, panned, DRAG_STEP.dx, DRAG_STEP.dy, pictureBefore, await step(() => page.pixels(), stepMs));
  return readout;
}

/** The report is written only after the browser has closed cleanly. */
export async function runProductBenchmark(options: ProductOptions, deps: ProductDeps): Promise<ProductReport> {
  const target = parseUrl(options.url);
  const cpuThrottle = options.cpuThrottle ?? 1;
  if (!Number.isInteger(cpuThrottle) || cpuThrottle < 1) throw new RunnerError('USAGE', 'the CPU throttle is a whole number of at least 1');
  const readyMs = options.deadlines?.readyMs ?? READY_MS;
  const stepMs = options.deadlines?.stepMs ?? STEP_MS;
  const runMs = options.deadlines?.runMs ?? RUN_DURATION_MS * RUN_DEADLINE_FACTOR;
  const cleanupMs = options.deadlines?.cleanupMs ?? CLEANUP_MS;

  let browser: ProductBrowser;
  try {
    browser = await launch(deps, readyMs);
  } catch {
    throw new RunnerError('BROWSER_START_FAILED');
  }
  let report: ProductReport | undefined;
  let failure: unknown;
  try {
    let page: ProductPage;
    try {
      page = await withDeadline(browser.openPage(new URL('/dev/fixture', target).toString(), { cpuThrottle }), readyMs);
    } catch {
      throw new RunnerError('APP_UNREACHABLE', target.origin);
    }
    const drawn = await prepare(page, stepMs);
    const viewport = await step(() => page.viewport(), stepMs);
    const runs: ProductReport['runs'] = [];
    for (let run = 0; run < RUNS; run += 1) {
      const measured = await step(() => page.measurePanZoom(RUN_DURATION_MS, WHEEL_STEP), runMs);
      checkMotion(measured.motion);
      runs.push({ ...frameStatistics(measured.times), ...measured.motion });
    }
    report = {
      status: 'complete',
      target: 'product',
      measuredAt: deps.now().toISOString(),
      app: { origin: target.origin, drawnEntities: drawn.entities, drawnRelationships: drawn.relationships },
      browser: { name: browser.name, version: browser.version, headed: browser.headed ?? true },
      ...deps.machine(),
      viewport,
      protocol: { runDurationMs: RUN_DURATION_MS, runs: RUNS, cpuThrottle },
      runs,
      goal: TARGET,
      verdict: evaluateTarget(runs, cpuThrottle),
    };
  } catch (error) {
    failure = error;
  }
  let cleanupFailed = false;
  try {
    await withDeadline(browser.close(), cleanupMs);
  } catch {
    cleanupFailed = true;
  }
  if (failure !== undefined) throw failure;
  if (cleanupFailed || report === undefined) throw new RunnerError('CLEANUP_FAILED');
  return deps.writeReport(options.out, report);
}

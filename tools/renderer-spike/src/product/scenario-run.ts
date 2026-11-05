import { RunnerError } from '../runner/errors.js';
import { ADD_RUNS, ADD_TARGET } from './add.js';
import { checkDrawn } from './checks.js';
import { launch, parseUrl, step, withDeadline, type ProductBrowser, type ProductDeps, type ProductOptions, type ProductPage } from './run.js';

const READY_MS = 30_000;
const STEP_MS = 30_000;
const RUN_MS = 30_000;
const CLEANUP_MS = 30_000;

export interface Environment {
  readonly measuredAt: string;
  readonly app: { readonly origin: string; readonly drawnEntities: number; readonly drawnRelationships: number };
  readonly browser: { readonly name: string; readonly version: string; readonly headed: boolean };
  readonly os: { readonly platform: string; readonly release: string; readonly arch: string };
  readonly cpu: { readonly model: string; readonly cores: number };
  readonly viewport: { readonly width: number; readonly height: number; readonly devicePixelRatio: number };
  readonly protocol: { readonly runs: number; readonly framesAfter: number; readonly cpuThrottle: number };
}

/** One run: a page of its own, so each starts from the freshly loaded fixture, checked to be drawn before anything is pressed. */
async function runOnce<Run>(browser: ProductBrowser, url: string, cpuThrottle: number, deadlines: { readonly readyMs: number; readonly stepMs: number; readonly runMs: number }, measure: (page: ProductPage) => Promise<Run>) {
  let page: ProductPage;
  try {
    page = await withDeadline(browser.openPage(url, { cpuThrottle }), deadlines.readyMs);
  } catch {
    throw new RunnerError('APP_UNREACHABLE', new URL(url).origin);
  }
  await step(() => page.openFixture(), deadlines.stepMs);
  const drawn = checkDrawn(await step(() => page.readout(), deadlines.stepMs), await step(() => page.notice(), deadlines.stepMs), await step(() => page.pixels(), deadlines.stepMs));
  const run = await step(() => measure(page), deadlines.runMs);
  return { run, drawn: { entities: drawn.entities, relationships: drawn.relationships }, page };
}

/** Three runs of one scenario, each on a page of its own, and a report that is written only after the browser has closed cleanly. */
export async function runScenario<Run extends { readonly longestFrameMs: number; readonly p5Fps: number }, Report>(
  options: ProductOptions,
  deps: ProductDeps,
  measure: (page: ProductPage) => Promise<Run>,
  report: (environment: Environment, runs: readonly Run[]) => Report,
  write: (path: string, report: Report) => Report,
): Promise<Report> {
  const target = parseUrl(options.url);
  const cpuThrottle = options.cpuThrottle ?? 1;
  if (!Number.isInteger(cpuThrottle) || cpuThrottle < 1) throw new RunnerError('USAGE', 'the CPU throttle is a whole number of at least 1');
  const deadlines = { readyMs: options.deadlines?.readyMs ?? READY_MS, stepMs: options.deadlines?.stepMs ?? STEP_MS, runMs: options.deadlines?.runMs ?? RUN_MS };
  const cleanupMs = options.deadlines?.cleanupMs ?? CLEANUP_MS;

  let browser: ProductBrowser;
  try {
    browser = await launch(deps, deadlines.readyMs);
  } catch {
    throw new RunnerError('BROWSER_START_FAILED');
  }
  let finished: Report | undefined;
  let failure: unknown;
  try {
    const runs: Run[] = [];
    let drawn = { entities: 0, relationships: 0 };
    let last: ProductPage | undefined;
    for (let count = 0; count < ADD_RUNS; count += 1) {
      const once = await runOnce(browser, new URL('/dev/fixture', target).toString(), cpuThrottle, deadlines, measure);
      runs.push(once.run);
      drawn = once.drawn;
      last = once.page;
    }
    if (last === undefined) throw new RunnerError('CANVAS_MISSING');
    const final = last;
    const viewport = await step(() => final.viewport(), deadlines.stepMs);
    finished = report(
      {
        measuredAt: deps.now().toISOString(),
        app: { origin: target.origin, drawnEntities: drawn.entities, drawnRelationships: drawn.relationships },
        browser: { name: browser.name, version: browser.version, headed: browser.headed ?? true },
        ...deps.machine(),
        viewport,
        protocol: { runs: ADD_RUNS, framesAfter: ADD_TARGET.framesAfter, cpuThrottle },
      },
      runs,
    );
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
  if (cleanupFailed || finished === undefined) throw new RunnerError('CLEANUP_FAILED');
  return write(options.out, finished);
}

import { ADD_TARGET, checkAdd, evaluateAdd, type AddReport } from './add.js';
import type { ProductDeps, ProductOptions } from './run.js';
import { runScenario } from './scenario-run.js';

/** Adds 25 entities to the drawn fixture three times, on separate loads, and holds each run to the checks and the figures to the target. */
export function runAddBenchmark(options: ProductOptions, deps: ProductDeps): Promise<AddReport> {
  return runScenario(
    options,
    deps,
    async (page) => checkAdd(await page.measureAdd(ADD_TARGET.framesAfter)),
    (environment, runs) => ({
      status: 'complete',
      target: 'product',
      scenario: 'add',
      ...environment,
      runs: [...runs],
      goal: { cpuThrottle: ADD_TARGET.cpuThrottle, longestFrameMs: ADD_TARGET.longestFrameMs, p5Fps: ADD_TARGET.p5Fps },
      verdict: evaluateAdd(runs, environment.protocol.cpuThrottle),
    }),
    (path, report) => deps.writeAddReport(path, report),
  );
}


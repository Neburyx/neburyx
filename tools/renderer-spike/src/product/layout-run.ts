import { ADD_TARGET, evaluateAdd } from './add.js';
import { checkLayout, type LayoutReport } from './layout.js';
import type { ProductDeps, ProductOptions } from './run.js';
import { runScenario } from './scenario-run.js';

/** Lays the fixture out again three times, on separate loads, after displacing ten entities, and holds each run to the checks and the figures to the same target as the add. */
export function runLayoutBenchmark(options: ProductOptions, deps: ProductDeps): Promise<LayoutReport> {
  return runScenario(
    options,
    deps,
    async (page) => checkLayout(await page.measureLayout(ADD_TARGET.framesAfter)),
    (environment, runs) => ({
      status: 'complete',
      target: 'product',
      scenario: 'layout',
      ...environment,
      runs: [...runs],
      goal: { cpuThrottle: ADD_TARGET.cpuThrottle, longestFrameMs: ADD_TARGET.longestFrameMs, p5Fps: ADD_TARGET.p5Fps },
      verdict: evaluateAdd(runs, environment.protocol.cpuThrottle),
    }),
    (path, report) => deps.writeLayoutReport(path, report),
  );
}

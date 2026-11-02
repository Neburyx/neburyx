import { AppError } from '../errors.js';
import type { Clock, SystemRunner } from '../gate/types.js';
import type { MappingModel } from '../mapping/model.js';
import { checkSource, type CheckStore } from './check.js';

/** What the startup check found for one source: the outcome of the report, or `error` when the run said nothing about the source. */
export interface StartupResult {
  readonly sourceId: string;
  readonly outcome: 'pass' | 'warn' | 'fail' | 'error';
}

export interface StartupLogger {
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
}

export interface StartupCheckerDeps {
  readonly system: SystemRunner;
  readonly mapping: MappingModel;
  readonly store: CheckStore;
  readonly logger: StartupLogger;
  readonly clock?: Clock;
}

export interface StartupChecker {
  run(): Promise<readonly StartupResult[]>;
}

/** Why `start` should stop after the checks; no rule stops it yet, and the live mapping checks add theirs here. */
export function startupProblem(_results: readonly StartupResult[]): string | undefined {
  return undefined;
}

/** Tests every mapped source at once through the system runner and stores each result; each run is bounded by the gate's request deadline. */
export function createStartupChecker(deps: StartupCheckerDeps): StartupChecker {
  const clock = deps.clock ?? Date.now;
  async function checkOne(sourceId: string): Promise<StartupResult> {
    const source = deps.mapping.sources.find((candidate) => candidate.id === sourceId);
    if (source === undefined) return { sourceId, outcome: 'error' };
    let outcome: StartupResult['outcome'];
    try {
      const report = await checkSource({ store: deps.store, clock }, source, (request) => deps.system.run(request), `tr-startup-${sourceId}`, null);
      outcome = report.outcome;
    } catch (error) {
      // a failure of the gate says nothing about the source; a failure of the database is not caught here and stops the start
      if (!(error instanceof AppError)) throw error;
      outcome = 'error';
    }
    const log = outcome === 'pass' ? deps.logger.info : deps.logger.warn;
    log.call(deps.logger, { event: 'source.startup_check', sourceId, outcome }, 'source startup check');
    return { sourceId, outcome };
  }
  return { run: () => Promise.all(deps.mapping.sources.map((source) => checkOne(source.id))) };
}

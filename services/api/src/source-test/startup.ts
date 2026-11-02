import { AppError } from '../errors.js';
import type { Clock, SystemRunner } from '../gate/types.js';
import type { MappingModel } from '../mapping/model.js';
import type { MappingFinding } from '@neburyx/contracts';
import { checkSource, type CheckStore } from './check.js';
import { FIX_THE_SOURCE, NOT_CHECKED_SINCE_START } from './reasons.js';

/**
 * What the startup check found for one source: the outcome of the report, or `error` when the run did not settle; whether the server answered the capabilities read
 * (also when a later read did not settle); and the findings of the mapping checks.
 */
export interface StartupResult {
  readonly sourceId: string;
  readonly outcome: 'pass' | 'warn' | 'fail' | 'error';
  readonly answered: boolean;
  readonly findings: readonly MappingFinding[];
}

export interface StartupLogger {
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
}

export interface StartupStore extends CheckStore {
  markSourceUnchecked(sourceId: string, reason: string): Promise<void>;
}

export interface StartupCheckerDeps {
  readonly system: SystemRunner;
  readonly mapping: MappingModel;
  readonly store: StartupStore;
  readonly logger: StartupLogger;
  readonly clock?: Clock;
}

export interface StartupChecker {
  run(): Promise<readonly StartupResult[]>;
}

/** The most findings the message that stops the start lists; the rest are counted. */
const LISTED_FINDINGS = 20;

/**
 * Why `start` should stop after the checks: a source whose mapping does not fit it, with one line per failing finding that names the source, the entity type or relationship type,
 * the property and the check. A source that did not answer, a warning and something that could not be verified do not stop it.
 */
export function startupProblem(results: readonly StartupResult[]): string | undefined {
  const lines = results.flatMap((result) => result.findings.filter((finding) => finding.severity === 'fail').map((finding) => `source ${result.sourceId}: ${finding.message}`));
  if (lines.length === 0) return undefined;
  const listed = lines.slice(0, LISTED_FINDINGS);
  const more = lines.length > LISTED_FINDINGS ? [`and ${lines.length - LISTED_FINDINGS} more`] : [];
  return [...listed, ...more, FIX_THE_SOURCE].join('\n');
}

/** Tests every mapped source at once through the system runner and stores each result; each run makes several reads one after another, each bounded by the gate's request deadline. */
export function createStartupChecker(deps: StartupCheckerDeps): StartupChecker {
  const clock = deps.clock ?? Date.now;
  async function checkOne(sourceId: string): Promise<StartupResult> {
    const source = deps.mapping.sources.find((candidate) => candidate.id === sourceId);
    if (source === undefined) return { sourceId, outcome: 'error', answered: false, findings: [] };
    let outcome: StartupResult['outcome'];
    let answered = false;
    let findings: readonly MappingFinding[] = [];
    try {
      const report = await checkSource({ store: deps.store, clock, logger: deps.logger, onAnswered: () => void (answered = true) }, source, (request) => deps.system.run(request), `tr-startup-${sourceId}`, null);
      outcome = report.outcome;
      answered = report.server !== null;
      findings = report.mappingChecks.findings;
    } catch (error) {
      // a failure of the gate says nothing about the source; a failure of the database is not caught here and stops the start
      if (!(error instanceof AppError)) throw error;
      outcome = 'error';
      // nothing was stored, so the state left from before the restart would stand: say that the source has not been checked
      await deps.store.markSourceUnchecked(sourceId, NOT_CHECKED_SINCE_START);
    }
    const log = outcome === 'pass' ? deps.logger.info : deps.logger.warn;
    log.call(deps.logger, { event: 'source.startup_check', sourceId, outcome }, 'source startup check');
    if (findings.some((finding) => finding.check === 'schema-refused')) {
      deps.logger.warn({ event: 'source.mapping_not_verified', sourceId }, 'source mapping checks were not verified');
    }
    return { sourceId, outcome, answered, findings };
  }
  return { run: () => Promise.all(deps.mapping.sources.map((source) => checkOne(source.id))) };
}

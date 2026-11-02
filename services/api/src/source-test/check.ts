import type { SourceTestReport } from '@neburyx/contracts';
import type { SourceCheck } from '../db/source-checks-repository.js';
import { AppError } from '../errors.js';
import { CAPABILITIES_ID, capabilitiesItemSchema } from '../gate/templates/capabilities.js';
import type { Clock, GatePage } from '../gate/types.js';
import { uuidv7 } from '../identity/uuid.js';
import type { SourceModel } from '../mapping/model.js';
import { failureReasonOf } from './reasons.js';
import { reportFromFailure, reportFromServer } from './report.js';

/** What a check needs of the application database. */
export interface CheckStore {
  hasActiveSource(sourceId: string): Promise<boolean>;
  recordSourceCheck(check: SourceCheck): Promise<void>;
}

/** Runs one gate request for the check: as a user through the `Gate`, or as the system through the `SystemRunner`. */
export interface CheckRequest {
  readonly traceId: string;
  readonly sourceId: string;
  readonly templateId: string;
  readonly params: unknown;
  readonly limit: number;
}

export type CheckRun = (request: CheckRequest) => Promise<GatePage>;

export interface CheckDeps {
  readonly store: CheckStore;
  readonly clock: Clock;
}

async function verdictFor(source: SourceModel, run: CheckRun, traceId: string, clock: Clock): Promise<SourceTestReport> {
  let page: GatePage;
  try {
    page = await run({ traceId, sourceId: source.id, templateId: CAPABILITIES_ID, params: {}, limit: 1 });
  } catch (error) {
    const reason = failureReasonOf(error);
    if (reason === undefined) throw error;
    return reportFromFailure(source, reason, new Date(clock()).toISOString());
  }
  // the read asks for one row more than the page: a second row means the server answered something this check does not understand
  if (page.hasMore) throw new AppError('INTERNAL_ERROR');
  return reportFromServer(source, capabilitiesItemSchema.parse(page.items[0]), new Date(clock()).toISOString());
}

/** Tests one source, stores the verdict and returns it; anything that is not a verdict about the source is thrown and stores nothing. */
export async function checkSource(deps: CheckDeps, source: SourceModel, run: CheckRun, traceId: string, triggeredBy: string | null): Promise<SourceTestReport> {
  if (!(await deps.store.hasActiveSource(source.id))) throw new AppError('NOT_FOUND');
  const report = await verdictFor(source, run, traceId, deps.clock);
  await deps.store.recordSourceCheck({ id: uuidv7(), report, triggeredBy });
  return report;
}

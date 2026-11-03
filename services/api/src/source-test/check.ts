import type { SourceTestReport } from '@neburyx/contracts';
import type { SourceCheck } from '../db/source-checks-repository.js';
import { AppError } from '../errors.js';
import { CAPABILITIES_ID, capabilitiesItemSchema } from '../gate/templates/capabilities.js';
import { PRIVILEGES_ID, privilegeRowSchema, type PrivilegeRow } from '../gate/templates/privileges.js';
import { isUnreadable, type UnreadableRow } from '../gate/templates/unreadable.js';
import type { Clock, GateLogger, GatePage } from '../gate/types.js';
import { uuidv7 } from '../identity/uuid.js';
import type { SourceModel } from '../mapping/model.js';
import { identityHashOf } from '../registry/identity-hash.js';
import type { WriteProbe } from './probe.js';
import { failureReasonOf, isReadNotVerified } from './reasons.js';
import { checkDegrees, NOT_RUN_DEGREES } from './degree-stage.js';
import { checkMapping } from './mapping-stage.js';
import { NOT_RUN } from './mapping-checks.js';
import { reportFromFailure, reportFromServer } from './report.js';
import { serverVersionText } from './server-version.js';
import { loginCanWrite } from './write-verdict.js';

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
  /** The opt-in write probe; given by the `test-source` command when it is asked for it, never by the route or the startup check. */
  readonly probe?: WriteProbe;
  /** Where the check says that the server listed privileges it could not read; absent, it says nothing. */
  readonly logger?: GateLogger;
  /** Called when the capabilities read has answered, so that a caller can tell a source that answered from one that did not even when a later read does not settle. */
  readonly onAnswered?: () => void;
}

/** What the privileges said: whether the login can write (null when they could not be inspected or do not settle it), and whether the server listed rows the check could not read. */
interface PrivilegeFinding {
  readonly canWrite: boolean | null;
  readonly unreadable: boolean;
}

const NOT_VERIFIED: PrivilegeFinding = { canWrite: null, unreadable: false };
/** The most unreadable rows whose column types the check writes to its log. */
const LOGGED_SHAPES = 5;

/** Reads the privileges of the login through the source's own page size, which the mapping bounds at 50. */
async function inspectPrivileges(source: SourceModel, run: CheckRun, traceId: string, logger: GateLogger | undefined): Promise<PrivilegeFinding> {
  let page: GatePage;
  try {
    page = await run({ traceId, sourceId: source.id, templateId: PRIVILEGES_ID, params: {}, limit: source.budgets.maxPage });
  } catch (error) {
    if (isReadNotVerified(error)) return NOT_VERIFIED;
    throw error;
  }
  // more rows than the page is not a listing to judge
  if (page.hasMore) return NOT_VERIFIED;
  const rows: PrivilegeRow[] = [];
  const unreadable: UnreadableRow[] = [];
  for (const item of page.items) {
    const parsed = privilegeRowSchema.safeParse(item);
    if (parsed.success) rows.push(parsed.data);
    else if (isUnreadable(item)) unreadable.push(item);
    else throw new AppError('INTERNAL_ERROR');
  }
  if (unreadable.length > 0) {
    // the count and the type of each column, never a value
    logger?.warn({ event: 'source.privileges_unreadable', sourceId: source.id, rows: unreadable.length, columnTypes: unreadable.slice(0, LOGGED_SHAPES).map((row) => row.unreadable) }, 'source privileges could not be read');
    return { canWrite: null, unreadable: true };
  }
  return { canWrite: loginCanWrite(rows, source.database), unreadable: false };
}

async function verdictFor(source: SourceModel, run: CheckRun, traceId: string, deps: CheckDeps): Promise<SourceTestReport> {
  const { clock } = deps;
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
  const server = capabilitiesItemSchema.parse(page.items[0]);
  deps.onAnswered?.();
  const privileges = await inspectPrivileges(source, run, traceId, deps.logger);
  // a version outside the matrix is not read for its schema: the commands were verified on the supported versions only
  const mapping = server.versionSupported ? await checkMapping(source, run, traceId, { clock, logger: deps.logger }) : NOT_RUN;
  // the degree probes run on a source whose mapping fits it, or whose fit was not verified
  const degrees = server.versionSupported && mapping.status !== 'fail' ? await checkDegrees(source, run, traceId, serverVersionText(server), { clock, logger: deps.logger }) : NOT_RUN_DEGREES;
  const checkedAt = new Date(clock()).toISOString();
  // the probe writes, and was verified to roll back on the supported versions only
  const probed = deps.probe !== undefined && server.versionSupported ? await deps.probe(source, traceId) : 'inconclusive';
  if (probed === 'can-write') return reportFromServer(source, server, true, checkedAt, { probed: true, mapping, degrees });
  // a refused CREATE does not show that the login cannot write where logins have privilege roles: there it speaks only when the privileges said false,
  // and on Community, which has none, the refusal concerns the whole login or database and is the only signal; privileges that show a write right or could not be settled stand
  const refusalCounts = privileges.canWrite === false || (privileges.canWrite === null && server.edition.toLowerCase() === 'community');
  if (probed === 'cannot-write' && refusalCounts) return reportFromServer(source, server, false, checkedAt, { probed: true, mapping, degrees });
  return reportFromServer(source, server, privileges.canWrite, checkedAt, { unreadable: privileges.unreadable, mapping, degrees });
}

/** Tests one source, stores the verdict and returns it; anything that is not a verdict about the source is thrown and stores nothing. */
export async function checkSource(deps: CheckDeps, source: SourceModel, run: CheckRun, traceId: string, triggeredBy: string | null): Promise<SourceTestReport> {
  if (!(await deps.store.hasActiveSource(source.id))) throw new AppError('NOT_FOUND');
  const report = await verdictFor(source, run, traceId, deps);
  await deps.store.recordSourceCheck({ id: uuidv7(), report, triggeredBy, identityHash: identityHashOf(source), configHash: source.configHash });
  return report;
}

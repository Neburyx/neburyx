import { MAX_READ_REFS, type ElementRefs, type ElementsScope, type SourceElementsScope, type SummaryReading } from '@neburyx/contracts';
import { AppError } from '../errors.js';
import type { ShownReader } from '../exports/shown-reader.js';
import type { SourceAccess } from '../investigations/source-access.js';
import { sourceChangedRefusal } from '../investigations/read-only.js';
import type { InvestigationService } from '../investigations/investigation-service.js';
import type { Principal } from '../seams/seams.js';

/** The action a refusal of the summary's read is audited under. */
const SUMMARY_READ_AUDIT_ACTION = 'ai.case-summary.read';

interface ElementsReaderDeps {
  /** The reader the exports use: it reads through the gate in chunks under one deadline, leaves out what the person may not export and counts what is not yet retrieved from the cached degree previews. */
  readonly shownReader: ShownReader;
  readonly investigations: Pick<InvestigationService, 'read'>;
  /** Counts the click as one request of the person on the source: the reader's chunks do not count again. */
  readonly access: Pick<SourceAccess, 'require'>;
  readonly principal: Principal;
  readonly traceId: string;
  readonly signal: AbortSignal;
}

async function investigationOf(investigations: ElementsReaderDeps['investigations'], principal: Principal, investigationId: string, sourceId: string): Promise<void> {
  const { investigation } = await investigations.read({ id: investigationId, principal });
  if (investigation.sourceId !== sourceId) throw new AppError('NOT_FOUND');
  const changed = sourceChangedRefusal(investigation.sourceState);
  if (changed !== undefined) throw changed;
}

/** Whether the investigation is the caller's and for the source, and the source is as the investigation left it: a read that finds otherwise rejects as every reader of an investigation does. */
export function createInvestigationCheck(deps: Pick<ElementsReaderDeps, 'investigations' | 'principal'>): (investigationId: string, sourceId: string) => Promise<void> {
  return (investigationId, sourceId) => investigationOf(deps.investigations, deps.principal, investigationId, sourceId);
}

/**
 * Reads the elements of a view of an investigation again through the shown reader of the exports, for the investigation of a person whose source is as the investigation left it. The kinds of reference the
 * reader takes are the four a request holds; what the person may not export is not returned, and `omitted` says so.
 */
export function createElementsReader(deps: ElementsReaderDeps): (scope: ElementsScope, refs: ElementRefs) => Promise<SummaryReading> {
  const read = readThrough(deps, SUMMARY_READ_AUDIT_ACTION);
  return async (scope, refs) => {
    await investigationOf(deps.investigations, deps.principal, scope.investigationId, scope.sourceId);
    return read(scope, refs);
  };
}

/** The action a refusal of the read of a source's elements is audited under: the action of the read by references the reads inside it belong to. */
const SOURCE_READ_AUDIT_ACTION = 'graph.read_refs';

/**
 * The same reader for a route that has no investigation (Ask's): it reads the elements of a source for the person through the shown reader, with the mask, the export rule and the counts of `createElementsReader`, counts the call once
 * against the person's rate on the source, and refuses a source the person may not read as `NOT_FOUND`. More than `MAX_READ_REFS` references of a kind is refused as `INVALID_REQUEST` before anything is read.
 */
export function createSourceElementsReader(deps: Omit<ElementsReaderDeps, 'investigations'>): (scope: SourceElementsScope, refs: ElementRefs) => Promise<SummaryReading> {
  const read = readThrough(deps, SOURCE_READ_AUDIT_ACTION);
  return async (scope, refs) => {
    if ([refs.entities, refs.edges, refs.aggregates, refs.derived].some((kind) => kind.length > MAX_READ_REFS)) throw new AppError('INVALID_REQUEST');
    return read(scope, refs);
  };
}

function readThrough(deps: Omit<ElementsReaderDeps, 'investigations'>, auditAction: string): (scope: SourceElementsScope, refs: ElementRefs) => Promise<SummaryReading> {
  return async (scope, refs) => {
    await deps.access.require({ traceId: deps.traceId, principal: deps.principal, sourceId: scope.sourceId, auditAction, rate: 'count' });
    const read = await deps.shownReader.read({ traceId: deps.traceId, principal: deps.principal, sourceId: scope.sourceId, mask: scope.mask, signal: scope.signal === undefined ? deps.signal : AbortSignal.any([deps.signal, scope.signal]), entities: refs.entities, edges: refs.edges, aggregates: refs.aggregates, derived: refs.derived });
    return { nodes: [...read.nodes], edges: [...read.edges], unresolved: read.unresolvedCount, omitted: read.omitted, notRetrieved: read.notRetrieved, uncounted: read.uncounted };
  };
}

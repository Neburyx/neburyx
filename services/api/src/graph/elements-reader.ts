import { MAX_READ_REFS, type ElementRefs, type ElementsScope, type ReadRefsResponse } from '@neburyx/contracts';
import { AppError, RequestCancelled } from '../errors.js';
import { DEFAULT_BUDGETS } from '../gate/budgets.js';
import { sourceChangedRefusal } from '../investigations/read-only.js';
import { canonicalJson } from '../gate/cursor/binding.js';
import type { InvestigationService } from '../investigations/investigation-service.js';
import type { Principal } from '../seams/seams.js';
import type { ReadRefsService } from './read-refs-service.js';

interface ElementsReaderDeps {
  /** The deadline of the whole request, in milliseconds; every read of it shares it. */
  readonly requestTimeoutMs?: number;
  readonly readRefs: ReadRefsService;
  readonly investigations: Pick<InvestigationService, 'read'>;
  readonly principal: Principal;
  readonly traceId: string;
  readonly signal: AbortSignal;
}

const slice = <T>(list: readonly T[], from: number): T[] => list.slice(from, from + MAX_READ_REFS);

function distinct<T>(list: readonly T[]): T[] {
  const seen = new Map<string, T>();
  for (const entry of list) seen.set(canonicalJson(entry), entry);
  return [...seen.values()];
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
 * Reads the elements of a view of an investigation again through the gate, in as many reads by references as their number needs. The investigation must be the caller's and be for the source, as `NOT_FOUND`
 * says of both; only the first read counts against the caller's request rate, as the request is one.
 */
export function createElementsReader(deps: ElementsReaderDeps): (scope: ElementsScope, refs: ElementRefs) => Promise<ReadRefsResponse> {
  return async (scope, refs) => {
    await investigationOf(deps.investigations, deps.principal, scope.investigationId, scope.sourceId);
    const limit = deps.requestTimeoutMs ?? DEFAULT_BUDGETS.requestTimeoutMs;
    const deadline = AbortSignal.timeout(limit);
    const signal = AbortSignal.any([deps.signal, deadline]);
    const timedOut = (): AppError => new AppError('QUERY_TIMEOUT', { timeoutMs: limit });
    const nodes: ReadRefsResponse['nodes'] = [];
    const edges: ReadRefsResponse['edges'] = [];
    const missing: { entities: ReadRefsResponse['missing']['entities']; edges: ReadRefsResponse['missing']['edges'] } = { entities: [], edges: [] };
    const longest = Math.max(refs.entities.length, refs.edges.length, refs.aggregates.length, refs.derived.length);
    for (let from = 0; from < Math.max(longest, 1); from += MAX_READ_REFS) {
      if (deadline.aborted && !deps.signal.aborted) throw timedOut();
      if (deps.signal.aborted) throw new RequestCancelled();
      let part: ReadRefsResponse;
      try {
        part = await deps.readRefs.read({
          traceId: deps.traceId,
          principal: deps.principal,
          signal,
          countRate: from === 0,
          request: { sourceId: scope.sourceId, mask: scope.mask, entities: slice(refs.entities, from), edges: slice(refs.edges, from), aggregates: slice(refs.aggregates, from), derived: slice(refs.derived, from) },
        });
      } catch (error) {
        if (error instanceof RequestCancelled && deadline.aborted && !deps.signal.aborted) throw timedOut();
        throw error;
      }
      nodes.push(...part.nodes);
      edges.push(...part.edges);
      missing.entities.push(...part.missing.entities);
      missing.edges.push(...part.missing.edges);
    }
    return { nodes: distinct(nodes), edges: distinct(edges), missing: { entities: distinct(missing.entities), edges: distinct(missing.edges) } };
  };
}

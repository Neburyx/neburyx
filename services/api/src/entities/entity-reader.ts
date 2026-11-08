import type { GraphNode } from '@neburyx/contracts';
import { AppError } from '../errors.js';
import type { Normalized } from '../gate/normalize/index.js';
import { ENTITY_LOAD_ID } from '../gate/templates/entity-load.js';
import type { Gate } from '../gate/types.js';
import type { MappingModel } from '../mapping/model.js';
import type { SourceAccess } from '../investigations/source-access.js';
import type { Principal } from '../seams/seams.js';

export interface EntityReadRequest {
  readonly traceId: string;
  readonly principal: Principal;
  readonly sourceId: string;
  readonly entityType: string;
  readonly stableId: string;
  readonly mask: boolean;
  /** Set by the route that is the request's own; an inner read for another request leaves it out. */
  readonly rate?: 'count';
  /** Aborted when the client gives up the request. */
  readonly signal?: AbortSignal;
}

export interface EntityReader {
  read(request: EntityReadRequest): Promise<GraphNode>;
}

const ONE_ROW = 1;

function isNormalized(item: unknown): item is Normalized {
  return typeof item === 'object' && item !== null && 'nodes' in item && Array.isArray(item.nodes);
}

export function createEntityReader(deps: { readonly gate: Gate; readonly mapping: MappingModel; readonly access: SourceAccess }): EntityReader {
  return {
    async read(request) {
      await deps.access.require(request);
      const page = await readThroughGate(deps.gate, request);
      const [item] = page.items;
      if (!isNormalized(item)) throw new AppError('INTERNAL_ERROR');
      // the entity read refuses a row it cannot make a node of, so a page with no node of the type is a read that found no row
      const node = item.nodes.find((candidate) => candidate.ref.entityType === request.entityType);
      if (node === undefined) throw new AppError('NOT_FOUND');
      return node;
    },
  };
}

/** A read the gate refuses answers the same `NOT_FOUND` as a source the person may not read, so the two are never told apart; the gate has already recorded the denial. */
async function readThroughGate(gate: Gate, request: EntityReadRequest) {
  try {
    return await gate.run({
      traceId: request.traceId,
      principal: request.principal,
      sourceId: request.sourceId,
      templateId: ENTITY_LOAD_ID,
      params: { entityType: request.entityType, stableId: request.stableId },
      limit: ONE_ROW,
      mask: request.mask,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
  } catch (error) {
    if (error instanceof AppError && error.code === 'ACCESS_DENIED') throw new AppError('NOT_FOUND');
    throw error;
  }
}

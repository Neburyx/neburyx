import type { GraphNode } from '@neburyx/contracts';
import { AppError } from '../errors.js';
import type { Normalized } from '../gate/normalize/index.js';
import { ENTITY_LOAD_ID } from '../gate/templates/entity-load.js';
import type { Gate } from '../gate/types.js';
import type { MappingModel } from '../mapping/model.js';
import type { Principal } from '../seams/seams.js';

export interface EntityReadRequest {
  readonly traceId: string;
  readonly principal: Principal;
  readonly sourceId: string;
  readonly entityType: string;
  readonly stableId: string;
  readonly mask: boolean;
}

export interface EntityReader {
  read(request: EntityReadRequest): Promise<GraphNode>;
}

const ONE_ROW = 1;

function isNormalized(item: unknown): item is Normalized {
  return typeof item === 'object' && item !== null && 'nodes' in item && Array.isArray(item.nodes);
}

export function createEntityReader(deps: { readonly gate: Gate; readonly mapping: MappingModel }): EntityReader {
  return {
    async read(request) {
      if (!deps.mapping.sources.some((source) => source.id === request.sourceId)) throw new AppError('NOT_FOUND');
      const page = await deps.gate.run({
        traceId: request.traceId,
        principal: request.principal,
        sourceId: request.sourceId,
        templateId: ENTITY_LOAD_ID,
        params: { entityType: request.entityType, stableId: request.stableId },
        limit: ONE_ROW,
        mask: request.mask,
      });
      const [item] = page.items;
      const node = isNormalized(item) ? item.nodes.find((candidate) => candidate.ref.entityType === request.entityType) : undefined;
      if (node === undefined) throw new AppError('NOT_FOUND');
      return node;
    },
  };
}

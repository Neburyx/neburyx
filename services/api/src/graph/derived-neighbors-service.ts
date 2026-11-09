import { DERIVED_NEIGHBOR_CAP, type Count, type DerivedNeighborsResponse, type DerivedNeighborsResult, type GraphEdge, type GraphNode } from '@neburyx/contracts';
import { AppError } from '../errors.js';
import type { EntityReader } from '../entities/entity-reader.js';
import { allowlistFromMapping } from '../gate/allowlist.js';
import { DERIVED_RULE_RUN_ID, derivedRuleRunTemplate } from '../gate/templates/derived-rule-run.js';
import type { Gate, GatePage, GateRequest } from '../gate/types.js';
import type { SourceAccess } from '../investigations/source-access.js';
import type { MappingModel } from '../mapping/model.js';
import type { Principal } from '../seams/seams.js';
import { prunedRunOf } from './derived-prune.js';

export interface DerivedNeighborsServiceRequest {
  readonly traceId: string;
  readonly principal: Principal;
  readonly sourceId: string;
  readonly entityType: string;
  readonly stableId: string;
  readonly mask: boolean;
  readonly signal?: AbortSignal;
}

export interface DerivedNeighborsService {
  derive(request: DerivedNeighborsServiceRequest): Promise<DerivedNeighborsResponse>;
}

const SCOPE = 'derived:neighbors';

interface RunItem {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly warnings: readonly string[];
}

const isRunItem = (item: unknown): item is RunItem => typeof item === 'object' && item !== null && 'nodes' in item && Array.isArray(item.nodes) && 'edges' in item && Array.isArray(item.edges) && 'warnings' in item && Array.isArray(item.warnings);

/** Exact when the run read every other end the rule gives; a lower bound of the ends that remained when it stopped at the cap, so hidden edges dropped after the cap never make the number exact. */
function countOf(derivedEdges: number, cut: boolean): Count {
  return { value: derivedEdges, quality: cut ? 'lowerBound' : 'exact', scope: SCOPE };
}

function resultOf(rule: { readonly id: string; readonly ruleVersion: number }, page: GatePage): DerivedNeighborsResult {
  const [item] = page.items;
  if (!isRunItem(item)) throw new AppError('INTERNAL_ERROR');
  const kept = prunedRunOf(item);
  const derivedEdges = kept.edges.filter((edge) => edge.semantics === 'derived').length;
  return { ruleId: rule.id, ruleVersion: rule.ruleVersion, count: countOf(derivedEdges, page.hasMore), nodes: [...kept.nodes], edges: [...kept.edges], warnings: [...item.warnings] };
}

export function createDerivedNeighborsService(deps: { readonly gate: Gate; readonly mapping: MappingModel; readonly access: SourceAccess; readonly entities: EntityReader }): DerivedNeighborsService {
  const allowlists = new Map(deps.mapping.sources.map((source) => [source.id, allowlistFromMapping(source)]));
  return {
    async derive(request) {
      await deps.access.require({ traceId: request.traceId, principal: request.principal, sourceId: request.sourceId, auditAction: derivedRuleRunTemplate.auditAction, rate: 'count' });
      const source = deps.mapping.sources.find((candidate) => candidate.id === request.sourceId);
      const allowlist = allowlists.get(request.sourceId);
      if (source === undefined || allowlist === undefined || !allowlist.entityLabels.has(request.entityType)) throw new AppError('NOT_FOUND');
      const ref = { sourceId: request.sourceId, entityType: request.entityType, stableId: request.stableId };
      const rules = source.derived.filter((rule) => rule.from === request.entityType);
      // a source that lowered `max_page` said how much one read may return, so the cap is the lower of the two; a raised `max_page` does not raise it
      const limit = Math.min(DERIVED_NEIGHBOR_CAP, source.budgets.maxPage);
      if (rules.length === 0) return { ref, results: [] };
      const gateRequests = rules.map((rule): GateRequest => ({
        traceId: request.traceId,
        principal: request.principal,
        sourceId: request.sourceId,
        templateId: DERIVED_RULE_RUN_ID,
        params: { entityType: request.entityType, stableId: request.stableId, ruleId: rule.id },
        limit,
        mask: request.mask,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      }));
      let pages: readonly GatePage[];
      try {
        pages = await deps.gate.runMany(gateRequests);
      } catch (error) {
        if (error instanceof AppError && error.code === 'ACCESS_DENIED') throw new AppError('NOT_FOUND');
        throw error;
      }
      const results = rules.map((rule, index) => {
        const page = pages[index];
        if (page === undefined) throw new AppError('INTERNAL_ERROR');
        return resultOf(rule, page);
      });
      if (results.every((result) => result.nodes.length === 0)) {
        await deps.entities.read({ traceId: request.traceId, principal: request.principal, sourceId: request.sourceId, entityType: request.entityType, stableId: request.stableId, mask: request.mask, ...(request.signal === undefined ? {} : { signal: request.signal }) });
      }
      return { ref, results };
    },
  };
}

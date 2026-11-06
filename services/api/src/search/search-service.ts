import { SEARCH_GROUP_CAP, type DisabledType, type GraphNode, type SearchResult } from '@neburyx/contracts';
import { AppError } from '../errors.js';
import { onlineFormOf } from '../gate/index-guard.js';
import type { Normalized } from '../gate/normalize/index.js';
import { SEARCH_EXACT_ID, searchExactTemplate, type SearchTarget } from '../gate/templates/search-exact.js';
import type { SourceAccess } from '../investigations/source-access.js';
import type { Gate, GatePage, GateRequest, IndexReader, IndexReadFailure, IndexSnapshot } from '../gate/types.js';
import type { MappingModel, SourceModel } from '../mapping/model.js';
import type { Principal } from '../seams/seams.js';

export interface SearchRequest {
  readonly traceId: string;
  readonly principal: Principal;
  readonly sourceId: string;
  readonly text: string;
  readonly mask: boolean;
}

export interface SearchService {
  search(request: SearchRequest): Promise<SearchResult>;
}

const COUNT_SCOPE = 'search:exact';

function isNormalized(item: unknown): item is Normalized {
  return typeof item === 'object' && item !== null && 'nodes' in item && Array.isArray(item.nodes);
}

/** The `search` properties of each type, except the `pii` ones while the request asks for masking: a masked property is not searched, so a search cannot confirm a hidden value. */
function searchPropertiesOf(source: SourceModel, mask: boolean): { readonly type: string; readonly label: string; readonly properties: readonly string[] }[] {
  return source.entities.flatMap((entity) => {
    const properties = entity.search.filter((property) => !(mask && entity.pii.includes(property)));
    return properties.length === 0 ? [] : [{ type: entity.type, label: entity.label, properties }];
  });
}

/**
 * The indexes of the request, or the failure of the read: the failure is not thrown here but handed to the gate run, which fails with that same error inside its audited stages
 * (after authorization) and makes no data statement, so the one failure is the one the search answers.
 */
async function readOrFail(reader: IndexReader | undefined, request: SearchRequest): Promise<IndexSnapshot | 'unverified' | IndexReadFailure | undefined> {
  try {
    return await reader?.read({ traceId: request.traceId, principal: request.principal, sourceId: request.sourceId });
  } catch (error) {
    if (error instanceof AppError) return { failure: error };
    throw error;
  }
}

/**
 * What is searched: every property of a type whose search indexes are all online, in the form its index serves (`value` for a RANGE index or a constraint, `text` for a TEXT index
 * only); a type with a property that has no online index is left out whole and named. With no snapshot (the login cannot list indexes) every property is searched as a `value`.
 */
function planOf(source: SourceModel, mask: boolean, snapshot: IndexSnapshot | undefined): { readonly targets: readonly SearchTarget[]; readonly disabled: DisabledType[] } {
  const targets: SearchTarget[] = [];
  const disabled: DisabledType[] = [];
  for (const entity of searchPropertiesOf(source, mask)) {
    const forms = entity.properties.map((property) => (snapshot === undefined ? ('value' as const) : onlineFormOf(snapshot, entity.label, property)));
    if (forms.some((form) => form === undefined)) {
      disabled.push({ entityType: entity.type, reason: 'index-unavailable' });
      continue;
    }
    entity.properties.forEach((property, index) => targets.push({ entityType: entity.type, property, match: forms[index] === 'text' ? 'text' : 'value' }));
  }
  return { targets, disabled };
}

/** The hits in the mapping's order of entity types and then by stable ID text, so the same hits are always in the same order. */
function inOrder(source: SourceModel, nodes: readonly GraphNode[]): GraphNode[] {
  const position = new Map(source.entities.map((entity, index) => [entity.type, index]));
  const rank = (node: GraphNode): number => position.get(node.ref.entityType) ?? source.entities.length;
  return [...nodes].sort((first, second) => rank(first) - rank(second) || (first.ref.stableId < second.ref.stableId ? -1 : first.ref.stableId > second.ref.stableId ? 1 : 0));
}

/** A read the gate refuses answers the same `NOT_FOUND` as a source the person may not read, so the two are never told apart; the gate has already recorded the denial. */
async function runSearch(gate: Gate, request: GateRequest): Promise<GatePage> {
  try {
    return await gate.run(request);
  } catch (error) {
    if (error instanceof AppError && error.code === 'ACCESS_DENIED') throw new AppError('NOT_FOUND');
    throw error;
  }
}

export function createSearchService(deps: { readonly gate: Gate; readonly mapping: MappingModel; readonly access: SourceAccess; readonly indexes?: IndexReader; readonly clock?: () => number }): SearchService {
  const clock = deps.clock ?? Date.now;
  return {
    async search(request) {
      await deps.access.require({ traceId: request.traceId, principal: request.principal, sourceId: request.sourceId, auditAction: searchExactTemplate.auditAction });
      const source = deps.mapping.sources.find((candidate) => candidate.id === request.sourceId);
      if (source === undefined) throw new AppError('NOT_FOUND');
      const startedAt = clock();
      // the schema is read once for the request, fresh, when there is a property to search; it is a system read and not the group's one read
      const reader = searchPropertiesOf(source, request.mask).length > 0 ? deps.indexes : undefined;
      const snapshot = await readOrFail(reader, request);
      const { targets, disabled } = planOf(source, request.mask, snapshot === undefined || snapshot === 'unverified' || 'failure' in snapshot ? undefined : snapshot);
      const cap = Math.min(SEARCH_GROUP_CAP, source.budgets.maxPage);
      const page = await runSearch(deps.gate, {
        traceId: request.traceId,
        principal: request.principal,
        sourceId: request.sourceId,
        templateId: SEARCH_EXACT_ID,
        params: { text: request.text, targets },
        limit: cap,
        mask: request.mask,
        ...(snapshot === undefined ? {} : { indexes: snapshot }),
      });
      const [item] = page.items;
      if (!isNormalized(item)) throw new AppError('INTERNAL_ERROR');
      const exact = inOrder(source, item.nodes);
      return {
        sourceId: request.sourceId,
        exact,
        cap,
        searchable: targets.length > 0,
        counts: { exact: { value: exact.length, quality: page.hasMore ? 'lowerBound' : 'exact', scope: COUNT_SCOPE } },
        disabledTypes: disabled,
        dropped: item.dropped,
        warnings: item.warnings,
        elapsedMs: Math.max(0, Math.round(clock() - startedAt)),
      };
    },
  };
}

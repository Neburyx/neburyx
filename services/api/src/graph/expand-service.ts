import type { Count, ExpandFilter, ExpandPage, ExpandRank, ExpandRequest, ExpandResponse, GraphEdge, GraphNode } from '@neburyx/contracts';
import { AppError } from '../errors.js';
import type { EntityReader } from '../entities/entity-reader.js';
import { allowlistFromMapping } from '../gate/allowlist.js';
import { canonicalJson } from '../gate/cursor/binding.js';
import type { ExpansionPage } from '../gate/normalize/expansion.js';
import { EXPAND_COUNT_ID, type ExpandCountItem } from '../gate/templates/expand-count.js';
import { EXPAND_NEIGHBORS_ID, expandNeighborsTemplate } from '../gate/templates/expand-neighbors.js';
import { expandBranchesOf, undeclaredFilter, undeclaredRank, type ExpandDirection } from '../gate/templates/expand-statement.js';
import type { Gate, GatePage, GateRequest, SourceAllowlist } from '../gate/types.js';
import type { SourceAccess } from '../investigations/source-access.js';
import type { MappingModel } from '../mapping/model.js';
import type { Principal } from '../seams/seams.js';

export interface ExpandServiceRequest {
  readonly traceId: string;
  readonly principal: Principal;
  readonly sourceId: string;
  readonly entityType: string;
  readonly stableId: string;
  readonly relTypes?: readonly string[];
  readonly neighborTypes: readonly string[];
  readonly direction: ExpandDirection;
  readonly filters?: readonly ExpandFilter[];
  readonly rank?: ExpandRank;
  readonly limit?: number;
  readonly cursors?: Readonly<Record<string, string>>;
  readonly mask: boolean;
  /** Aborted when the client gives up the request. */
  readonly signal?: AbortSignal;
}

export interface ExpandService {
  expand(request: ExpandServiceRequest): Promise<ExpandResponse>;
}

const SCOPE = 'expand:page';

const isExpansionPage = (item: unknown): item is ExpansionPage =>
  typeof item === 'object' && item !== null && 'anchorFound' in item && typeof item.anchorFound === 'boolean' && 'nodes' in item && Array.isArray(item.nodes) && 'edges' in item && Array.isArray(item.edges) && 'warnings' in item && Array.isArray(item.warnings);

/** What each asked neighbor type reads: the relationship types that apply to it (all of them when the request names none), or nothing when none of those named joins the two types. */
function plansOf(allowlist: SourceAllowlist, request: ExpandServiceRequest): readonly { readonly neighborType: string; readonly relTypes: readonly string[] | undefined; readonly reads: boolean }[] {
  const plans = request.neighborTypes.map((neighborType) => {
    const branches = expandBranchesOf(allowlist, request.entityType, neighborType, undefined, request.direction);
    if (branches.length === 0) throw new AppError('INVALID_REQUEST');
    const joined = new Set(branches.map((branch) => branch.type));
    if (request.relTypes === undefined) return { neighborType, relTypes: undefined, joined };
    const applicable = request.relTypes.filter((type) => joined.has(type));
    return { neighborType, relTypes: applicable, joined };
  });
  if (request.relTypes !== undefined && request.relTypes.some((type) => !plans.some((plan) => plan.joined.has(type)))) throw new AppError('INVALID_REQUEST');
  return plans.map((plan) => ({ neighborType: plan.neighborType, relTypes: plan.relTypes, reads: plan.relTypes === undefined || plan.relTypes.length > 0 }));
}

function totalOf(page: ExpansionPage, first: boolean, hasMore: boolean): Count {
  if (!first || hasMore) return { quality: 'unknown', scope: SCOPE };
  const clean = Object.values(page.dropped).every((count) => count === 0 || count === undefined);
  return { value: page.returned, quality: clean ? 'exact' : 'lowerBound', scope: SCOPE };
}

const COUNT_SCOPE = 'expand:count';

/** The relationships a first page that holds everything stands for, when the count could not be read: one for a stored relationship and the members of an aggregate; a lower bound when a member count or a row is not exact. */
function relationshipsOn(page: ExpansionPage, hasMore: boolean): Count {
  if (hasMore) return { quality: 'unknown', scope: COUNT_SCOPE };
  const clean = Object.values(page.dropped).every((count) => count === 0 || count === undefined) && page.edges.every((edge) => edge.memberCount === undefined || edge.memberCount.quality === 'exact');
  return { value: page.edges.reduce((sum, edge) => sum + (edge.memberCount?.value ?? 1), 0), quality: clean ? 'exact' : 'lowerBound', scope: COUNT_SCOPE };
}

function distinct<T>(values: readonly T[], keyOf: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = keyOf(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function createExpandService(deps: { readonly gate: Gate; readonly mapping: MappingModel; readonly access: SourceAccess; readonly entities: EntityReader }): ExpandService {
  const allowlists = new Map(deps.mapping.sources.map((source) => [source.id, allowlistFromMapping(source)]));
  return {
    async expand(request) {
      await deps.access.require({ traceId: request.traceId, principal: request.principal, sourceId: request.sourceId, auditAction: expandNeighborsTemplate.auditAction, rate: 'count' });
      const source = deps.mapping.sources.find((candidate) => candidate.id === request.sourceId);
      const allowlist = allowlists.get(request.sourceId);
      if (source === undefined || allowlist === undefined || !allowlist.entityLabels.has(request.entityType)) throw new AppError('INVALID_REQUEST');
      if (request.neighborTypes.length === 0 || new Set(request.neighborTypes).size !== request.neighborTypes.length) throw new AppError('INVALID_REQUEST');
      if (request.relTypes !== undefined && new Set(request.relTypes).size !== request.relTypes.length) throw new AppError('INVALID_REQUEST');
      if (Object.keys(request.cursors ?? {}).some((type) => !request.neighborTypes.includes(type))) throw new AppError('INVALID_REQUEST');
      const limit = request.limit ?? source.budgets.defaultPage;
      const plans = plansOf(allowlist, request);
      const reading = plans.filter((plan) => plan.reads);
      // a filter applies to every neighbor type asked, so one type that does not declare its property refuses the request before any of them is read
      if (reading.some((plan) => {
        const branches = expandBranchesOf(allowlist, request.entityType, plan.neighborType, plan.relTypes, request.direction);
        return (request.filters !== undefined && undeclaredFilter(allowlist, plan.neighborType, branches, request.filters) !== undefined) || (request.rank !== undefined && undeclaredRank(allowlist, plan.neighborType, branches, request.rank));
      })) throw new AppError('INVALID_REQUEST');
      const gateRequests = reading.map((plan): GateRequest => {
        const cursor = request.cursors?.[plan.neighborType];
        return {
          traceId: request.traceId,
          principal: request.principal,
          sourceId: request.sourceId,
          templateId: EXPAND_NEIGHBORS_ID,
          params: { entityType: request.entityType, stableId: request.stableId, neighborType: plan.neighborType, ...(plan.relTypes === undefined ? {} : { relTypes: plan.relTypes }), direction: request.direction, sort: 'observed', ...(request.filters === undefined ? {} : { filters: request.filters }), ...(request.rank === undefined ? {} : { rank: request.rank }) },
          limit,
          mask: request.mask,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
          ...(cursor === undefined ? {} : { cursor }),
        };
      });
      let pages: readonly GatePage[];
      try {
        pages = await deps.gate.runMany(gateRequests);
      } catch (error) {
        if (error instanceof AppError && error.code === 'ACCESS_DENIED') throw new AppError('NOT_FOUND');
        throw error;
      }
      const items = pages.map((page) => {
        const [item] = page.items;
        if (!isExpansionPage(item)) throw new AppError('INTERNAL_ERROR');
        return item;
      });
      const anchorFound = items.some((item) => item.anchorFound);
      const anchor: GraphNode[] = anchorFound ? [] : [await deps.entities.read({ traceId: request.traceId, principal: request.principal, sourceId: request.sourceId, entityType: request.entityType, stableId: request.stableId, mask: request.mask, ...(request.signal === undefined ? {} : { signal: request.signal }) })];
      // the count of what a filter matches is a read of its own, after the pages: it is exact or it is `unknown`, and a count that fails never fails a page
      const counted = new Map<string, Count | undefined>();
      const countWarnings: string[] = [];
      if (request.filters !== undefined) {
        // one after another, as the pages are, so that a request holds one read slot at a time and a source is not asked for several counts at once
        for (const plan of reading) {
          if (request.cursors?.[plan.neighborType] !== undefined) continue;
          try {
            const answer = await deps.gate.run({
              traceId: request.traceId,
              principal: request.principal,
              sourceId: request.sourceId,
              templateId: EXPAND_COUNT_ID,
              params: { entityType: request.entityType, stableId: request.stableId, neighborType: plan.neighborType, ...(plan.relTypes === undefined ? {} : { relTypes: plan.relTypes }), direction: request.direction, filters: request.filters },
              limit: 1,
              mask: request.mask,
              ...(request.signal === undefined ? {} : { signal: request.signal }),
            });
            const total = (answer.items[0] as Partial<ExpandCountItem> | undefined)?.total;
            if (typeof total !== 'number') throw new AppError('INTERNAL_ERROR');
            counted.set(plan.neighborType, { value: total, quality: 'exact', scope: COUNT_SCOPE });
          } catch (error) {
            // a cancel is not an AppError and ends the request; a refusal or a failure of the count read leaves the page as it is, told in a warning
            if (!(error instanceof AppError)) throw error;
            countWarnings.push(`The relationships to ${plan.neighborType} that match the filters could not be counted.`);
          }
        }
      }
      const byType = new Map(reading.map((plan, index) => [plan.neighborType, { item: items[index], page: pages[index] }] as const));
      const expandPages: ExpandPage[] = plans.map((plan) => {
        const read = byType.get(plan.neighborType);
        const item = read?.item;
        const page = read?.page;
        if (item === undefined || page === undefined) return { neighborType: plan.neighborType, returned: 0, hasMore: false, matchingTotal: { value: 0, quality: 'exact', scope: SCOPE } };
        // a page that says there is more and gives no way to ask for it is never shown as the end
        if (page.hasMore && page.nextCursor === undefined) throw new AppError('INTERNAL_ERROR');
        const hasMore = page.hasMore;
        return { neighborType: plan.neighborType, returned: item.returned, hasMore, matchingTotal: request.filters !== undefined && request.cursors?.[plan.neighborType] === undefined ? (counted.get(plan.neighborType) ?? relationshipsOn(item, hasMore)) : totalOf(item, request.cursors?.[plan.neighborType] === undefined, hasMore), ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }) };
      });
      const nodes = distinct([...anchor, ...items.flatMap((item) => item.nodes)], (node) => canonicalJson(node.ref));
      const edges = distinct<GraphEdge>(items.flatMap((item) => item.edges), (edge) => canonicalJson(edge.ref));
      const warnings = [...new Set([...items.flatMap((item) => item.warnings), ...countWarnings])];
      return { ref: { sourceId: request.sourceId, entityType: request.entityType, stableId: request.stableId }, pageSize: limit, nodes, edges, pages: expandPages, warnings } satisfies ExpandResponse;
    },
  };
}

export type { ExpandRequest };

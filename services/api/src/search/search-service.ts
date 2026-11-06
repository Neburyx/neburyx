import { SEARCH_GROUP_CAP, SEARCH_GROUP_FAILURE_CODES, type DisabledType, type GraphNode, type GroupFailure, type SearchGroup, type SearchResult } from '@neburyx/contracts';
import { AppError, detailsOf } from '../errors.js';
import { onlineFormOf } from '../gate/index-guard.js';
import type { Normalized } from '../gate/normalize/index.js';
import { SEARCH_EXACT_ID, searchExactTemplate, type SearchTarget } from '../gate/templates/search-exact.js';
import { SEARCH_PREFIX_ID } from '../gate/templates/search-prefix.js';
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
  /** Adds the `startsWith` group: a second read through the gate that shares the one schema read. */
  readonly typeahead?: boolean;
}

export interface SearchService {
  search(request: SearchRequest): Promise<SearchResult>;
}

const COUNT_SCOPE = 'search:exact';
const STARTS_WITH_COUNT_SCOPE = 'search:startsWith';
const NOTHING_DROPPED = { 'not-mapped': 0, 'ambiguous-type': 0, 'no-stable-id': 0 } as const;

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

/** What one group's read gave: its hits in order, how many there are, and what the normalize stage left out. */
interface GroupResult {
  readonly nodes: GraphNode[];
  readonly count: SearchResult['counts']['exact'];
  readonly dropped: SearchResult['dropped'];
  readonly warnings: string[];
}

interface Reading {
  readonly request: SearchRequest;
  readonly gate: Gate;
  readonly source: SourceModel;
  readonly targets: readonly SearchTarget[];
  readonly cap: number;
  readonly snapshot: IndexSnapshot | 'unverified' | IndexReadFailure | undefined;
}

function readOf(reading: Reading, templateId: string, targets: readonly object[]): Promise<GatePage> {
  const { request, snapshot } = reading;
  return runSearch(reading.gate, {
    traceId: request.traceId,
    principal: request.principal,
    sourceId: request.sourceId,
    templateId,
    params: { text: request.text, targets },
    limit: reading.cap,
    mask: request.mask,
    ...(snapshot === undefined ? {} : { indexes: snapshot }),
  });
}

function resultOf(page: GatePage, source: SourceModel, scope: string, without: ReadonlySet<string>): GroupResult {
  const [item] = page.items;
  if (!isNormalized(item)) throw new AppError('INTERNAL_ERROR');
  const nodes = inOrder(source, item.nodes).filter((node) => !without.has(JSON.stringify([node.ref.entityType, node.ref.stableId])));
  return { nodes, count: { value: nodes.length, quality: page.hasMore ? 'lowerBound' : 'exact', scope }, dropped: item.dropped, warnings: item.warnings };
}

async function exactOf(reading: Reading): Promise<GroupResult> {
  return resultOf(await readOf(reading, SEARCH_EXACT_ID, reading.targets), reading.source, COUNT_SCOPE, new Set());
}

/** The prefix read for the same targets: nothing is read when no target is left, and a hit the exact group already holds is not repeated. */
async function startsWithOf(reading: Reading, exact: readonly GraphNode[]): Promise<GroupResult> {
  if (reading.targets.length === 0) return { nodes: [], count: { value: 0, quality: 'exact', scope: STARTS_WITH_COUNT_SCOPE }, dropped: { ...NOTHING_DROPPED }, warnings: [] };
  const page = await readOf(reading, SEARCH_PREFIX_ID, reading.targets.map((target) => ({ ...target, match: 'value' as const })));
  return resultOf(page, reading.source, STARTS_WITH_COUNT_SCOPE, new Set(exact.map((node) => JSON.stringify([node.ref.entityType, node.ref.stableId]))));
}

type Settled = { readonly group: GroupResult } | { readonly error: unknown };

async function settled(work: () => Promise<GroupResult>): Promise<Settled> {
  try {
    return { group: await work() };
  } catch (error) {
    return { error };
  }
}

const isGroupFailureCode = (code: string): code is GroupFailure['code'] => SEARCH_GROUP_FAILURE_CODES.some((candidate) => candidate === code);

/** A failure that belongs to one group (a timeout, a busy or rate-limited source, an internal error of the read); every other failure means the same for both groups and fails the search. */
function groupFailureOf(group: SearchGroup, error: unknown): GroupFailure | undefined {
  if (!(error instanceof AppError) || !isGroupFailureCode(error.code)) return undefined;
  const details = detailsOf(error);
  const timeoutMs = typeof details === 'object' && details !== null && 'timeoutMs' in details && typeof details.timeoutMs === 'number' && Number.isInteger(details.timeoutMs) && details.timeoutMs > 0 ? details.timeoutMs : undefined;
  return { group, code: error.code, ...(timeoutMs === undefined ? {} : { timeoutMs }) };
}

const unreadGroup = (scope: string): GroupResult => ({ nodes: [], count: { quality: 'unknown', scope }, dropped: { ...NOTHING_DROPPED }, warnings: [] });

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
      const reading: Reading = { request, gate: deps.gate, source, targets, cap: Math.min(SEARCH_GROUP_CAP, source.budgets.maxPage), snapshot };
      const exactRun = await settled(() => exactOf(reading));
      const schemaFailed = snapshot !== undefined && snapshot !== 'unverified' && 'failure' in snapshot;
      if ('error' in exactRun && (schemaFailed || groupFailureOf('exact', exactRun.error) === undefined)) throw exactRun.error;
      const prefixRun = request.typeahead === true ? await settled(() => startsWithOf(reading, 'group' in exactRun ? exactRun.group.nodes : [])) : undefined;
      if (prefixRun !== undefined && 'error' in prefixRun && groupFailureOf('startsWith', prefixRun.error) === undefined) throw prefixRun.error;
      if ('error' in exactRun && (prefixRun === undefined || 'error' in prefixRun)) throw exactRun.error;
      const exact = 'group' in exactRun ? exactRun.group : unreadGroup(COUNT_SCOPE);
      const startsWith = prefixRun === undefined ? undefined : 'group' in prefixRun ? prefixRun.group : unreadGroup(STARTS_WITH_COUNT_SCOPE);
      const failures = [...('error' in exactRun ? [groupFailureOf('exact', exactRun.error)] : []), ...(prefixRun !== undefined && 'error' in prefixRun ? [groupFailureOf('startsWith', prefixRun.error)] : [])].filter((failure): failure is GroupFailure => failure !== undefined);
      return {
        sourceId: request.sourceId,
        exact: exact.nodes,
        cap: reading.cap,
        searchable: targets.length > 0,
        counts: { exact: exact.count },
        disabledTypes: disabled,
        failures,
        dropped: exact.dropped,
        warnings: exact.warnings,
        elapsedMs: Math.max(0, Math.round(clock() - startedAt)),
        ...(startsWith === undefined ? {} : { startsWith }),
      };
    },
  };
}

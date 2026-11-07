import { evidenceHitsOf, evidenceRowsOf, planEvidence } from './evidence-group.js';
import { SEARCH_GROUP_CAP, SEARCH_GROUP_FAILURE_CODES, type DisabledType, type ErrorCode, type GraphNode, type GroupFailure, type SearchGroup, type SearchResult, type StartsWithGroup } from '@neburyx/contracts';
import { AppError } from '../errors.js';
import { onlineFormOf } from '../gate/index-guard.js';
import { matchedPropertiesOf } from './matched-properties.js';
import { DROP_REASONS, warningsOf, type Dropped } from '../gate/normalize/drops.js';
import type { Normalized } from '../gate/normalize/index.js';
import { SEARCH_EXACT_ID, searchExactTemplate, type SearchTarget } from '../gate/templates/search-exact.js';
import { SEARCH_EVIDENCE_ID } from '../gate/templates/search-evidence.js';
import { SEARCH_PREFIX_ID } from '../gate/templates/search-prefix.js';
import { SEARCH_RELATED_ID } from '../gate/templates/search-related.js';
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
  /** Adds the `startsWith` group: a third read through the gate that shares the one schema read. */
  readonly typeahead?: boolean;
}

export interface SearchService {
  search(request: SearchRequest): Promise<SearchResult>;
}

const EXACT_SCOPE = 'search:exact';
const RELATED_SCOPE = 'search:related';
const EVIDENCE_SCOPE = 'search:evidence';
const STARTS_WITH_SCOPE = 'search:startsWith';

type Group = 'exact' | 'related';

function isNormalized(item: unknown): item is Normalized {
  return typeof item === 'object' && item !== null && 'nodes' in item && Array.isArray(item.nodes);
}

interface Candidate {
  readonly type: string;
  readonly label: string;
  readonly properties: readonly string[];
}

/** The `search` or `reference` properties of each type, except the `pii` ones while the request asks for masking: a masked property is not searched, so a search cannot confirm a hidden value. */
function candidatesOf(source: SourceModel, group: Group, mask: boolean): Candidate[] {
  return source.entities.flatMap((entity) => {
    const properties = (group === 'exact' ? entity.search : entity.reference).filter((property) => !(mask && entity.pii.includes(property)));
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
 * What is searched: every property of a type whose indexes are all online, in the form its index serves (`value` for a RANGE index or a constraint, `text` for a TEXT index
 * only); a type with a property that has no online index is left out whole and named. With no snapshot (the login cannot list indexes) every property is searched as a `value`.
 */
function planOf(candidates: readonly Candidate[], snapshot: IndexSnapshot | undefined): { readonly targets: readonly SearchTarget[]; readonly disabled: DisabledType[] } {
  const targets: SearchTarget[] = [];
  const disabled: DisabledType[] = [];
  for (const entity of candidates) {
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

/** The rows left out by the runs that returned a page, by reason, added up; a run that made no read, or failed, adds nothing. */
function droppedOf(results: readonly Normalized[]): Dropped {
  const total: Dropped = { 'not-mapped': 0, 'ambiguous-type': 0, 'no-stable-id': 0 };
  for (const result of results) {
    for (const reason of DROP_REASONS) total[reason] += result.dropped[reason];
    const hidden = result.dropped['not-visible'];
    if (hidden !== undefined) total['not-visible'] = (total['not-visible'] ?? 0) + hidden;
  }
  return total;
}

interface GroupOutcome {
  readonly group: SearchGroup;
  /** False for a group with no target, whose run (if any) reads nothing. */
  readonly read: boolean;
  readonly outcome: PromiseSettledResult<GatePage | undefined>;
}

const isGroupFailureCode = (code: ErrorCode): code is GroupFailure['code'] => SEARCH_GROUP_FAILURE_CODES.some((candidate) => candidate === code);

function failureOf(group: SearchGroup, error: unknown): GroupFailure | undefined {
  if (!(error instanceof AppError) || !isGroupFailureCode(error.code)) return undefined;
  const timeoutMs = error.code === 'QUERY_TIMEOUT' ? timeoutOf(error.details) : undefined;
  return { group, code: error.code, ...(timeoutMs === undefined ? {} : { timeoutMs }) };
}

/**
 * The groups whose read failed while another group's was answered. A failure that means the same for every group (an unusable or unreadable source, a bad request) fails the whole search,
 * whichever group's read it came from and whatever the other reads gave; so does the failure of every group that was read, with the error of the first of the exact, related and evidence
 * groups that was read when more than one failed.
 */
function failuresOf(groups: readonly GroupOutcome[]): GroupFailure[] {
  const rejected = groups.flatMap((entry): { readonly group: SearchGroup; readonly read: boolean; readonly error: unknown }[] => {
    if (entry.outcome.status !== 'rejected') return [];
    const error: unknown = entry.outcome.reason;
    return [{ group: entry.group, read: entry.read, error }];
  });
  const exactRun = groups.find((entry) => entry.group === 'exact');
  if (exactRun?.outcome.status === 'rejected' && !exactRun.read) throw exactRun.outcome.reason;
  const reads = groups.filter((entry) => entry.read);
  const failedReads = rejected.filter((entry) => entry.read);
  const wholeSearch = failedReads.find((entry) => failureOf(entry.group, entry.error) === undefined);
  if (wholeSearch !== undefined) throw wholeSearch.error;
  const first = failedReads[0];
  if (first !== undefined && failedReads.length === reads.length) throw first.error;
  return failedReads.flatMap((entry) => failureOf(entry.group, entry.error) ?? []);
}

function countOf(held: number, page: GatePage | undefined, scope: string, failed: boolean): SearchResult['counts']['exact'] {
  if (failed) return { quality: 'unknown', scope };
  return { value: held, quality: page?.hasMore === true ? 'lowerBound' : 'exact', scope };
}

function timeoutOf(details: unknown): number | undefined {
  if (typeof details !== 'object' || details === null || !('timeoutMs' in details)) return undefined;
  return typeof details.timeoutMs === 'number' && Number.isInteger(details.timeoutMs) && details.timeoutMs > 0 ? details.timeoutMs : undefined;
}

function normalizedOf(page: GatePage): Normalized {
  const [item] = page.items;
  if (!isNormalized(item)) throw new AppError('INTERNAL_ERROR');
  return item;
}

const entityKey = (node: GraphNode): string => JSON.stringify([node.ref.entityType, node.ref.stableId]);

/** The `startsWith` group: the prefix hits in order, without those the exact group already holds; empty with an unknown count when its read failed, and empty and exact when nothing was read. */
function startsWithOf(source: SourceModel, item: Normalized | undefined, page: GatePage | undefined, exact: readonly GraphNode[], failed: boolean): StartsWithGroup {
  const held = new Set(exact.map(entityKey));
  const nodes = item === undefined ? [] : inOrder(source, item.nodes).filter((node) => !held.has(entityKey(node)));
  const dropped: Dropped = item === undefined ? { 'not-mapped': 0, 'ambiguous-type': 0, 'no-stable-id': 0 } : droppedOf([item]);
  return { nodes, count: countOf(nodes.length, page, STARTS_WITH_SCOPE, failed), dropped, warnings: item === undefined ? [] : item.warnings };
}

export function createSearchService(deps: { readonly gate: Gate; readonly mapping: MappingModel; readonly access: SourceAccess; readonly indexes?: IndexReader; readonly clock?: () => number }): SearchService {
  const clock = deps.clock ?? Date.now;
  return {
    async search(request) {
      await deps.access.require({ traceId: request.traceId, principal: request.principal, sourceId: request.sourceId, auditAction: searchExactTemplate.auditAction });
      const source = deps.mapping.sources.find((candidate) => candidate.id === request.sourceId);
      if (source === undefined) throw new AppError('NOT_FOUND');
      const startedAt = clock();
      const exactCandidates = candidatesOf(source, 'exact', request.mask);
      // the related group belongs to the Search results page: a type-ahead request does not read it
      const relatedCandidates = request.typeahead === true ? [] : candidatesOf(source, 'related', request.mask);
      // the schema is read once for the request, fresh, when there is a property to search; it is a system read and not a group's read
      const typeahead = request.typeahead === true;
      const reader = exactCandidates.length + relatedCandidates.length + (typeahead ? 0 : evidenceRowsOf(source)) > 0 ? deps.indexes : undefined;
      const snapshot = await readOrFail(reader, request);
      const planSnapshot = snapshot === undefined || snapshot === 'unverified' || 'failure' in snapshot ? undefined : snapshot;
      const exactPlan = planOf(exactCandidates, planSnapshot);
      const relatedPlan = planOf(relatedCandidates, planSnapshot);
      // the evidence group belongs to the Search results page too: a type-ahead request does not read it
      const evidencePlan = typeahead ? { targets: [], disabled: [] } : planEvidence(source, planSnapshot);
      const cap = Math.min(SEARCH_GROUP_CAP, source.budgets.maxPage);
      const run = (templateId: string, targets: readonly object[]): Promise<GatePage> =>
        runSearch(deps.gate, {
          traceId: request.traceId,
          principal: request.principal,
          sourceId: request.sourceId,
          templateId,
          params: { text: request.text, targets },
          limit: cap,
          mask: request.mask,
          ...(snapshot === undefined ? {} : { indexes: snapshot }),
        });
      const none = Promise.resolve(undefined);
      // the exact group is read first: a failure that means the same for every group (the schema read, an unusable or refused source, a bad request) stops the search before another group is read
      const [exactOutcome] = await Promise.allSettled([run(SEARCH_EXACT_ID, exactPlan.targets)]);
      const schemaFailed = snapshot !== undefined && snapshot !== 'unverified' && 'failure' in snapshot;
      if (exactOutcome.status === 'rejected' && (schemaFailed || failureOf('exact', exactOutcome.reason) === undefined)) throw exactOutcome.reason;
      // the groups read after the exact one settle together before the answer, so no read is left running when it is sent: the related and the evidence group, or for a type-ahead request the startsWith group alone, read for the exact group's targets as a value
      const withStartsWith = typeahead;
      const startsWithRead = withStartsWith && exactPlan.targets.length > 0;
      const [relatedOutcome, evidenceOutcome, startsWithOutcome] = await Promise.allSettled([
        relatedPlan.targets.length === 0 ? none : run(SEARCH_RELATED_ID, relatedPlan.targets),
        evidencePlan.targets.length === 0 ? none : run(SEARCH_EVIDENCE_ID, evidencePlan.targets),
        startsWithRead ? run(SEARCH_PREFIX_ID, exactPlan.targets.map((target) => ({ ...target, match: 'value' as const }))) : none,
      ]);
      const failures = failuresOf([
        { group: 'exact', read: exactPlan.targets.length > 0, outcome: exactOutcome },
        { group: 'related', read: relatedPlan.targets.length > 0, outcome: relatedOutcome },
        { group: 'evidence', read: evidencePlan.targets.length > 0, outcome: evidenceOutcome },
        ...(withStartsWith ? [{ group: 'startsWith' as const, read: startsWithRead, outcome: startsWithOutcome }] : []),
      ]);
      const failed = new Set(failures.map((failure) => failure.group));
      const exactPage = exactOutcome.status === 'fulfilled' ? exactOutcome.value : undefined;
      const relatedPage = relatedOutcome.status === 'fulfilled' ? relatedOutcome.value : undefined;
      const evidencePage = evidenceOutcome.status === 'fulfilled' ? evidenceOutcome.value : undefined;
      const startsWithPage = startsWithOutcome.status === 'fulfilled' ? startsWithOutcome.value : undefined;
      const exactItem = exactPage === undefined ? undefined : normalizedOf(exactPage);
      const relatedItem = relatedPage === undefined ? undefined : normalizedOf(relatedPage);
      const evidenceItem = evidencePage === undefined ? undefined : normalizedOf(evidencePage);
      const startsWithItem = startsWithPage === undefined ? undefined : normalizedOf(startsWithPage);
      const exact = exactItem === undefined ? [] : inOrder(source, exactItem.nodes);
      const related = relatedItem === undefined ? [] : inOrder(source, relatedItem.nodes);
      const evidence = evidenceItem === undefined ? [] : evidenceHitsOf(source, evidenceItem.edges);
      const dropped = droppedOf([exactItem, relatedItem, evidenceItem].filter((item) => item !== undefined));
      return {
        sourceId: request.sourceId,
        exact,
        cap,
        searchable: exactPlan.targets.length > 0,
        counts: { exact: countOf(exact.length, exactPage, EXACT_SCOPE, failed.has('exact')) },
        disabledTypes: exactPlan.disabled,
        related: {
          hits: related.map((node) => ({ node, matchedProperties: matchedPropertiesOf(node, relatedPlan.targets, request.text) })),
          count: countOf(related.length, relatedPage, RELATED_SCOPE, failed.has('related')),
          searchable: relatedPlan.targets.length > 0,
          disabledTypes: relatedPlan.disabled,
        },
        evidence: {
          hits: evidence,
          count: countOf(evidence.length, evidencePage, EVIDENCE_SCOPE, failed.has('evidence')),
          searchable: evidencePlan.targets.length > 0,
          disabledRelationshipTypes: evidencePlan.disabled,
        },
        failures,
        dropped,
        warnings: warningsOf(dropped),
        elapsedMs: Math.max(0, Math.round(clock() - startedAt)),
        ...(withStartsWith ? { startsWith: startsWithOf(source, startsWithItem, startsWithPage, exact, failed.has('startsWith')) } : {}),
      };
    },
  };
}

import { evidenceHitsOf, evidenceRowsOf, planEvidence } from './evidence-group.js';
import { FAILED_FACETS, facetsOf, planFacets } from './facets-group.js';
import { SEARCH_GROUP_CAP, SEARCH_GROUP_FAILURE_CODES, SEARCH_MATCH_MODES, type DisabledType, type ErrorCode, type Facets, type GraphNode, type GroupFailure, type SearchFailureGroup, type SearchGroup, type SearchMatchMode, type SearchResult, type StartsWithGroup } from '@neburyx/contracts';
import { AppError } from '../errors.js';
import { onlineFormOf } from '../gate/index-guard.js';
import { matchedPropertiesOf } from './matched-properties.js';
import { DROP_REASONS, warningsOf, type Dropped } from '../gate/normalize/drops.js';
import type { Normalized } from '../gate/normalize/index.js';
import { SEARCH_EXACT_ID, searchExactTemplate, type SearchTarget } from '../gate/templates/search-exact.js';
import { SEARCH_EVIDENCE_ID } from '../gate/templates/search-evidence.js';
import { SEARCH_FACETS_ID } from '../gate/templates/search-facets.js';
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
  /** Narrows the exact and related groups to these entity types of the mapping (OR); absent means all. */
  readonly entityTypes?: readonly string[];
  /** Narrows the search to the groups of these match modes (OR); a group that is not chosen is not read; absent means all. */
  readonly matchModes?: readonly SearchMatchMode[];
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

function failureOf(group: SearchFailureGroup, error: unknown): GroupFailure | undefined {
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
      // the selection is names of the mapping, checked before any read and put in the order of the mapping and of the modes; absent means all
      const typeahead = request.typeahead === true;
      if (typeahead && (request.entityTypes !== undefined || request.matchModes !== undefined)) throw new AppError('INVALID_REQUEST');
      if ((request.entityTypes ?? []).some((type) => !source.entities.some((entity) => entity.type === type))) throw new AppError('INVALID_REQUEST');
      const types = source.entities.map((entity) => entity.type).filter((type) => request.entityTypes?.includes(type) === true);
      const modes = SEARCH_MATCH_MODES.filter((mode) => request.matchModes?.includes(mode) === true);
      const modeOn = (mode: SearchMatchMode): boolean => modes.length === 0 || modes.includes(mode);
      const typeOn = (type: string): boolean => types.length === 0 || types.includes(type);
      const exactCandidates = candidatesOf(source, 'exact', request.mask);
      // the related group belongs to the Search results page: a type-ahead request does not read it
      const relatedCandidates = request.typeahead === true ? [] : candidatesOf(source, 'related', request.mask);
      // the schema is read once for the request, fresh, when there is a property to search; it is a system read and not a group's read
      const reader = exactCandidates.length + relatedCandidates.length + (typeahead ? 0 : evidenceRowsOf(source)) > 0 ? deps.indexes : undefined;
      const snapshot = await readOrFail(reader, request);
      const planSnapshot = snapshot === undefined || snapshot === 'unverified' || 'failure' in snapshot ? undefined : snapshot;
      const exactPlan = planOf(exactCandidates, planSnapshot);
      const relatedPlan = planOf(relatedCandidates, planSnapshot);
      // the evidence group belongs to the Search results page too: a type-ahead request does not read it
      const evidencePlan = typeahead ? { targets: [], disabled: [] } : planEvidence(source, planSnapshot);
      // the groups read are narrowed by the selection; the facets are planned from the plans above, which the selection does not touch
      const exactTargets = modeOn('exact') ? exactPlan.targets.filter((target) => typeOn(target.entityType)) : [];
      const relatedTargets = modeOn('related') ? relatedPlan.targets.filter((target) => typeOn(target.entityType)) : [];
      const evidenceTargets = modeOn('evidence') ? evidencePlan.targets : [];
      const cap = Math.min(SEARCH_GROUP_CAP, source.budgets.maxPage);
      const runWith = (templateId: string, params: object): Promise<GatePage> =>
        runSearch(deps.gate, {
          traceId: request.traceId,
          principal: request.principal,
          sourceId: request.sourceId,
          templateId,
          params,
          limit: cap,
          mask: request.mask,
          ...(snapshot === undefined ? {} : { indexes: snapshot }),
        });
      const run = (templateId: string, targets: readonly object[]): Promise<GatePage> => runWith(templateId, { text: request.text, targets });
      const facetPlan = typeahead ? undefined : planFacets(source, exactPlan.targets, relatedPlan.targets, evidencePlan.targets);
      const none = Promise.resolve(undefined);
      // the first read is the exact group when it is chosen (it goes through the gate even with no target), else the first chosen group that has a target: a failure that means the same for every group
      // (the schema read, an unusable or refused source, a bad request) stops the search before another group is read
      const first: 'exact' | 'related' | 'evidence' | undefined = modeOn('exact') ? 'exact' : relatedTargets.length > 0 ? 'related' : evidenceTargets.length > 0 ? 'evidence' : undefined;
      const start = (group: 'exact' | 'related' | 'evidence'): Promise<GatePage | undefined> => {
        if (group === 'exact') return modeOn('exact') ? run(SEARCH_EXACT_ID, exactTargets) : none;
        if (group === 'related') return relatedTargets.length === 0 ? none : run(SEARCH_RELATED_ID, relatedTargets);
        return evidenceTargets.length === 0 ? none : run(SEARCH_EVIDENCE_ID, evidenceTargets);
      };
      const outcomes: Record<'exact' | 'related' | 'evidence', PromiseSettledResult<GatePage | undefined>> = { exact: { status: 'fulfilled', value: undefined }, related: { status: 'fulfilled', value: undefined }, evidence: { status: 'fulfilled', value: undefined } };
      const schemaFailed = snapshot !== undefined && snapshot !== 'unverified' && 'failure' in snapshot;
      if (first !== undefined) {
        const [firstOutcome] = await Promise.allSettled([start(first)]);
        outcomes[first] = firstOutcome;
        if (firstOutcome.status === 'rejected' && (schemaFailed || failureOf(first, firstOutcome.reason) === undefined)) throw firstOutcome.reason;
      }
      // the groups read after the first settle together before the answer, so no read is left running when it is sent: the other chosen groups and the facet read, or for a type-ahead request the startsWith group alone, read for the exact group's targets
      const withStartsWith = typeahead;
      const startsWithRead = withStartsWith && exactTargets.length > 0;
      const rest = (['exact', 'related', 'evidence'] as const).filter((group) => group !== first);
      const settled = await Promise.allSettled([
        ...rest.map(start),
        startsWithRead ? run(SEARCH_PREFIX_ID, exactTargets.map((target) => ({ ...target, match: 'value' as const }))) : none,
        facetPlan === undefined || facetPlan.probes.length === 0 ? none : runWith(SEARCH_FACETS_ID, { text: request.text, probes: facetPlan.probes }),
      ]);
      rest.forEach((group, index) => {
        const outcome = settled[index];
        if (outcome !== undefined) outcomes[group] = outcome;
      });
      const startsWithOutcome = settled[rest.length];
      const facetsOutcome = settled[rest.length + 1];
      if (startsWithOutcome === undefined || facetsOutcome === undefined) throw new AppError('INTERNAL_ERROR');
      // a schema read that failed is the failure of every read that follows it, whichever read it reaches the answer through: the search fails with it even when no group had a first read to carry it
      if (schemaFailed) {
        const rejection = [...rest.map((group) => outcomes[group]), startsWithOutcome, facetsOutcome].find((outcome) => outcome.status === 'rejected');
        if (rejection?.status === 'rejected') throw rejection.reason;
      }
      const { exact: exactOutcome, related: relatedOutcome, evidence: evidenceOutcome } = outcomes;
      const failures = failuresOf([
        { group: 'exact', read: exactTargets.length > 0, outcome: exactOutcome },
        { group: 'related', read: relatedTargets.length > 0, outcome: relatedOutcome },
        { group: 'evidence', read: evidenceTargets.length > 0, outcome: evidenceOutcome },
        ...(withStartsWith ? [{ group: 'startsWith' as const, read: startsWithRead, outcome: startsWithOutcome }] : []),
      ]);
      // the facet read is not a result group: its failure with a code of its own is named and keeps every group, a failure that means the same for every read fails the search, and it is never counted among the groups that failed
      const facetsRead = facetPlan !== undefined && facetPlan.probes.length > 0;
      let facetsFailure = facetsOutcome.status === 'rejected' ? failureOf('facets', facetsOutcome.reason) : undefined;
      if (facetsOutcome.status === 'rejected' && facetsFailure === undefined) throw facetsOutcome.reason;
      let facets: Facets | undefined;
      if (facetPlan !== undefined) {
        facets = FAILED_FACETS;
        if (facetsFailure === undefined) {
          try {
            facets = facetsOf(facetPlan, facetsOutcome.status === 'fulfilled' ? facetsOutcome.value : undefined, cap);
          } catch (error) {
            // an answer of the read that cannot be read is a failure of that read and of nothing else
            if (!(error instanceof AppError) || error.code !== 'INTERNAL_ERROR') throw error;
            facetsFailure = { group: 'facets', code: 'INTERNAL_ERROR' };
          }
        }
      }
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
        searchable: exactTargets.length > 0,
        counts: { exact: countOf(exact.length, exactPage, EXACT_SCOPE, failed.has('exact')) },
        disabledTypes: modeOn('exact') ? exactPlan.disabled.filter((entry) => typeOn(entry.entityType)) : [],
        related: {
          hits: related.map((node) => ({ node, matchedProperties: matchedPropertiesOf(node, relatedTargets, request.text) })),
          count: countOf(related.length, relatedPage, RELATED_SCOPE, failed.has('related')),
          searchable: relatedTargets.length > 0,
          disabledTypes: modeOn('related') ? relatedPlan.disabled.filter((entry) => typeOn(entry.entityType)) : [],
        },
        evidence: {
          hits: evidence,
          count: countOf(evidence.length, evidencePage, EVIDENCE_SCOPE, failed.has('evidence')),
          searchable: evidenceTargets.length > 0,
          disabledRelationshipTypes: modeOn('evidence') ? evidencePlan.disabled : [],
        },
        failures: facetsFailure === undefined || !facetsRead ? failures : [...failures, facetsFailure],
        dropped,
        warnings: warningsOf(dropped),
        elapsedMs: Math.max(0, Math.round(clock() - startedAt)),
        ...(withStartsWith ? { startsWith: startsWithOf(source, startsWithItem, startsWithPage, exact, failed.has('startsWith')) } : {}),
        ...(facets === undefined ? {} : { facets, filters: { entityTypes: types, matchModes: [...modes] } }),
      };
    },
  };
}

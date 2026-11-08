import { contextParamsOf, contextsOf, contextWillRead, planContext, type ContextPlan } from './context-group.js';
import { evidenceHitsOf, evidenceRowsOf, planEvidence } from './evidence-group.js';
import { FAILED_FACETS, facetsOf, planFacets } from './facets-group.js';
import { SEARCH_GROUP_CAP, SEARCH_GROUP_FAILURE_CODES, SEARCH_MATCH_MODES, SEARCH_PAGED_GROUPS, type DisabledType, type ErrorCode, type Facets, type GraphNode, type GroupFailure, type RelationshipContext, type SearchFailureGroup, type SearchGroup, type SearchMatchMode, type SearchMoreResult, type SearchPagedGroup, type SearchResult, type StartsWithGroup, type UnreferencedHit, relationshipsOf } from '@neburyx/contracts';
import { AppError, RequestCancelled } from '../errors.js';
import { exhaustive } from '../gate/exhaustive.js';
import { propertyIndexOf } from '../gate/index-guard.js';
import { matchedPropertiesOf } from './matched-properties.js';
import { DROP_REASONS, warningsOf, type Dropped } from '../gate/normalize/drops.js';
import { isNormalizedEvidence, type Normalized, type RelationshipEvidence } from '../gate/normalize/index.js';
import { SEARCH_EXACT_ID, searchExactTemplate, type SearchTarget } from '../gate/templates/search-exact.js';
import { SEARCH_EVIDENCE_ID, type EvidenceTarget } from '../gate/templates/search-evidence.js';
import { SEARCH_FACETS_ID } from '../gate/templates/search-facets.js';
import { SEARCH_PREFIX_ID } from '../gate/templates/search-prefix.js';
import { SEARCH_RELATED_ID } from '../gate/templates/search-related.js';
import { RELATED_CONTEXT_ID } from '../gate/templates/related-context.js';
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
  /** Aborted when the client gives up the request. */
  readonly signal?: AbortSignal;
}

/** The next page of one group of a search, from the cursor that group's last page gave; the text, the mask and the entity types are those of that search. */
export interface SearchMoreRequest {
  readonly traceId: string;
  readonly principal: Principal;
  readonly sourceId: string;
  readonly text: string;
  readonly mask: boolean;
  readonly group: SearchGroup;
  readonly cursor: string;
  readonly entityTypes?: readonly string[];
  /** For the `related` group only: the references of the exact matches the person holds, at most the cap, so the page's records can show how they are related to them; the server checks that they are references of the source, not that they are exact matches of this search. */
  readonly exactRefs?: readonly GraphNode['ref'][];
  /** Aborted when the client gives up the request. */
  readonly signal?: AbortSignal;
}

export interface SearchService {
  search(request: SearchRequest): Promise<SearchResult>;
  more(request: SearchMoreRequest): Promise<SearchMoreResult>;
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
async function readOrFail(reader: IndexReader | undefined, request: Pick<SearchRequest, 'traceId' | 'principal' | 'sourceId' | 'signal'>): Promise<IndexSnapshot | 'unverified' | IndexReadFailure | undefined> {
  try {
    return await reader?.read({ traceId: request.traceId, principal: request.principal, sourceId: request.sourceId, ...(request.signal === undefined ? {} : { signal: request.signal }) });
  } catch (error) {
    // a cancelled request fails as a whole; it is never handed to a read as the schema's failure
    if (error instanceof RequestCancelled) throw error;
    if (error instanceof AppError) return { failure: error };
    throw error;
  }
}

/**
 * What is searched: every property that has an online index, in the form its index serves (`value` for a RANGE index or a constraint, `text` for a TEXT index only); each property that has
 * none is named with its type and why, and the type is marked as not searched when none of its properties is. With no snapshot (the login cannot list indexes) every property is searched as a `value`.
 */
function planOf(candidates: readonly Candidate[], snapshot: IndexSnapshot | undefined): { readonly targets: readonly SearchTarget[]; readonly disabled: DisabledType[] } {
  const targets: SearchTarget[] = [];
  const disabled: DisabledType[] = [];
  for (const entity of candidates) {
    const indexes = entity.properties.map((property) => ({ property, index: snapshot === undefined ? { form: 'value' as const } : propertyIndexOf(snapshot, entity.label, property) }));
    const searched = indexes.flatMap(({ property, index }) => ('form' in index ? [{ entityType: entity.type, property, match: index.form }] : []));
    targets.push(...searched);
    for (const { property, index } of indexes) {
      if ('gap' in index) disabled.push({ entityType: entity.type, property, reason: index.gap, typeSearched: searched.length > 0 });
    }
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
    for (const reason of DROP_REASONS) {
      const count = result.dropped[reason] ?? 0;
      if (count > 0 || total[reason] !== undefined) total[reason] = (total[reason] ?? 0) + count;
    }
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
  if (error instanceof RequestCancelled || !(error instanceof AppError) || !isGroupFailureCode(error.code)) return undefined;
  const timeoutMs = error.code === 'QUERY_TIMEOUT' ? timeoutOf(error.details) : undefined;
  return { group, code: error.code, ...(timeoutMs === undefined ? {} : { timeoutMs }) };
}

/**
 * The groups whose read failed while another group's was answered. A failure that means the same for every group (an unavailable or unreadable source, a bad request) fails the whole search,
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

function evidenceOf(item: Normalized): readonly RelationshipEvidence[] {
  if (!isNormalizedEvidence(item)) throw new AppError('INTERNAL_ERROR');
  return item.evidence;
}

function normalizedOf(page: GatePage): Normalized {
  const [item] = page.items;
  if (!isNormalized(item)) throw new AppError('INTERNAL_ERROR');
  return item;
}

const entityKey = (node: GraphNode): string => JSON.stringify([node.ref.entityType, node.ref.stableId]);

/** The cursor of a page's next page, as a field of its group: absent when the read found no more. */
const nextOf = (page: GatePage | undefined): { readonly nextCursor?: string } => (page?.nextCursor === undefined ? {} : { nextCursor: page.nextCursor });

/** The relationship context of a hit as the hit holds it: absent when it has none. */
const contextField = (context: RelationshipContext | undefined): { readonly context?: RelationshipContext } => (context === undefined ? {} : { context });

/** The types whose pairs were left out of the context read for want of an online `stable_id` index; absent when there is none. */
const contextDisabledField = (plan: ContextPlan | undefined): { readonly context?: { readonly disabledTypes: DisabledType[] } } => (plan === undefined || plan.disabledTypes.length === 0 ? {} : { context: { disabledTypes: [...plan.disabledTypes] } });

type FacetCount<Scope extends string> = { readonly value: number; readonly quality: 'exact' | 'lowerBound'; readonly scope: Scope } | { readonly quality: 'unknown'; readonly scope: Scope };

function raise<Scope extends string>(count: FacetCount<Scope>, shown: number): FacetCount<Scope> {
  return count.quality !== 'unknown' && count.value < shown ? { value: shown, quality: 'lowerBound', scope: count.scope } : count;
}

/**
 * The facets made consistent with the groups of the same answer: a count is read in its own read, so it can be lower than the hits a group holds when the source changed between the two reads, or when
 * the group holds more than one page; such a count is then a lower bound of the hits held, never a number below what is shown.
 */
function atLeastHeld(
  facets: Facets,
  held: { readonly exact: readonly GraphNode[]; readonly related: readonly GraphNode[]; readonly unreferenced: { readonly exact: readonly UnreferencedHit[]; readonly related: readonly UnreferencedHit[] }; readonly evidence: number },
): Facets {
  if (!facets.searchable) return facets;
  const entities = [...held.exact, ...held.related];
  // an unreferenced hit has no key to tell it from another, so the group's unreferenced hits of a type are counted as the larger of the two groups' numbers
  const unreferencedOfType = (type?: string): number => Math.max(...[held.unreferenced.exact, held.unreferenced.related].map((hits) => hits.filter((hit) => type === undefined || hit.entityType === type).length));
  const distinct = (nodes: readonly GraphNode[]): number => new Set(nodes.map(entityKey)).size;
  const byMode = { exact: distinct(held.exact) + held.unreferenced.exact.length, related: distinct(held.related) + held.unreferenced.related.length, evidence: held.evidence };
  return {
    ...facets,
    total: raise(facets.total, distinct(entities) + unreferencedOfType()),
    entityType: facets.entityType.map((entry) => ({ ...entry, count: raise(entry.count, distinct(entities.filter((node) => node.ref.entityType === entry.entityType)) + unreferencedOfType(entry.entityType)) })),
    matchMode: facets.matchMode.map((entry) => ({ ...entry, count: raise(entry.count, byMode[entry.mode]) })),
  };
}

/** The unreferenced hits of a group as the answer holds them: absent when there is none. */
const unreferencedField = (hits: readonly UnreferencedHit[]): { readonly unreferenced?: UnreferencedHit[] } => (hits.length === 0 ? {} : { unreferenced: [...hits] });

/**
 * The `startsWith` group: the prefix hits in order, without those the exact group already holds; empty with an unknown count when its read failed, and empty and exact when nothing was read. Its read is
 * capped and has no next page: a cut read is a lower bound of the hits held.
 */
function startsWithOf(source: SourceModel, item: Normalized | undefined, page: GatePage | undefined, exact: readonly GraphNode[], failed: boolean): StartsWithGroup {
  const held = new Set(exact.map(entityKey));
  const nodes = item === undefined ? [] : inOrder(source, item.nodes).filter((node) => !held.has(entityKey(node)));
  const unreferenced = item?.unreferenced ?? [];
  const dropped: Dropped = item === undefined ? { 'not-mapped': 0, 'ambiguous-type': 0, 'no-stable-id': 0 } : droppedOf([item]);
  return { nodes, ...unreferencedField(unreferenced), count: countOf(nodes.length + unreferenced.length, page, STARTS_WITH_SCOPE, failed), dropped, warnings: item === undefined ? [] : item.warnings };
}

export function createSearchService(deps: { readonly gate: Gate; readonly mapping: MappingModel; readonly access: SourceAccess; readonly indexes?: IndexReader; readonly clock?: () => number }): SearchService {
  const clock = deps.clock ?? Date.now;
  return {
    async search(request) {
      await deps.access.require({ traceId: request.traceId, principal: request.principal, sourceId: request.sourceId, auditAction: searchExactTemplate.auditAction, rate: 'count' });
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
          ...(request.signal === undefined ? {} : { signal: request.signal }),
          ...(snapshot === undefined ? {} : { indexes: snapshot }),
        });
      const run = (templateId: string, targets: readonly object[]): Promise<GatePage> => runWith(templateId, { text: request.text, targets });
      const facetPlan = typeahead ? undefined : planFacets(source, exactPlan.targets, relatedPlan.targets, evidencePlan.targets);
      const none = Promise.resolve(undefined);
      // the first read is the exact group when it is chosen (it goes through the gate even with no target), else the first chosen group that has a target: a failure that means the same for every group
      // (the schema read, an unavailable or refused source, a bad request) stops the search before another group is read
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
      // a cancelled request fails as a whole, whichever read saw it: it is never one group's failure
      const cancelled = settled.find((outcome) => outcome.status === 'rejected' && outcome.reason instanceof RequestCancelled);
      if (cancelled?.status === 'rejected') throw cancelled.reason;
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
            facets = facetsOf(facetPlan, facetsOutcome.status === 'fulfilled' ? facetsOutcome.value : undefined);
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
      const evidence = evidenceItem === undefined ? [] : evidenceHitsOf(source, evidenceOf(evidenceItem), evidencePage?.hasMore !== true);
      const exactUnreferenced = exactItem?.unreferenced ?? [];
      const relatedUnreferenced = relatedItem?.unreferenced ?? [];
      const read = [exactItem, relatedItem, evidenceItem].filter((item) => item !== undefined);
      const dropped = droppedOf(read);
      // the relationship context is read once, after the groups settled, for the hits and exact matches this answer holds; a failure of its own keeps every hit and says the context was not read
      const contextPlan = typeahead || failed.has('exact') || failed.has('related') ? undefined : planContext(source, related, exact, planSnapshot, cap);
      let contextFailure: GroupFailure | undefined;
      let contexts: ReadonlyMap<number, RelationshipContext> = new Map();
      if (contextPlan !== undefined && contextWillRead(contextPlan)) {
        try {
          contexts = contextsOf(contextPlan, (await runWith(RELATED_CONTEXT_ID, contextParamsOf(contextPlan))).items);
        } catch (error) {
          if (error instanceof RequestCancelled) throw error;
          contextFailure = failureOf('context', error);
          if (contextFailure === undefined) throw error;
        }
      }
      return {
        sourceId: request.sourceId,
        exact,
        ...(exactUnreferenced.length === 0 ? {} : { exactUnreferenced: [...exactUnreferenced] }),
        cap,
        searchable: exactTargets.length > 0,
        counts: { exact: countOf(exact.length + exactUnreferenced.length, exactPage, EXACT_SCOPE, failed.has('exact')) },
        ...(exactPage?.nextCursor === undefined ? {} : { exactNextCursor: exactPage.nextCursor }),
        disabledTypes: modeOn('exact') ? exactPlan.disabled.filter((entry) => typeOn(entry.entityType)) : [],
        related: {
          hits: related.map((node, place) => ({ node, matchedProperties: matchedPropertiesOf(node, relatedTargets, request.text), ...contextField(contexts.get(place)) })),
          ...unreferencedField(relatedUnreferenced),
          count: countOf(related.length + relatedUnreferenced.length, relatedPage, RELATED_SCOPE, failed.has('related')),
          searchable: relatedTargets.length > 0,
          disabledTypes: modeOn('related') ? relatedPlan.disabled.filter((entry) => typeOn(entry.entityType)) : [],
          ...nextOf(relatedPage),
          ...contextDisabledField(contextPlan),
        },
        evidence: {
          hits: evidence,
          count: countOf(relationshipsOf(evidence), evidencePage, EVIDENCE_SCOPE, failed.has('evidence')),
          searchable: evidenceTargets.length > 0,
          disabledRelationshipTypes: modeOn('evidence') ? evidencePlan.disabled : [],
          ...nextOf(evidencePage),
        },
        failures: [...failures, ...(facetsFailure === undefined || !facetsRead ? [] : [facetsFailure]), ...(contextFailure === undefined ? [] : [contextFailure])],
        dropped,
        // only the exact and related groups list their unreferenced hits; an end of an evidence relationship with no stable ID is left out with its relationship
        warnings: warningsOf(dropped, exactUnreferenced.length + relatedUnreferenced.length),
        elapsedMs: Math.max(0, Math.round(clock() - startedAt)),
        ...(withStartsWith ? { startsWith: startsWithOf(source, startsWithItem, startsWithPage, exact, failed.has('startsWith')) } : {}),
        ...(facets === undefined ? {} : { facets: atLeastHeld(facets, { exact, related, unreferenced: { exact: exactUnreferenced, related: relatedUnreferenced }, evidence: relationshipsOf(evidence) }), filters: { entityTypes: types, matchModes: [...modes] } }),
      };
    },

    async more(request) {
      await deps.access.require({ traceId: request.traceId, principal: request.principal, sourceId: request.sourceId, auditAction: searchExactTemplate.auditAction, rate: 'count' });
      const source = deps.mapping.sources.find((candidate) => candidate.id === request.sourceId);
      if (source === undefined) throw new AppError('NOT_FOUND');
      const { group } = request;
      // the startsWith group is capped and has no next page
      if (!isPagedGroup(group)) throw new AppError('INVALID_REQUEST');
      if ((request.entityTypes ?? []).some((type) => !source.entities.some((entity) => entity.type === type))) throw new AppError('INVALID_REQUEST');
      // the exact matches the page's records are paired with are refused before any read: only the related group takes them, at most the cap of them, each a reference of an entity type of this source
      const exactRefs = request.exactRefs ?? [];
      const pageCap = Math.min(SEARCH_GROUP_CAP, source.budgets.maxPage);
      if (exactRefs.length > 0 && (group !== 'related' || exactRefs.length > pageCap || exactRefs.some((ref) => ref.sourceId !== request.sourceId || !source.entities.some((entity) => entity.type === ref.entityType)))) throw new AppError('INVALID_REQUEST');
      const typeOn = (type: string): boolean => request.entityTypes === undefined || request.entityTypes.includes(type);
      // the page is planned as the first page was, from a fresh read of the schema: the same masking, the same properties and the same forms, so its parameters are the ones the cursor is bound to
      const exactCandidates = group === 'exact' ? candidatesOf(source, 'exact', request.mask) : [];
      const relatedCandidates = group === 'related' ? candidatesOf(source, 'related', request.mask) : [];
      const evidenceRows = group === 'evidence' ? evidenceRowsOf(source) : 0;
      const snapshot = await readOrFail(exactCandidates.length + relatedCandidates.length + evidenceRows > 0 ? deps.indexes : undefined, request);
      const planSnapshot = snapshot === undefined || snapshot === 'unverified' || 'failure' in snapshot ? undefined : snapshot;
      const plan = moreTargetsOf(group, { exact: exactCandidates, related: relatedCandidates }, source, planSnapshot, typeOn);
      const scope = SCOPES[group];
      let page: GatePage;
      try {
        page = await runSearch(deps.gate, {
          traceId: request.traceId,
          principal: request.principal,
          sourceId: request.sourceId,
          templateId: plan.templateId,
          params: { text: request.text, targets: plan.targets },
          limit: Math.min(SEARCH_GROUP_CAP, source.budgets.maxPage),
          cursor: request.cursor,
          mask: request.mask,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
          ...(snapshot === undefined ? {} : { indexes: snapshot }),
        });
      } catch (error) {
        // a failed schema read is the failure of the request, whatever code it has; a code of the group's own is the failure of this page, and the cursor sent stays usable
        const schemaFailed = snapshot !== undefined && snapshot !== 'unverified' && 'failure' in snapshot;
        const failure = schemaFailed ? undefined : failureOf(group, error);
        if (failure === undefined) throw error;
        return { ...emptyPageOf(group), sourceId: request.sourceId, count: { quality: 'unknown', scope }, dropped: noDropped(), warnings: [], failure };
      }
      const item = normalizedOf(page);
      const hits = hitsOf(group, source, item, plan.targets, request.text);
      // the group's count is the hits of every page so far: the gate carries those of the earlier pages in the signed cursor, so a caller cannot change them
      if (page.held === undefined) throw new AppError('INTERNAL_ERROR');
      const dropped = droppedOf([item]);
      // an evidence page lists no unreferenced record: an end with no stable ID is left out with its relationship
      const warnings = hits.group === 'evidence' ? warningsOf(dropped) : item.warnings;
      const withContext = hits.group === 'related' && exactRefs.length > 0 ? await contextOfPage(deps.gate, request, source, snapshot, planSnapshot, hits, exactRefs) : hits;
      return { ...withContext, sourceId: request.sourceId, count: countOf(page.held, page, scope, false), dropped, warnings, ...nextOf(page) };
    },
  };
}

type RelatedPage = Extract<PageHits, { group: 'related' }>;

/**
 * The relationship context of the records of a related page against the exact matches the person holds: one read through the gate, under the same masking and schema snapshot as the page. A failure
 * of its own keeps the records and is named in `contextFailure`; a failure that means the same for every read, and a cancel, fail the request.
 */
async function contextOfPage(
  gate: Gate,
  request: SearchMoreRequest,
  source: SourceModel,
  snapshot: IndexSnapshot | 'unverified' | IndexReadFailure | undefined,
  planSnapshot: IndexSnapshot | undefined,
  hits: RelatedPage,
  exactRefs: readonly GraphNode['ref'][],
): Promise<RelatedPage & { readonly contextFailure?: GroupFailure; readonly context?: { readonly disabledTypes: DisabledType[] } }> {
  const plan = planContext(source, hits.hits.map((hit) => hit.node), exactRefs.map((ref) => ({ ref })), planSnapshot, Math.min(SEARCH_GROUP_CAP, source.budgets.maxPage));
  if (!contextWillRead(plan)) return { ...hits, ...contextDisabledField(plan) };
  try {
    const page = await runSearch(gate, {
      traceId: request.traceId,
      principal: request.principal,
      sourceId: request.sourceId,
      templateId: RELATED_CONTEXT_ID,
      params: contextParamsOf(plan),
      limit: Math.min(SEARCH_GROUP_CAP, source.budgets.maxPage),
      mask: request.mask,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(snapshot === undefined ? {} : { indexes: snapshot }),
    });
    const contexts = contextsOf(plan, page.items);
    return { ...hits, hits: hits.hits.map((hit, place) => ({ ...hit, ...contextField(contexts.get(place)) })), ...contextDisabledField(plan) };
  } catch (error) {
    if (error instanceof RequestCancelled) throw error;
    const contextFailure = failureOf('context', error);
    if (contextFailure === undefined) throw error;
    return { ...hits, contextFailure, ...contextDisabledField(plan) };
  }
}

const isPagedGroup = (group: SearchGroup): group is SearchPagedGroup => SEARCH_PAGED_GROUPS.some((candidate) => candidate === group);

const SCOPES: Readonly<Record<SearchPagedGroup, string>> = { exact: EXACT_SCOPE, related: RELATED_SCOPE, evidence: EVIDENCE_SCOPE };

const noDropped = (): Dropped => ({ 'not-mapped': 0, 'ambiguous-type': 0, 'no-stable-id': 0 });

/** The template and the targets of one group's page, as the first page of the search had them: the exact and the related group narrowed by the entity types. */
function moreTargetsOf(
  group: SearchPagedGroup,
  candidates: { readonly exact: readonly Candidate[]; readonly related: readonly Candidate[] },
  source: SourceModel,
  snapshot: IndexSnapshot | undefined,
  typeOn: (type: string) => boolean,
): { readonly templateId: string; readonly targets: readonly SearchTarget[] } | { readonly templateId: string; readonly targets: readonly EvidenceTarget[] } {
  switch (group) {
    case 'exact':
      return { templateId: SEARCH_EXACT_ID, targets: planOf(candidates.exact, snapshot).targets.filter((target) => typeOn(target.entityType)) };
    case 'related':
      return { templateId: SEARCH_RELATED_ID, targets: planOf(candidates.related, snapshot).targets.filter((target) => typeOn(target.entityType)) };
    case 'evidence':
      return { templateId: SEARCH_EVIDENCE_ID, targets: planEvidence(source, snapshot).targets };
    default:
      return exhaustive(group);
  }
}

type PageHits =
  | Pick<Extract<SearchMoreResult, { group: 'exact' }>, 'group' | 'nodes' | 'unreferenced'>
  | Pick<Extract<SearchMoreResult, { group: 'related' }>, 'group' | 'hits' | 'unreferenced'>
  | Pick<Extract<SearchMoreResult, { group: 'evidence' }>, 'group' | 'hits'>;

function emptyPageOf(group: SearchPagedGroup): PageHits {
  return group === 'related' || group === 'evidence' ? { group, hits: [] } : { group, nodes: [] };
}

/** The hits of one group's page in that group's own shape, in the order the first page puts them in. */
function hitsOf(group: SearchPagedGroup, source: SourceModel, item: Normalized, targets: readonly SearchTarget[] | readonly EvidenceTarget[], text: string): PageHits {
  switch (group) {
    case 'exact':
      return { group, nodes: inOrder(source, item.nodes), ...unreferencedField(item.unreferenced) };
    case 'related':
      return {
        group,
        hits: inOrder(source, item.nodes).map((node) => ({ node, matchedProperties: matchedPropertiesOf(node, targets.filter((target): target is SearchTarget => 'entityType' in target), text) })),
        ...unreferencedField(item.unreferenced),
      };
    case 'evidence':
      // a later page cannot know the members an earlier page listed, so its member counts are lower bounds
      return { group, hits: evidenceHitsOf(source, evidenceOf(item), false) };
    default:
      return exhaustive(group);
  }
}

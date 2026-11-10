import type { GraphNode, Investigation, InvestigationListItem, InvestigationListResponse, InvestigationResponse, OpenInvestigationResponse, OpenInvestigationRequest } from '@neburyx/contracts';
import type { ApiClient } from '../api/client.js';
import { fakeClient } from '../api/fake-client.js';
import { me, source } from '../test-utils.js';
import { testProfile } from '../dev/test-profile.js';

export const INVESTIGATION_A = '0192f000-0000-7000-8000-0000000000a1';
export const INVESTIGATION_B = '0192f000-0000-7000-8000-0000000000b1';

export function nodeOf(sourceId: string, entityType: string, stableId: string, title = `${entityType} ${stableId}`): GraphNode {
  return { ref: { sourceId, entityType, stableId }, display: { title, type: entityType }, properties: [], qualityFlags: [], provenanceRefs: [], authorization: { canInspect: true, canExport: true } };
}

export function investigationOf(id: string, sourceId: string, entityType: string, stableId: string, overrides: Partial<Investigation> = {}): Investigation {
  return {
    id,
    sourceId,
    title: `${entityType} ${stableId}`,
    caseRef: null,
    status: 'open',
    startingEntity: { entityType, stableId },
    sourceState: 'available',
    createdAt: '2026-11-05T10:00:00.000Z',
    lastEditedAt: '2026-11-05T10:00:00.000Z',
    version: 1,
    ...overrides,
  };
}

/** A list answer whose counts are those of `all`, the rows the server could list (the rows shown unless more are given), and of the named views given. */
export function listOf(items: readonly InvestigationListItem[], hasMore = false, all: readonly InvestigationListItem[] = items, savedViews: { readonly count: number; readonly lastEditedAt: string | null } = { count: 0, lastEditedAt: null }): InvestigationListResponse {
  return {
    items: [...items],
    nextCursor: hasMore ? 'next-page' : null,
    retention: { deletedInvestigationsDays: 30 },
    matching: { value: all.length, quality: 'exact', scope: 'investigations-matching' },
    counts: {
      investigations: { value: all.length, quality: 'exact', scope: 'investigations' },
      sources: { value: new Set(all.map((item) => item.sourceId)).size, quality: 'exact', scope: 'investigation-sources' },
      savedViews: { count: { value: savedViews.count, quality: 'exact', scope: 'named-views' }, lastEditedAt: savedViews.lastEditedAt },
    },
  };
}

/** The row of the list for an investigation, as the API answers it: the alias is the one the test sources have. */
export function listItemOf(investigation: Investigation, overrides: Partial<InvestigationListItem> = {}): InvestigationListItem {
  return { ...investigation, sourceAlias: `Source ${investigation.sourceId}`, save: { state: 'unsaved', savedAt: null }, nodeCount: 1, edgeCount: 0, ...overrides };
}

export function readOf(investigation: Investigation): InvestigationResponse {
  const start = investigation.startingEntity;
  const nodes = start === null ? [] : [{ t: start.entityType, id: start.stableId }];
  const documents = {
    layout: { schemaVersion: 1 as const, layout: 'force', nodes: nodes.map((node) => ({ ...node, pinned: false, hidden: false, groupId: null })), edges: [], groups: [] },
    queryContext: { schemaVersion: 1 as const, loaded: { nodes, edges: [] }, expansions: [], filters: { entityTypes: [], relTypes: [], time: null, properties: [] } },
  };
  return { investigation, draft: { version: 1, ...documents, notes: null, basedOnViewId: null }, save: { state: 'unsaved', savedAt: null } };
}

export function openedOf(investigation: Investigation, entity: GraphNode | undefined, created = true): OpenInvestigationResponse {
  const { sourceState } = investigation;
  if (sourceState !== 'available') return { investigation: { ...investigation, sourceState }, created: false, draft: { version: 1, notes: null, basedOnViewId: null } };
  if (entity === undefined) throw new Error('an available investigation is answered with its entity');
  return { investigation: { ...investigation, sourceState }, created, entity, draft: { version: 1, notes: null, basedOnViewId: null } };
}

export interface Calls {
  readonly getEntity: number[];
  readonly getInvestigation: string[];
  readonly openInvestigation: number[];
  readonly listInvestigations: number[];
}

/** A client whose API knows the given investigations and entities, counting the reads it is asked for. */
export interface KnownInvestigation {
  readonly investigation: Investigation;
  readonly node: GraphNode;
  /** What the API answers instead of `node` when the read asks for masking. */
  readonly masked?: GraphNode;
}

export function knowing(known: readonly KnownInvestigation[], overrides: Partial<ApiClient> = {}): { readonly client: ApiClient; readonly calls: Calls } {
  const calls: Calls = { getEntity: [], getInvestigation: [], openInvestigation: [], listInvestigations: [] };
  const client = fakeClient({
    getMe: async () => ({ ok: true, value: me() }),
    getSources: async () => ({ ok: true, value: { items: [source('source-a'), source('source-b')], nextCursor: null } }),
    getProfile: async (sourceId) => ({ ok: true, value: testProfile(sourceId) }),
    listInvestigations: async (limit) => {
      calls.listInvestigations.push(limit);
      return { ok: true, value: listOf(known.slice(0, limit).map((entry) => listItemOf(entry.investigation)), known.length > limit, known.map((entry) => listItemOf(entry.investigation))) };
    },
    getInvestigation: async (id) => {
      calls.getInvestigation.push(id);
      const found = known.find((entry) => entry.investigation.id === id);
      return found === undefined ? { ok: false, failure: { code: 'NOT_FOUND', message: 'Not found.', retryable: false, traceId: 'tr-1' } } : { ok: true, value: readOf(found.investigation) };
    },
    getEntity: async (ref, options) => {
      calls.getEntity.push(calls.getEntity.length + 1);
      const found = known.find((entry) => entry.node.ref.sourceId === ref.sourceId && entry.node.ref.entityType === ref.entityType && entry.node.ref.stableId === ref.stableId);
      return found === undefined ? { ok: false, failure: { code: 'NOT_FOUND', message: 'Not found.', retryable: false, traceId: 'tr-2' } } : { ok: true, value: options?.mask === true && found.masked !== undefined ? found.masked : found.node };
    },
    openInvestigation: async (request) => {
      calls.openInvestigation.push(calls.openInvestigation.length + 1);
      const found = known.find((entry) => entry.node.ref.sourceId === request.entity.sourceId && entry.node.ref.entityType === request.entity.entityType && entry.node.ref.stableId === entityIdOf(request.entity));
      return found === undefined ? { ok: false, failure: { code: 'NOT_FOUND', message: 'Not found.', retryable: false, traceId: 'tr-3' } } : { ok: true, value: openedOf(found.investigation, request.mask === true && found.masked !== undefined ? found.masked : found.node) };
    },
    saveDraft: async (_id, version, body) => ({ ok: true, value: { version, save: { state: 'unsaved', savedAt: null }, notes: body.notes } }),
    ...overrides,
  });
  return { client, calls };
}

/** Makes the install's one source a real, connected source, so a person with no investigation is shown Home and not First run. */
export const REAL_SOURCE: Partial<ApiClient> = { getSources: async () => ({ ok: true, value: { items: [source('source-a', { synthetic: false })], nextCursor: null } }) };

/** A list read that fails the first time and then never answers: Home is chosen from the failure and the retry leaves it with nothing held and the read under way. */
export function failsThenWaits(): Pick<ApiClient, 'listInvestigations'> {
  let reads = 0;
  return { listInvestigations: async () => (++reads === 1 ? { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } } : new Promise<never>(() => undefined)) };
}

/** The ID an open request names its entity by, whichever form it came in. */
export const entityIdOf = (entity: OpenInvestigationRequest['entity']): string => ('stableId' in entity ? entity.stableId : entity.value);

/** A list row as the investigation it describes: the fields only a list row has are dropped and the starting entity holds its identifier. */
export function investigationOfRow(row: InvestigationListItem): Investigation {
  const { sourceAlias: _alias, save: _save, nodeCount: _nodes, edgeCount: _edges, deletedAt: _deleted, purgeAfter: _purge, startingEntity, ...investigation } = row;
  return { ...investigation, startingEntity: startingEntity === null ? null : { entityType: startingEntity.entityType, stableId: startingEntity.stableId ?? 'unknown' } };
}

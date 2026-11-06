import type { GraphNode, Investigation, InvestigationListItem, InvestigationResponse, OpenInvestigationResponse } from '@neburyx/contracts';
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

/** The row of the list for an investigation, as the API answers it: the alias is the one the test sources have. */
export function listItemOf(investigation: Investigation, overrides: Partial<InvestigationListItem> = {}): InvestigationListItem {
  return { ...investigation, sourceAlias: `Source ${investigation.sourceId}`, save: { state: 'unsaved', savedAt: null }, ...overrides };
}

export function readOf(investigation: Investigation): InvestigationResponse {
  const documents = {
    layout: { schemaVersion: 1 as const, layout: 'force', nodes: [], edges: [], groups: [] },
    queryContext: { schemaVersion: 1 as const, loaded: { nodes: [], edges: [] }, expansions: [], filters: { entityTypes: [], relTypes: [], time: null, properties: [] } },
  };
  return { investigation, draft: { version: 1, ...documents } };
}

export function openedOf(investigation: Investigation, entity: GraphNode | undefined, created = true): OpenInvestigationResponse {
  const { sourceState } = investigation;
  if (sourceState !== 'available') return { investigation: { ...investigation, sourceState }, created: false };
  if (entity === undefined) throw new Error('an available investigation is answered with its entity');
  return { investigation: { ...investigation, sourceState }, created, entity };
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
      return { ok: true, value: { items: known.slice(0, limit).map((entry) => listItemOf(entry.investigation)), hasMore: known.length > limit } };
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
      const found = known.find((entry) => entry.node.ref.sourceId === request.entity.sourceId && entry.node.ref.entityType === request.entity.entityType && entry.node.ref.stableId === request.entity.stableId);
      return found === undefined ? { ok: false, failure: { code: 'NOT_FOUND', message: 'Not found.', retryable: false, traceId: 'tr-3' } } : { ok: true, value: openedOf(found.investigation, request.mask === true && found.masked !== undefined ? found.masked : found.node) };
    },
    ...overrides,
  });
  return { client, calls };
}

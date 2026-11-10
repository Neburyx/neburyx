import type { InvestigationListItem, InvestigationListResponse, OwnedView } from '@neburyx/contracts';
import type { ApiClient, ApiResult, InvestigationPageQuery } from '../api/client.js';
import { fakeClient } from '../api/fake-client.js';
import { testProfile } from '../dev/test-profile.js';
import { investigationOf, investigationOfRow, listItemOf, nodeOf, readOf } from '../investigations/test-data.js';
import { me, source } from '../test-utils.js';

export const idOf = (index: number): string => `0192f000-0000-7000-8000-${String(index).padStart(12, '0')}`;

/** `count` rows, newest first, alternating over `source-a` and `source-b`, with unique titles and starting entities. */
export function rowsOf(count: number, overrides: (index: number) => Partial<InvestigationListItem> = () => ({})): InvestigationListItem[] {
  return Array.from({ length: count }, (_, index) =>
    listItemOf(
      investigationOf(idOf(index + 1), index % 2 === 0 ? 'source-a' : 'source-b', 'kind-a', `E-${index + 1}`, {
        title: `Case ${index + 1}`,
        lastEditedAt: new Date(Date.UTC(2026, 10, 5, 12) - index * 60_000).toISOString(),
      }),
      overrides(index),
    ),
  );
}

export const viewsOf = (count: number): OwnedView[] =>
  Array.from({ length: count }, (_, index) => ({
    id: idOf(5000 + index),
    name: `View ${index + 1}`,
    investigation: { id: idOf(index + 1), title: `Case ${index + 1}`, sourceId: 'source-a', sourceAlias: 'Source source-a', status: 'open' as const },
    savedBy: { name: 'Local user' },
    createdAt: new Date(Date.UTC(2026, 10, 5, 13) - index * 60_000).toISOString(),
    version: 1,
  }));

export interface Recorded {
  readonly pages: InvestigationPageQuery[];
  readonly readRefs: { sourceId: string; refs: number }[];
  readonly views: { cursor?: string | undefined }[];
  readonly statusChanges: { id: string; status: string; version: number }[];
  readonly deletes: { id: string; version: number }[];
  readonly restores: { id: string; version: number }[];
}

export function listResponse(items: readonly InvestigationListItem[], matching: number, nextCursor: string | null, savedViews = 0): InvestigationListResponse {
  return {
    items: [...items],
    nextCursor,
    retention: { deletedInvestigationsDays: 30 },
    matching: { value: matching, quality: 'exact', scope: 'investigations-matching' },
    counts: {
      investigations: { value: matching, quality: 'exact', scope: 'investigations' },
      sources: { value: 2, quality: 'exact', scope: 'investigation-sources' },
      savedViews: { count: { value: savedViews, quality: 'exact', scope: 'named-views' }, lastEditedAt: null },
    },
  };
}

const matches = (item: InvestigationListItem, query: InvestigationPageQuery): boolean => {
  const text = query.text?.toLowerCase();
  return (query.deleted === true ? item.deletedAt !== undefined : item.deletedAt === undefined && item.status === (query.status ?? 'open')) && (query.sourceId === undefined || item.sourceId === query.sourceId) && (text === undefined || item.title.toLowerCase().includes(text) || (item.caseRef?.toLowerCase().includes(text) ?? false));
};

/** A client over a list held in memory: the list route pages by an offset cursor and filters as the server does; every call is recorded. */
export function pagedClient(all: readonly InvestigationListItem[], views: readonly OwnedView[] = [], overrides: Partial<ApiClient> = {}): { readonly client: ApiClient; readonly recorded: Recorded } {
  const recorded: Recorded = { pages: [], readRefs: [], views: [], statusChanges: [], deletes: [], restores: [] };
  const data = [...all];
  const client = fakeClient({
    getMe: async () => ({ ok: true, value: me() }),
    getSources: async () => ({ ok: true, value: { items: [source('source-a'), source('source-b')], nextCursor: null } }),
    getProfile: async (sourceId) => ({ ok: true, value: testProfile(sourceId) }),
    listInvestigations: async () => ({ ok: true, value: listResponse([], all.length, null) }),
    listInvestigationPage: async (query): Promise<ApiResult<InvestigationListResponse>> => {
      recorded.pages.push(query);
      const found = data.filter((item) => matches(item, query));
      const start = query.cursor === undefined ? 0 : Number(query.cursor);
      const limit = query.limit ?? 25;
      const page = found.slice(start, start + limit);
      return { ok: true, value: listResponse(page, found.length, start + limit < found.length ? String(start + limit) : null, views.length) };
    },
    listOwnedViews: async (page) => {
      recorded.views.push({ cursor: page.cursor });
      const start = page.cursor === undefined ? 0 : Number(page.cursor);
      return { ok: true, value: { items: views.slice(start, start + 25), nextCursor: start + 25 < views.length ? String(start + 25) : null, count: { value: views.length, quality: 'exact', scope: 'named-views' } } };
    },
    readRefs: async (request) => {
      recorded.readRefs.push({ sourceId: request.sourceId, refs: request.entities.length });
      return { ok: true, value: { nodes: request.entities.map((ref) => nodeOf(ref.sourceId, ref.entityType, ref.stableId, `Label ${ref.stableId}`)), edges: [], missing: { entities: [], edges: [] } } };
    },
    getEntity: async (ref) => ({ ok: true, value: nodeOf(ref.sourceId, ref.entityType, ref.stableId, `Label ${ref.stableId}`) }),
    getInvestigation: async (id) => {
      const found = data.find((item) => item.id === id);
      if (found === undefined) return { ok: false, failure: { code: 'NOT_FOUND', message: 'Not found.', retryable: false, traceId: 'tr-1' } };
      return { ok: true, value: readOf(investigationOfRow(found)) };
    },
    changeInvestigationStatus: async (id, status, version) => {
      recorded.statusChanges.push({ id, status, version });
      const found = data.find((item) => item.id === id);
      if (found === undefined) return { ok: false, failure: { code: 'NOT_FOUND', message: 'Not found.', retryable: false, traceId: 'tr-2' } };
      data[data.indexOf(found)] = { ...found, status, version: version + 1 };
      const investigation = investigationOfRow(found);
      return { ok: true, value: { investigation: { ...investigation, status, version: version + 1, closedAt: null, archivedAt: null } } };
    },
    deleteInvestigation: async (id, version) => {
      recorded.deletes.push({ id, version });
      const found = data.find((item) => item.id === id);
      if (found === undefined || found.deletedAt !== undefined) return { ok: false, failure: { code: 'NOT_FOUND', message: 'Not found.', retryable: false, traceId: 'tr-3' } };
      const deletedAt = '2026-11-10T10:00:00.000Z';
      const purgeAfter = '2026-12-10T10:00:00.000Z';
      data[data.indexOf(found)] = { ...found, version: version + 1, deletedAt, purgeAfter };
      return { ok: true, value: { id, version: version + 1, deletedAt, purgeAfter } };
    },
    restoreInvestigation: async (id, version) => {
      recorded.restores.push({ id, version });
      const found = data.find((item) => item.id === id);
      if (found === undefined || found.deletedAt === undefined) return { ok: false, failure: { code: 'NOT_FOUND', message: 'Not found.', retryable: false, traceId: 'tr-4' } };
      const { deletedAt: _deleted, purgeAfter: _purge, ...restored } = found;
      data[data.indexOf(found)] = { ...restored, version: version + 1 };
      return { ok: true, value: readOf({ ...investigationOfRow(restored), version: version + 1 }) };
    },
    ...overrides,
  });
  return { client, recorded };
}

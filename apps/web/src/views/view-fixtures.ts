import type { NamedView, SaveViewResponse, ViewListResponse } from '@neburyx/contracts';
import { fakeClient } from '../api/fake-client.js';
import type { ApiClient, ApiResult } from '../api/client.js';
import { draftSyncOf } from '../draft/draft-sync.js';
import { createClientState } from '../state/client-state.js';
import { key, result } from '../state/test-data.js';

export const INVESTIGATION_ID = '0192f000-0000-7000-8000-0000000000a1';
export const VIEW_ID = '0192f000-0000-7000-8000-0000000000b1';
export const SAVED_AT = '2026-11-10T09:42:00.000Z';
export const TITLE = 'Suspicious linked accounts';

export const failure = <T>(code: string): ApiResult<T> => ({ ok: false, failure: { code, message: 'x', retryable: false, traceId: 't' } as never });

export interface SaveViewCall {
  readonly id: string;
  readonly draftVersion: number;
  readonly body: Parameters<ApiClient['saveView']>[2];
}

/** The answer the API gives to a save of the draft at `draftVersion`: the view, the draft one version on, and the title it was asked for. */
export function savedAnswer(call: SaveViewCall): ApiResult<SaveViewResponse> {
  const { body } = call;
  return {
    ok: true,
    value: {
      view: { id: VIEW_ID, name: body.name, notes: body.notes, savedBy: { name: 'Local workspace' }, createdAt: SAVED_AT, version: 1 },
      draft: { version: call.draftVersion + 1, notes: body.notes, basedOnViewId: VIEW_ID },
      save: { state: 'saved', savedAt: SAVED_AT },
      ...(body.title === undefined || body.expectedInvestigationVersion === undefined ? {} : { investigation: { title: body.title, version: body.expectedInvestigationVersion + 1 } }),
    },
  };
}

export interface Rig {
  readonly state: ReturnType<typeof createClientState>;
  readonly client: ApiClient;
  readonly saves: SaveViewCall[];
  readonly drafts: { readonly version: number; readonly notes: string | null }[];
}

/** A workspace that shows one investigation, with a client that answers every draft write and view save from the rules of the API unless told otherwise. */
export function rig(options: { readonly saveView?: (call: SaveViewCall) => ApiResult<SaveViewResponse>; readonly saveDraft?: ApiClient['saveDraft']; readonly notes?: string | null; readonly base?: ApiClient; readonly listViews?: ApiClient['listViews']; readonly renameView?: ApiClient['renameView']; readonly overrides?: Partial<ApiClient>; readonly rehash?: boolean } = {}): Rig {
  const state = createClientState();
  state.bindSource('demo');
  const read = result('demo', ['A']);
  state.show({ id: INVESTIGATION_ID, sourceId: 'demo', record: { title: TITLE, caseRef: null, status: 'open', readOnly: false, version: 3, save: { kind: 'unsaved' } }, resultKeys: [key('demo')], nodeRefs: read.nodes.map((node) => node.ref), edgeRefs: [] }, [{ key: key('demo'), result: read }]);
  const saves: SaveViewCall[] = [];
  const drafts: { version: number; notes: string | null }[] = [];
  const client: ApiClient = {
    ...(options.base ?? fakeClient()),
    saveDraft:
      options.saveDraft ??
      (async (_id, version, body) => {
        drafts.push({ version, notes: body.notes });
        return { ok: true, value: { version: version + 1, save: { state: 'unsaved', savedAt: null }, notes: body.notes } };
      }),
    saveView: async (id, draftVersion, body) => {
      const call = { id, draftVersion, body };
      saves.push(call);
      return (options.saveView ?? savedAnswer)(call);
    },
    ...(options.listViews === undefined ? {} : { listViews: options.listViews }),
    ...(options.renameView === undefined ? {} : { renameView: options.renameView }),
    ...options.overrides,
  };
  draftSyncOf(state, client).adopt(INVESTIGATION_ID, { version: 1, notes: options.notes ?? null, basedOnViewId: null, writable: true, ...(options.rehash === true ? { rehash: true } : {}) });
  return { state, client, saves, drafts };
}

export const DRAFT_UPDATED_AT = '2026-11-10T09:42:00.000Z';

export function namedView(n: number, overrides: Partial<NamedView> = {}): NamedView {
  return { id: `0192f000-0000-7000-8000-${String(n).padStart(12, '0')}`, name: `View ${n}`, notes: null, savedBy: { name: 'Maya Chen' }, createdAt: `2026-10-30T09:${String(n).padStart(2, '0')}:00.000Z`, version: 1, ...overrides };
}

export interface ViewsServer {
  readonly views: NamedView[];
  readonly listed: { readonly cursor: string | undefined }[];
  readonly renamed: { readonly viewId: string; readonly version: number; readonly name: string }[];
  readonly listViews: ApiClient['listViews'];
  readonly renameView: ApiClient['renameView'];
  readonly deleted: { readonly viewId: string; readonly version: number; readonly note: string | null }[];
  readonly deleteView: ApiClient['deleteView'];
}

/** A server that holds named views, newest first, and answers pages of `pageSize` by a cursor that is the offset of the next row. */
export function viewsServer(views: readonly NamedView[], pageSize = 25): ViewsServer {
  const held = [...views];
  const listed: { cursor: string | undefined }[] = [];
  const renamed: { viewId: string; version: number; name: string }[] = [];
  const deleted: { viewId: string; version: number; note: string | null }[] = [];
  return {
    views: held,
    listed,
    renamed,
    deleted,
    deleteView: async (_id, viewId, version, note) => {
      deleted.push({ viewId, version, note });
      const index = held.findIndex((view) => view.id === viewId);
      const view = held[index];
      if (view === undefined) return failure('NOT_FOUND');
      if (view.version !== version) return failure('CONFLICTED_VIEW_VERSION');
      held.splice(index, 1);
      return { ok: true, value: { id: viewId, version: version + 1, deletedAt: '2026-11-10T10:00:00.000Z', draft: { version: 2, basedOnViewId: null }, save: { state: 'unsaved', savedAt: null }, count: { value: held.length, quality: 'exact', scope: 'named-views' } } };
    },
    listViews: async (_id, page) => {
      listed.push({ cursor: page.cursor });
      const start = page.cursor === undefined ? 0 : Number(page.cursor.replace('c', ''));
      const items = held.slice(start, start + pageSize);
      const value: ViewListResponse = {
        items,
        nextCursor: start + pageSize < held.length ? `c${start + pageSize}` : null,
        count: { value: held.length, quality: 'exact', scope: 'named-views' },
        draft: { basedOnViewId: held[0]?.id ?? null, updatedAt: DRAFT_UPDATED_AT },
      };
      return { ok: true, value };
    },
    renameView: async (_id, viewId, version, name) => {
      renamed.push({ viewId, version, name });
      const index = held.findIndex((view) => view.id === viewId);
      const view = held[index];
      if (view === undefined) return failure('NOT_FOUND');
      if (view.version !== version) return failure('CONFLICTED_VIEW_VERSION');
      const next = { ...view, name, version: version + 1 };
      held[index] = next;
      return { ok: true, value: next };
    },
  };
}

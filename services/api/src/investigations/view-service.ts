import { DEFAULT_VIEW_PAGE, MAX_VIEW_PAGE, layoutDocumentSchema, queryContextDocumentSchema, type RestoreViewResponse, type NamedView, type SaveViewRequest, type SaveViewResponse, type ViewListResponse, type DeleteViewResponse } from '@neburyx/contracts';
import { z } from 'zod';
import type { InvestigationStore } from '../db/investigations-repository.js';
import type { CursorBinding, CursorCodec } from '../gate/cursor/codec.js';
import type { ViewStore } from '../db/views-repository.js';
import { AppError } from '../errors.js';
import { uuidv7 } from '../identity/uuid.js';
import type { Principal } from '../seams/seams.js';
import type { MappingModel } from '../mapping/model.js';
import { COMMUNITY_POLICY_VERSION, contentHashOf } from './draft.js';
import { sourceStateOf } from './investigation-service.js';
import { readOnlyRefusal, readOnlyStatusOf, sourceChangedRefusal } from './read-only.js';
import type { StoredReferences } from './stored-references.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const LIST_TARGET = 'GET /v1/investigations/:id/views';
const LIST_SORT = 'created-desc';

const positionSchema = z.strictObject({ createdKey: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/), id: z.string().regex(UUID) });

export interface ViewService {
  /** Copies the caller's draft into a new named view, with the note given, when `expectedDraftVersion` is the draft's version. `CONFLICTED_VIEW_VERSION` when it is not, `CONFLICT` when the title was read at another version of the investigation. */
  save(call: { readonly id: string; readonly principal: Principal; readonly expectedDraftVersion: number; readonly request: SaveViewRequest }): Promise<SaveViewResponse>;
  /** A page of the investigation's named views, newest first. A `limit` of 0 is `INVALID_REQUEST`; above the maximum it is `QUERY_BUDGET_EXCEEDED`; a cursor that was not made for this call is `CURSOR_INVALIDATED`. */
  list(call: { readonly id: string; readonly principal: Principal; readonly limit: number | undefined; readonly cursor: string | undefined }): Promise<ViewListResponse>;
  /** Copies a named view over the caller's draft when `expectedDraftVersion` is the draft's version, and answers the draft as it is now. `CONFLICTED_VIEW_VERSION` when it is not. */
  restore(call: { readonly id: string; readonly viewId: string; readonly principal: Principal; readonly expectedDraftVersion: number }): Promise<RestoreViewResponse>;
  /** Changes the name of a named view when `expectedVersion` is its version; `CONFLICTED_VIEW_VERSION` when it is not. */
  rename(call: { readonly id: string; readonly viewId: string; readonly principal: Principal; readonly expectedVersion: number; readonly name: string }): Promise<NamedView>;
  /** Deletes a named view when `expectedVersion` is its version, keeping the note with it. A closed or archived investigation is refused before the version is checked; `CONFLICTED_VIEW_VERSION` when it is stale; `NOT_FOUND` for a view that is not the caller's, unknown or already deleted. The draft is not changed. */
  delete(call: { readonly id: string; readonly viewId: string; readonly principal: Principal; readonly expectedVersion: number; readonly note: string | null }): Promise<DeleteViewResponse>;
}

export interface ViewServiceDeps {
  readonly store: InvestigationStore & ViewStore;
  readonly references: StoredReferences;
  readonly cursors: CursorCodec;
  readonly mapping: MappingModel;
}

export function createViewService(deps: ViewServiceDeps): ViewService {
  const bindingOf = (investigationId: string, principal: Principal): CursorBinding => ({ source: null, principal: principal.id, policyVersion: COMMUNITY_POLICY_VERSION, filterHash: investigationId, sort: LIST_SORT, target: LIST_TARGET, targetVersion: '1' });

  /** The owner's investigation, or the refusal a write gets: not found, then closed or archived, then a changed source, all before a version guard. */
  async function requireWritable(id: string, principal: Principal): Promise<void> {
    const stored = await deps.store.readInvestigation(id, principal.id);
    if (stored === undefined) throw new AppError('NOT_FOUND');
    const readOnly = readOnlyStatusOf(stored.investigation.status);
    if (readOnly !== undefined) throw readOnlyRefusal(readOnly);
    const changed = sourceChangedRefusal(sourceStateOf(deps.mapping, stored.investigation));
    if (changed !== undefined) throw changed;
  }

  return {
    async save({ id, principal, expectedDraftVersion, request }) {
      if (!UUID.test(id)) throw new AppError('NOT_FOUND');
      const stored = await deps.store.readInvestigation(id, principal.id);
      if (stored === undefined) throw new AppError('NOT_FOUND');
      const readOnly = readOnlyStatusOf(stored.investigation.status);
      if (readOnly !== undefined) throw readOnlyRefusal(readOnly);
      const changed = sourceChangedRefusal(sourceStateOf(deps.mapping, stored.investigation));
      if (changed !== undefined) throw changed;
      const result = await deps.store.saveNamedView({
        investigationId: id,
        ownerId: principal.id,
        viewId: uuidv7(),
        expectedDraftVersion,
        name: request.name,
        notes: request.notes,
        title: request.title === undefined || request.expectedInvestigationVersion === undefined ? undefined : { value: request.title, expectedInvestigationVersion: request.expectedInvestigationVersion },
        contentHashOf: ({ layout, queryContext, aiNotes }) => contentHashOf({ layout, queryContext }, request.notes, aiNotes),
      });
      if (result.outcome === 'not-found') throw new AppError('NOT_FOUND');
      if (result.outcome === 'read-only') throw readOnlyRefusal(result.status);
      if (result.outcome === 'draft-conflict') throw new AppError('CONFLICTED_VIEW_VERSION');
      if (result.outcome === 'investigation-conflict') throw new AppError('CONFLICT');
      const { investigation } = result;
      return {
        view: result.view,
        draft: result.draft,
        save: result.save,
        ...(investigation === undefined ? {} : { investigation: { title: deps.references.title({ ...stored.investigation, title: investigation.title }), version: investigation.version } }),
      };
    },
    async list({ id, principal, limit, cursor }) {
      if (limit !== undefined && limit < 1) throw new AppError('INVALID_REQUEST');
      if (limit !== undefined && limit > MAX_VIEW_PAGE) throw new AppError('QUERY_BUDGET_EXCEEDED', { maxPage: MAX_VIEW_PAGE });
      if (!UUID.test(id)) throw new AppError('NOT_FOUND');
      const binding = bindingOf(id, principal);
      const position = cursor === undefined ? undefined : positionSchema.safeParse(deps.cursors.verify(cursor, binding));
      if (position !== undefined && !position.success) throw new AppError('CURSOR_INVALIDATED');
      const result = await deps.store.listNamedViews({ investigationId: id, ownerId: principal.id, limit: limit ?? DEFAULT_VIEW_PAGE, after: position?.data });
      if (result.outcome === 'not-found') throw new AppError('NOT_FOUND');
      return {
        items: [...result.items],
        nextCursor: result.next === undefined ? null : deps.cursors.mint(binding, { createdKey: result.next.createdKey, id: result.next.id }),
        count: { value: result.count, quality: 'exact', scope: 'named-views' },
        draft: result.draft,
      };
    },
    async rename({ id, viewId, principal, expectedVersion, name }) {
      if (!UUID.test(id) || !UUID.test(viewId)) throw new AppError('NOT_FOUND');
      await requireWritable(id, principal);
      const result = await deps.store.renameNamedView({ investigationId: id, viewId, ownerId: principal.id, expectedVersion, name });
      if (result.outcome === 'not-found') throw new AppError('NOT_FOUND');
      if (result.outcome === 'read-only') throw readOnlyRefusal(result.status);
      if (result.outcome === 'conflict') throw new AppError('CONFLICTED_VIEW_VERSION');
      return result.view;
    },
    async delete({ id, viewId, principal, expectedVersion, note }) {
      if (!UUID.test(id) || !UUID.test(viewId)) throw new AppError('NOT_FOUND');
      await requireWritable(id, principal);
      const result = await deps.store.deleteNamedView({ investigationId: id, viewId, ownerId: principal.id, expectedVersion, note: note === null || note === '' ? null : note });
      if (result.outcome === 'not-found') throw new AppError('NOT_FOUND');
      if (result.outcome === 'read-only') throw readOnlyRefusal(result.status);
      if (result.outcome === 'conflict') throw new AppError('CONFLICTED_VIEW_VERSION');
      return { id: result.id, version: result.version, deletedAt: result.deletedAt, draft: result.draft, save: result.save, count: { value: result.count, quality: 'exact', scope: 'named-views' } };
    },
    async restore({ id, viewId, principal, expectedDraftVersion }) {
      if (!UUID.test(id) || !UUID.test(viewId)) throw new AppError('NOT_FOUND');
      const stored = await deps.store.readInvestigation(id, principal.id);
      if (stored === undefined) throw new AppError('NOT_FOUND');
      const readOnly = readOnlyStatusOf(stored.investigation.status);
      if (readOnly !== undefined) throw readOnlyRefusal(readOnly);
      const changed = sourceChangedRefusal(sourceStateOf(deps.mapping, stored.investigation));
      if (changed !== undefined) throw changed;
      const result = await deps.store.restoreNamedView({ investigationId: id, viewId, ownerId: principal.id, expectedDraftVersion });
      if (result.outcome === 'not-found') throw new AppError('NOT_FOUND');
      if (result.outcome === 'read-only') throw readOnlyRefusal(result.status);
      if (result.outcome === 'draft-conflict') throw new AppError('CONFLICTED_VIEW_VERSION');
      const { sourceId } = stored.investigation;
      const layout = deps.references.layout(sourceId, layoutDocumentSchema.parse(result.draft.layout));
      const queryContext = deps.references.queryContext(sourceId, queryContextDocumentSchema.parse(result.draft.queryContext));
      return { draft: { version: result.draft.version, layout, queryContext, notes: result.draft.notes, basedOnViewId: result.draft.basedOnViewId }, save: { state: 'saved', savedAt: result.savedAt } };
    },
  };
}

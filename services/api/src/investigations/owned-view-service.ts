import { DEFAULT_VIEW_PAGE, MAX_VIEW_PAGE, type OwnedViewListResponse } from '@neburyx/contracts';
import { z } from 'zod';
import type { InvestigationStore } from '../db/investigations-repository.js';
import type { OwnedViewStore } from '../db/views-list-repository.js';
import { AppError } from '../errors.js';
import type { CursorBinding, CursorCodec } from '../gate/cursor/codec.js';
import type { Principal } from '../seams/seams.js';
import { COMMUNITY_POLICY_VERSION } from './draft.js';
import type { SourceAccess } from './source-access.js';
import type { StoredReferences } from './stored-references.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIST_TARGET = 'GET /v1/views';
const LIST_SORT = 'created-desc';
const positionSchema = z.strictObject({ createdKey: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/), id: z.string().regex(UUID) });

export interface OwnedViewService {
  /** A page of the named views of the caller's investigations, newest first. A `limit` of 0 is `INVALID_REQUEST`; above the maximum it is `QUERY_BUDGET_EXCEEDED`; a cursor that was not made for this caller is `CURSOR_INVALIDATED`. */
  list(call: { readonly principal: Principal; readonly limit: number | undefined; readonly cursor: string | undefined }): Promise<OwnedViewListResponse>;
}

export interface OwnedViewServiceDeps {
  readonly store: InvestigationStore & OwnedViewStore;
  readonly access: SourceAccess;
  readonly references: StoredReferences;
  readonly cursors: CursorCodec;
}

export function createOwnedViewService(deps: OwnedViewServiceDeps): OwnedViewService {
  return {
    async list({ principal, limit, cursor }) {
      if (limit !== undefined && limit < 1) throw new AppError('INVALID_REQUEST');
      if (limit !== undefined && limit > MAX_VIEW_PAGE) throw new AppError('QUERY_BUDGET_EXCEEDED', { maxPage: MAX_VIEW_PAGE });
      const binding: CursorBinding = { source: null, principal: principal.id, policyVersion: COMMUNITY_POLICY_VERSION, filterHash: '', sort: LIST_SORT, target: LIST_TARGET, targetVersion: '1' };
      const position = cursor === undefined ? undefined : positionSchema.safeParse(deps.cursors.verify(cursor, binding));
      if (position !== undefined && !position.success) throw new AppError('CURSOR_INVALIDATED');
      const sourceIds = await deps.access.readable({ principal, sourceIds: await deps.store.readLibrary((reader) => reader.listInvestigationSourceIds(principal.id)) });
      const result = await deps.store.listOwnedViews({ ownerId: principal.id, sourceIds, limit: limit ?? DEFAULT_VIEW_PAGE, after: position?.data });
      return {
        items: result.items.map((view) => ({
          id: view.id,
          name: view.name,
          investigation: { id: view.investigation.id, title: deps.references.title(view.investigation), sourceId: view.investigation.sourceId, sourceAlias: view.investigation.sourceAlias, status: view.investigation.status },
          savedBy: { name: view.savedByName },
          createdAt: view.createdAt,
          version: view.version,
        })),
        nextCursor: result.next === undefined ? null : deps.cursors.mint(binding, { createdKey: result.next.createdKey, id: result.next.id }),
        count: { value: result.count, quality: 'exact', scope: 'named-views' },
      };
    },
  };
}

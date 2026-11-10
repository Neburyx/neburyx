import { DEFAULT_INVESTIGATION_LIST_LIMIT, MAX_DRAFT_DOCUMENT_BYTES, investigationResponseSchema, layoutDocumentSchema, MAX_TITLE_LENGTH, queryContextDocumentSchema, type GraphNode, type Investigation, type InvestigationListResponse, type DraftWriteRequest, type DraftWriteResponse, type InvestigationResponse, type InvestigationSourceState, type MappingChange, type ReferenceOpenRequest, type OpenInvestigationResponse, type RenameResponse, type StatusChangeResponse, type Investigation as InvestigationShown } from '@neburyx/contracts';
import { AppError } from '../errors.js';
import type { InvestigationRow, InvestigationStore, ListedInvestigation } from '../db/investigations-repository.js';
import type { EntityReader } from '../entities/entity-reader.js';
import { uuidv7 } from '../identity/uuid.js';
import { isKeyed, type EntityModel, type MappingModel, type SourceModel } from '../mapping/model.js';
import { isStorableText, storableOf } from '../reference/well-formed.js';
import { identityHashOf } from '../registry/identity-hash.js';
import type { AuditSink, Principal } from '../seams/seams.js';
import type { SourceAccess } from './source-access.js';
import { droppedFiltersOf, unmappedItemsOf, withoutDropped } from './mapping-change.js';
import type { StoredReferences } from './stored-references.js';
import { readOnlyRefusal, readOnlyStatusOf } from './read-only.js';
import { auditActionOf } from './status-change.js';
import { COMMUNITY_POLICY_VERSION, contentHashOf, defaultTitle, initialDraftDocuments } from './draft.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface OpenCall {
  readonly traceId: string;
  readonly principal: Principal;
  /** The entity is already a reference: the route turns a raw value into one before the service runs. */
  readonly request: ReferenceOpenRequest;
  /** Aborted when the client gives up the request. */
  readonly signal?: AbortSignal;
}

export interface OpenAnswer {
  readonly created: boolean;
  readonly body: OpenInvestigationResponse;
}

export interface InvestigationService {
  open(call: OpenCall): Promise<OpenAnswer>;
  read(call: { readonly id: string; readonly principal: Principal }): Promise<InvestigationResponse>;
  list(call: { readonly principal: Principal; readonly limit?: number }): Promise<InvestigationListResponse>;
  /** Replaces the caller's draft when `expectedVersion` is the draft's version; `CONFLICTED_VIEW_VERSION` when it is not. */
  saveDraft(call: { readonly id: string; readonly principal: Principal; readonly expectedVersion: number; readonly draft: DraftWriteRequest }): Promise<DraftWriteResponse>;
  /** Stores the title as typed when `expectedVersion` is the investigation's version; a closed or archived investigation is refused first. */
  rename(call: { readonly id: string; readonly principal: Principal; readonly expectedVersion: number; readonly title: string }): Promise<RenameResponse>;
  /** Closes, archives or reopens the investigation, with one audit event; if the event cannot be recorded nothing changes. */
  changeStatus(call: { readonly traceId: string; readonly id: string; readonly principal: Principal; readonly expectedVersion: number; readonly status: InvestigationShown['status'] }): Promise<StatusChangeResponse>;
}

export interface InvestigationServiceDeps {
  readonly store: InvestigationStore;
  readonly entities: EntityReader;
  readonly mapping: MappingModel;
  readonly access: SourceAccess;
  /** Converts the IDs a stored investigation holds to the references the API returns now. */
  readonly references: StoredReferences;
  readonly audit: AuditSink;
}

function sourceStateOf(mapping: MappingModel, row: InvestigationRow): InvestigationSourceState {
  const source = mapping.sources.find((candidate) => candidate.id === row.sourceId);
  if (source === undefined) return 'removed';
  return identityHashOf(source) === row.sourceIdentityHash ? 'available' : 'repointed';
}

function shown(mapping: MappingModel, references: StoredReferences, row: InvestigationRow): Investigation {
  const entity = row.startingEntityType === null || row.startingStableId === null ? null : { entityType: row.startingEntityType, stableId: references.entityId(row.sourceId, row.startingEntityType, row.startingStableId) };
  return {
    id: row.id,
    sourceId: row.sourceId,
    title: references.title(row),
    caseRef: row.caseRef,
    status: row.status,
    startingEntity: entity,
    sourceState: sourceStateOf(mapping, row),
    createdAt: row.createdAt,
    lastEditedAt: row.lastEditedAt,
    version: row.version,
  };
}

function sourceOf(mapping: MappingModel, request: ReferenceOpenRequest): SourceModel {
  const source = mapping.sources.find((candidate) => candidate.id === request.sourceId);
  if (source === undefined) throw new AppError('NOT_FOUND');
  if (request.entity.sourceId !== request.sourceId) throw new AppError('SOURCE_MISMATCH');
  return source;
}

function entityTypeOf(source: SourceModel, request: ReferenceOpenRequest): EntityModel {
  const type = source.entities.find((candidate) => candidate.type === request.entity.entityType);
  if (type === undefined) throw new AppError('INVALID_REQUEST');
  return type;
}

/** What the answer says of an investigation: with the entity that was read when its source is as it was, and without one when it is not, since nothing is read from a source that changed. */
function answerOf(investigation: Investigation, created: boolean, entity: GraphNode | undefined, draftVersion: number): OpenInvestigationResponse {
  const { sourceState } = investigation;
  if (sourceState === 'available') {
    if (entity === undefined) throw new Error('an available investigation is answered with its entity');
    return { investigation: { ...investigation, sourceState }, created, entity, draft: { version: draftVersion } };
  }
  return { investigation: { ...investigation, sourceState }, created: false, draft: { version: draftVersion } };
}

export function createInvestigationService(deps: InvestigationServiceDeps): InvestigationService {
  const readEntity = (call: OpenCall) => deps.entities.read({ traceId: call.traceId, principal: call.principal, sourceId: call.request.sourceId, entityType: call.request.entity.entityType, stableId: call.request.entity.stableId, mask: call.request.mask === true, ...(call.signal === undefined ? {} : { signal: call.signal }) });

  /** What follows the type's name in a generated title: the stable ID of a type that is not keyed, and for a keyed type the node's masked display title, so that neither the value nor its token is in a title. */
  async function titleSubjectOf(call: OpenCall, type: EntityModel, entity: GraphNode): Promise<string> {
    if (!isKeyed(type)) return call.request.entity.stableId;
    return call.request.mask === true ? entity.display.title : (await deps.entities.read({ traceId: call.traceId, principal: call.principal, sourceId: call.request.sourceId, entityType: call.request.entity.entityType, stableId: call.request.entity.stableId, mask: true, ...(call.signal === undefined ? {} : { signal: call.signal }) })).display.title;
  }

  async function draftVersionOf(row: InvestigationRow, ownerId: string): Promise<number> {
    const stored = await deps.store.readInvestigation(row.id, ownerId);
    if (stored === undefined) throw new Error('an investigation just written has no draft');
    return stored.draft.version;
  }

  async function create(call: OpenCall, source: SourceModel, type: EntityModel): Promise<OpenAnswer> {
    const { request } = call;
    const entity = await readEntity(call);
    const stored = deps.references.toStored(request.sourceId, request.entity.entityType, request.entity.stableId);
    const documents = initialDraftDocuments({ entityType: request.entity.entityType, stableId: stored });
    const { row, created } = await deps.store.createInvestigation({
      id: uuidv7(),
      sourceId: request.sourceId,
      sourceIdentityHash: identityHashOf(source),
      ownerId: call.principal.id,
      title: defaultTitle(storableOf(type.display.name ?? type.label), storableOf(await titleSubjectOf(call, type, entity)), MAX_TITLE_LENGTH),
      caseRef: request.caseRef ?? null,
      startingEntityType: request.entity.entityType,
      startingStableId: stored,
      draft: { id: uuidv7(), layout: documents.layout, queryContext: documents.queryContext, mappingHash: source.configHash, contentHash: contentHashOf(documents), nodeCount: 1, edgeCount: 0, countsPolicyVersion: COMMUNITY_POLICY_VERSION },
    });
    return { created, body: answerOf(shown(deps.mapping, deps.references, row), created, entity, await draftVersionOf(row, call.principal.id)) };
  }

  return {
    async open(call) {
      const { request } = call;
      await deps.access.require({ traceId: call.traceId, principal: call.principal, sourceId: request.sourceId });
      const source = sourceOf(deps.mapping, request);
      // a reference of a keyed type is a token of this deployment for this source and type before anything is looked up with it, whether or not an earlier investigation is found
      deps.references.authenticate(request.sourceId, request.entity.entityType, request.entity.stableId);
      // the reuse query runs before the type is checked against the mapping, so a type the mapping does not name must at least be text PostgreSQL holds
      if (!isStorableText(request.entity.entityType)) throw new AppError('INVALID_REQUEST');
      deps.access.admit({ traceId: call.traceId, principal: call.principal, sourceId: request.sourceId });
      const reusable = async (stored: string) => (request.caseRef === undefined ? undefined : deps.store.findReusableInvestigation({ ownerId: call.principal.id, sourceId: request.sourceId, caseRef: request.caseRef, entityType: request.entity.entityType, stableId: stored }));
      // the entity is found under the form it is stored in now, and under the form it had before the mapping changed whether the type is keyed
      let existing: InvestigationRow | undefined;
      for (const stored of deps.references.storedForms(request.sourceId, request.entity.entityType, request.entity.stableId)) {
        existing = await reusable(stored);
        if (existing !== undefined) break;
      }
      if (existing === undefined) return create(call, source, entityTypeOf(source, request));
      const investigation = shown(deps.mapping, deps.references, existing);
      // an investigation whose source now points at another database is returned as it is: nothing is read from the new database under the old investigation, and the mapping that replaced the old one need not hold the type
      if (investigation.sourceState !== 'available') return { created: false, body: answerOf(investigation, false, undefined, await draftVersionOf(existing, call.principal.id)) };
      entityTypeOf(source, request);
      const entity = await readEntity(call);
      const type = entityTypeOf(source, request);
      // a generated title that held the value is shown as the masked display title once the node is loaded
      const title = isKeyed(type) && investigation.title === (type.display.name ?? type.label) ? defaultTitle(type.display.name ?? type.label, await titleSubjectOf(call, type, entity), MAX_TITLE_LENGTH) : investigation.title;
      return { created: false, body: answerOf({ ...investigation, title }, false, entity, await draftVersionOf(existing, call.principal.id)) };
    },
    async list({ principal, limit = DEFAULT_INVESTIGATION_LIST_LIMIT }) {
      return deps.store.readLibrary(async (reader) => {
        const sourceIds = await deps.access.readable({ principal, sourceIds: await reader.listInvestigationSourceIds(principal.id) });
        const found = await reader.listInvestigations({ ownerId: principal.id, sourceIds, limit: limit + 1 });
        const counts = await reader.countInvestigations({ ownerId: principal.id, sourceIds });
        const views = await reader.countNamedViews({ ownerId: principal.id, sourceIds });
        const items = found.slice(0, limit).map((row: ListedInvestigation) => ({ ...shown(deps.mapping, deps.references, row), sourceAlias: row.sourceAlias, save: row.save }));
        return {
          items,
          hasMore: found.length > limit,
          counts: {
            investigations: { value: counts.investigations, quality: 'exact' as const, scope: 'investigations' as const },
            sources: { value: counts.sources, quality: 'exact' as const, scope: 'investigation-sources' as const },
            savedViews: { count: { value: views.views, quality: 'exact' as const, scope: 'named-views' as const }, lastEditedAt: views.lastEditedAt },
          },
        };
      });
    },
    async saveDraft({ id, principal, expectedVersion, draft }) {
      if (!UUID.test(id)) throw new AppError('NOT_FOUND');
      const stored = await deps.store.readInvestigation(id, principal.id);
      if (stored === undefined) throw new AppError('NOT_FOUND');
      const readOnly = readOnlyStatusOf(stored.investigation.status);
      if (readOnly !== undefined) throw readOnlyRefusal(readOnly);
      const { sourceId } = stored.investigation;
      const source = deps.mapping.sources.find((candidate) => candidate.id === sourceId);
      if (source === undefined || sourceStateOf(deps.mapping, stored.investigation) !== 'available') throw new AppError('CONFLICT');
      const documents = { layout: deps.references.storedLayout(sourceId, draft.layout), queryContext: deps.references.storedQueryContext(sourceId, draft.queryContext) };
      if ([documents.layout, documents.queryContext].some((document) => Buffer.byteLength(JSON.stringify(document)) > MAX_DRAFT_DOCUMENT_BYTES)) throw new AppError('INVALID_REQUEST');
      const result = await deps.store.saveDraft({
        investigationId: id,
        ownerId: principal.id,
        expectedVersion,
        ...documents,
        notes: draft.notes,
        mappingHash: source.configHash,
        nodeCount: documents.queryContext.loaded.nodes.length,
        edgeCount: documents.queryContext.loaded.edges.length,
        contentHashOf: ({ aiNotes }) => contentHashOf(documents, draft.notes, aiNotes),
      });
      if (result.outcome === 'not-found') throw new AppError('NOT_FOUND');
      if (result.outcome === 'read-only') throw readOnlyRefusal(result.status);
      if (result.outcome === 'conflict') throw new AppError('CONFLICTED_VIEW_VERSION');
      return { version: result.version, save: result.save, notes: draft.notes };
    },
    async rename({ id, principal, expectedVersion, title }) {
      if (!UUID.test(id)) throw new AppError('NOT_FOUND');
      const result = await deps.store.renameInvestigation({ investigationId: id, ownerId: principal.id, expectedVersion, title });
      if (result.outcome === 'not-found') throw new AppError('NOT_FOUND');
      if (result.outcome === 'read-only') throw readOnlyRefusal(result.status);
      if (result.outcome === 'conflict') throw new AppError('CONFLICT');
      return { investigation: shown(deps.mapping, deps.references, result.row) };
    },
    async changeStatus({ traceId, id, principal, expectedVersion, status }) {
      if (!UUID.test(id)) throw new AppError('NOT_FOUND');
      const event = { actorId: principal.id, actorRole: principal.role, action: auditActionOf(status), traceId };
      let result;
      try {
        result = await deps.store.changeInvestigationStatus({ investigationId: id, ownerId: principal.id, expectedVersion, status });
      } catch (error) {
        // the write failed, so the event says so; a sink that cannot take it must not hide the failure of the write
        await deps.audit.record({ ...event, result: 'failed' }).catch(() => undefined);
        throw error;
      }
      if (result.outcome === 'not-found') throw new AppError('NOT_FOUND');
      if (result.outcome === 'conflict') throw new AppError('CONFLICT');
      if (result.outcome === 'not-allowed') throw new AppError('CONFLICT', { reason: 'status-change-not-allowed' });
      if (result.outcome === 'changed') {
        // recorded after the commit, so it never says success for a change that was not made
        await deps.audit.record({ ...event, result: 'success', sourceId: result.row.sourceId }).catch(() => {
          throw new AppError('INTERNAL_ERROR');
        });
      }
      return { investigation: { ...shown(deps.mapping, deps.references, result.row), closedAt: result.row.closedAt, archivedAt: result.row.archivedAt } };
    },
    async read({ id, principal }) {
      if (!UUID.test(id)) throw new AppError('NOT_FOUND');
      const stored = await deps.store.readInvestigation(id, principal.id);
      if (stored === undefined) throw new AppError('NOT_FOUND');
      const sourceId = stored.investigation.sourceId;
      const investigation = shown(deps.mapping, deps.references, stored.investigation);
      const storedLayout = layoutDocumentSchema.parse(stored.draft.layout);
      const storedContext = queryContextDocumentSchema.parse(stored.draft.queryContext);
      const layout = deps.references.layout(sourceId, storedLayout);
      let queryContext = deps.references.queryContext(sourceId, storedContext);
      const source = investigation.sourceState === 'available' ? deps.mapping.sources.find((candidate) => candidate.id === sourceId) : undefined;
      // the check compares the mapping only: nothing is read from the source, and a source that was removed or re-pointed is not judged here
      const unmapped = source === undefined ? undefined : unmappedItemsOf(source, layout, queryContext);
      let mappingChange: MappingChange | undefined;
      if (source !== undefined && stored.draft.mappingHash !== source.configHash) {
        const droppedFilters = droppedFiltersOf(source, storedContext.filters);
        queryContext = withoutDropped(queryContext, droppedFilters);
        mappingChange = { droppedFilters };
      }
      return investigationResponseSchema.parse({
        investigation,
        draft: { version: stored.draft.version, layout, queryContext, notes: stored.draft.notes },
        ...(unmapped === undefined ? {} : { unmapped }),
        ...(mappingChange === undefined ? {} : { mappingChange }),
      });
    },
  };
}

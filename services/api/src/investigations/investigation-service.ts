import { investigationResponseSchema, layoutDocumentSchema, MAX_TITLE_LENGTH, queryContextDocumentSchema, type GraphNode, type Investigation, type InvestigationResponse, type InvestigationSourceState, type OpenInvestigationRequest, type OpenInvestigationResponse } from '@neburyx/contracts';
import { AppError } from '../errors.js';
import type { InvestigationRow, InvestigationStore } from '../db/investigations-repository.js';
import type { EntityReader } from '../entities/entity-reader.js';
import { uuidv7 } from '../identity/uuid.js';
import type { EntityModel, MappingModel, SourceModel } from '../mapping/model.js';
import { identityHashOf } from '../registry/identity-hash.js';
import type { Principal } from '../seams/seams.js';
import { COMMUNITY_POLICY_VERSION, contentHashOf, defaultTitle, initialDraftDocuments } from './draft.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface OpenCall {
  readonly traceId: string;
  readonly principal: Principal;
  readonly request: OpenInvestigationRequest;
}

export interface OpenAnswer {
  readonly created: boolean;
  readonly body: OpenInvestigationResponse;
}

export interface InvestigationService {
  open(call: OpenCall): Promise<OpenAnswer>;
  read(call: { readonly id: string; readonly principal: Principal }): Promise<InvestigationResponse>;
}

export interface InvestigationServiceDeps {
  readonly store: InvestigationStore;
  readonly entities: EntityReader;
  readonly mapping: MappingModel;
}

function sourceStateOf(mapping: MappingModel, row: InvestigationRow): InvestigationSourceState {
  const source = mapping.sources.find((candidate) => candidate.id === row.sourceId);
  if (source === undefined) return 'removed';
  return identityHashOf(source) === row.sourceIdentityHash ? 'available' : 'repointed';
}

function shown(mapping: MappingModel, row: InvestigationRow): Investigation {
  const entity = row.startingEntityType === null || row.startingStableId === null ? null : { entityType: row.startingEntityType, stableId: row.startingStableId };
  return {
    id: row.id,
    sourceId: row.sourceId,
    title: row.title,
    caseRef: row.caseRef,
    status: row.status,
    startingEntity: entity,
    sourceState: sourceStateOf(mapping, row),
    createdAt: row.createdAt,
    lastEditedAt: row.lastEditedAt,
    version: row.version,
  };
}

function sourceOf(mapping: MappingModel, request: OpenInvestigationRequest): SourceModel {
  const source = mapping.sources.find((candidate) => candidate.id === request.sourceId);
  if (source === undefined) throw new AppError('NOT_FOUND');
  if (request.entity.sourceId !== request.sourceId) throw new AppError('SOURCE_MISMATCH');
  return source;
}

function entityTypeOf(source: SourceModel, request: OpenInvestigationRequest): EntityModel {
  const type = source.entities.find((candidate) => candidate.type === request.entity.entityType);
  if (type === undefined) throw new AppError('INVALID_REQUEST');
  return type;
}

/** What the answer says of an investigation: with the entity that was read when its source is as it was, and without one when it is not, since nothing is read from a source that changed. */
function answerOf(investigation: Investigation, created: boolean, entity: GraphNode | undefined): OpenInvestigationResponse {
  const { sourceState } = investigation;
  if (sourceState === 'available') {
    if (entity === undefined) throw new Error('an available investigation is answered with its entity');
    return { investigation: { ...investigation, sourceState }, created, entity };
  }
  return { investigation: { ...investigation, sourceState }, created: false };
}

export function createInvestigationService(deps: InvestigationServiceDeps): InvestigationService {
  const readEntity = (call: OpenCall) => deps.entities.read({ traceId: call.traceId, principal: call.principal, sourceId: call.request.sourceId, entityType: call.request.entity.entityType, stableId: call.request.entity.stableId, mask: call.request.mask === true });

  async function create(call: OpenCall, source: SourceModel, type: EntityModel): Promise<OpenAnswer> {
    const { request } = call;
    const entity = await readEntity(call);
    const documents = initialDraftDocuments(request.entity);
    const { row, created } = await deps.store.createInvestigation({
      id: uuidv7(),
      sourceId: request.sourceId,
      sourceIdentityHash: identityHashOf(source),
      ownerId: call.principal.id,
      title: defaultTitle(type.display.name ?? type.label, request.entity.stableId, MAX_TITLE_LENGTH),
      caseRef: request.caseRef ?? null,
      startingEntityType: request.entity.entityType,
      startingStableId: request.entity.stableId,
      draft: { id: uuidv7(), layout: documents.layout, queryContext: documents.queryContext, mappingHash: source.configHash, contentHash: contentHashOf(documents), nodeCount: 1, edgeCount: 0, countsPolicyVersion: COMMUNITY_POLICY_VERSION },
    });
    return { created, body: answerOf(shown(deps.mapping, row), created, entity) };
  }

  return {
    async open(call) {
      const { request } = call;
      const source = sourceOf(deps.mapping, request);
      const existing = request.caseRef === undefined ? undefined : await deps.store.findReusableInvestigation({ ownerId: call.principal.id, sourceId: request.sourceId, caseRef: request.caseRef, entityType: request.entity.entityType, stableId: request.entity.stableId });
      if (existing === undefined) return create(call, source, entityTypeOf(source, request));
      const investigation = shown(deps.mapping, existing);
      // an investigation whose source now points at another database is returned as it is: nothing is read from the new database under the old investigation, and the mapping that replaced the old one need not hold the type
      if (investigation.sourceState !== 'available') return { created: false, body: answerOf(investigation, false, undefined) };
      entityTypeOf(source, request);
      return { created: false, body: answerOf(investigation, false, await readEntity(call)) };
    },
    async read({ id, principal }) {
      if (!UUID.test(id)) throw new AppError('NOT_FOUND');
      const stored = await deps.store.readInvestigation(id, principal.id);
      if (stored === undefined) throw new AppError('NOT_FOUND');
      const layout = layoutDocumentSchema.parse(stored.draft.layout);
      const queryContext = queryContextDocumentSchema.parse(stored.draft.queryContext);
      return investigationResponseSchema.parse({ investigation: shown(deps.mapping, stored.investigation), draft: { version: stored.draft.version, layout, queryContext } });
    },
  };
}

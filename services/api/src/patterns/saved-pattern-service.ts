import { z } from 'zod';
import { retentionOf } from '../mapping/retention.js';
import { DEFAULT_PATTERN_LIST_LIMIT, MAX_PATTERN_LIST_LIMIT, patternDefinitionSchema, type AuditSink, type ChangePatternRequest, type DeletePatternResponse, type PatternDefinition, type PatternListResponse, type SavedPattern, type SavePatternRequest } from '@neburyx/contracts';
import type { NewPattern, PatternChange, PatternRow, PatternStore } from '../db/patterns-repository.js';
import { AppError } from '../errors.js';
import type { CursorBinding, CursorCodec } from '../gate/cursor/codec.js';
import { COMMUNITY_POLICY_VERSION } from '../investigations/draft.js';
import type { SourceAccess } from '../investigations/source-access.js';
import type { StoredReferences } from '../investigations/stored-references.js';
import type { MappingModel, PresetModel, SourceModel } from '../mapping/model.js';
import type { Principal } from '../seams/seams.js';
import { validatePattern } from './validate.js';
import { availabilityOf } from './availability.js';
import { presetTemplateOf } from './preset-template.js';

/** The audit action of a source the person may not read, for a save. */
export const PATTERN_SAVE_AUDIT_ACTION = 'pattern.save';
/** The audit action of a source the person may not read, for a list. */
export const PATTERN_LIST_AUDIT_ACTION = 'pattern.list';
/** The audit actions of a source the person may not read, for a change and a delete. */
export const PATTERN_CHANGE_AUDIT_ACTION = 'pattern.change';
export const PATTERN_DELETE_AUDIT_ACTION = 'pattern.delete';

export interface SavePatternCall {
  readonly traceId: string;
  readonly principal: Principal;
  readonly request: SavePatternRequest;
}

export interface ListPatternsCall {
  readonly traceId: string;
  readonly principal: Principal;
  readonly sourceId: string;
  readonly limit: number | undefined;
  readonly cursor: string | undefined;
}

export interface ChangePatternCall {
  readonly traceId: string;
  readonly principal: Principal;
  readonly id: string;
  readonly request: ChangePatternRequest;
}

export interface DeletePatternCall {
  readonly traceId: string;
  readonly principal: Principal;
  readonly id: string;
  readonly expectedVersion: number;
}

export interface SavedPatternService {
  /** Renames the caller's pattern or changes what it holds. Another person's pattern, a deleted one and an id that is not a pattern's are `NOT_FOUND`; a stale version is `CONFLICT`; what save would refuse is `INVALID_REQUEST`. */
  change(call: ChangePatternCall): Promise<SavedPattern>;
  /** Deletes the caller's pattern (soft: it is purged after the retention period). */
  delete(call: DeletePatternCall): Promise<DeletePatternResponse>;
  save(call: SavePatternCall): Promise<SavedPattern>;
  /** A page of the caller's own patterns on a source. A limit of 0 is `INVALID_REQUEST`, above the maximum `QUERY_BUDGET_EXCEEDED`, and a cursor that was not made for this call `CURSOR_INVALIDATED`. */
  list(call: ListPatternsCall): Promise<PatternListResponse>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIST_TARGET = 'GET /v1/patterns';
const LIST_SORT = 'updated-desc';
const positionSchema = z.strictObject({ updatedKey: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/), id: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i) });

/** A pattern as the person is shown it: the starting entity as a reference is shown elsewhere. */
export function shownPattern(references: StoredReferences, row: PatternRow): SavedPattern {
  const anchor = row.anchorEntityType === null || row.anchorStableId === null ? null : { entityType: row.anchorEntityType, stableId: references.entityId(row.sourceId, row.anchorEntityType, row.anchorStableId) };
  const common = { id: row.id, sourceId: row.sourceId, name: row.name, askForStartingEntity: row.askForStartingEntity, anchor, visibility: row.visibility, lastRunAt: row.lastRunAt, createdAt: row.createdAt, updatedAt: row.updatedAt, version: row.version };
  if (row.kind === 'definition') return { ...common, kind: 'definition', definition: { ...(row.definition ?? {}) } };
  return { ...common, kind: 'preset-run', presetId: row.presetId ?? '', templateId: row.templateId ?? '', templateVersion: row.templateVersion ?? 1, params: { ...(row.params ?? {}) } };
}

/** A template's version is text in code and an integer of 1 or more in a saved pattern. */
export function templateVersionNumber(version: string): number {
  if (!/^[1-9]\d*$/.test(version)) throw new Error('a template version is an integer of 1 or more');
  return Number.parseInt(version, 10);
}

/** Whether a condition of the definition is on a personal-data property of the type the step arrives at: a stored pattern keeps no such value. A keyed type's stable id is one (it is a `pii` property). */
function holdsPersonalCondition(definition: PatternDefinition, source: SourceModel): boolean {
  const entities = new Map(source.entities.map((entity) => [entity.type, entity]));
  return definition.steps.some((step) => (step.conditions ?? []).some((condition) => condition.on === 'neighbor' && (entities.get(step.arrivesAt)?.pii ?? []).includes(condition.property)));
}

export function createSavedPatternService(deps: { readonly store: PatternStore; readonly mapping: MappingModel; readonly access: SourceAccess; readonly references: StoredReferences; readonly audit: AuditSink; readonly cursors: CursorCodec }): SavedPatternService {
  function sourceOf(sourceId: string): SourceModel {
    const source = deps.mapping.sources.find((candidate) => candidate.id === sourceId);
    if (source === undefined) throw new AppError('NOT_FOUND');
    return source;
  }

  /** The held starting entity as it is stored: of the type the pattern starts at, a type the mapping names, and a keyed type's id only as a token of this deployment. */
  function storedAnchor(source: SourceModel, startType: string, anchor: { readonly entityType: string; readonly stableId: string }): { readonly entityType: string; readonly stableId: string } {
    if (anchor.entityType !== startType || !source.entities.some((entity) => entity.type === anchor.entityType)) throw new AppError('INVALID_REQUEST');
    deps.references.authenticate(source.id, anchor.entityType, anchor.stableId);
    return { entityType: anchor.entityType, stableId: deps.references.toStored(source.id, anchor.entityType, anchor.stableId) };
  }

  /** A definition as it may be stored: valid for the source, and with no condition on personal data. The problems are not listed here: the client asks the validate route for them. */
  function checkedDefinition(input: unknown, source: SourceModel): PatternDefinition {
    if (validatePattern(input, source, { mask: false }).length > 0) throw new AppError('INVALID_REQUEST');
    const definition = patternDefinitionSchema.parse(input);
    if (holdsPersonalCondition(definition, source)) throw new AppError('INVALID_REQUEST', { reason: 'pattern-personal-condition' });
    return definition;
  }

  function checkedPresetParams(preset: PresetModel, params: unknown): void {
    // a preset names the types and the relationship, and the starting entity is held apart: the run refuses what they would name again, so a pattern that holds them could never run
    if (!presetTemplateOf(preset).schema.safeParse(params).success) throw new AppError('INVALID_REQUEST');
  }

  function definitionOf(request: Extract<SavePatternRequest, { kind: 'definition' }>, source: SourceModel): NewPattern {
    const definition = checkedDefinition(request.definition, source);
    return {
      sourceId: source.id,
      name: request.name.trim(),
      kind: 'definition',
      presetId: null,
      templateId: null,
      templateVersion: null,
      params: null,
      definition,
      anchor: request.anchor === undefined ? null : storedAnchor(source, definition.anchorType, request.anchor),
    };
  }

  function presetRunOf(request: Extract<SavePatternRequest, { kind: 'preset-run' }>, source: SourceModel): NewPattern {
    const preset = source.presets.find((candidate) => candidate.id === request.presetId);
    if (preset === undefined) throw new AppError('INVALID_REQUEST');
    const template = presetTemplateOf(preset);
    checkedPresetParams(preset, request.params);
    const anchorType = preset.bind['anchor'];
    return {
      sourceId: source.id,
      name: request.name.trim(),
      kind: 'preset-run',
      presetId: preset.id,
      templateId: template.templateId,
      templateVersion: templateVersionNumber(template.version),
      params: { ...request.params },
      definition: null,
      anchor: request.anchor === undefined ? null : storedAnchor(source, anchorType ?? '', request.anchor),
    };
  }

  /** The pattern's change against what it is now: the fields of the other kind are refused, and a held entity must be of the type the pattern starts at, also when the definition changes under it. */
  function changeOf(row: PatternRow, source: SourceModel, request: ChangePatternRequest): Omit<PatternChange, 'id' | 'ownerId' | 'expectedVersion'> {
    if (request.name === undefined && request.definition === undefined && request.params === undefined && request.anchor === undefined) throw new AppError('INVALID_REQUEST');
    if ((row.kind === 'definition' && request.params !== undefined) || (row.kind === 'preset-run' && request.definition !== undefined)) throw new AppError('INVALID_REQUEST');
    let startType: string | undefined;
    let definition: PatternDefinition | undefined;
    if (row.kind === 'definition') {
      definition = request.definition === undefined ? undefined : checkedDefinition(request.definition, source);
      startType = definition?.anchorType ?? patternDefinitionSchema.parse(row.definition).anchorType;
    } else {
      // a rename, and clearing the held entity, need no preset: a pattern whose preset the mapping lost can still be renamed
      if (request.params !== undefined || (request.anchor !== undefined && request.anchor !== null)) {
        const preset = source.presets.find((candidate) => candidate.id === row.presetId);
        if (preset === undefined) throw new AppError('INVALID_REQUEST');
        if (request.params !== undefined) checkedPresetParams(preset, request.params);
        startType = preset.bind['anchor'];
      }
    }
    // a held entity that the new definition no longer starts at is refused unless the same request replaces or clears it
    if (definition !== undefined && request.anchor === undefined && row.anchorEntityType !== null && row.anchorEntityType !== definition.anchorType) throw new AppError('INVALID_REQUEST');
    const anchor = request.anchor === undefined || request.anchor === null ? request.anchor : storedAnchor(source, startType ?? '', request.anchor);
    return {
      ...(request.name === undefined ? {} : { name: request.name.trim() }),
      ...(definition === undefined ? {} : { definition }),
      ...(request.params === undefined ? {} : { params: { ...request.params } }),
      ...(anchor === undefined ? {} : { anchor }),
    };
  }

  const bindingOf = (sourceId: string, principal: Principal): CursorBinding => ({ source: sourceId, principal: principal.id, policyVersion: COMMUNITY_POLICY_VERSION, filterHash: sourceId, sort: LIST_SORT, target: LIST_TARGET, targetVersion: '1' });

  return {
    async change({ traceId, principal, id, request }) {
      if (!UUID.test(id)) throw new AppError('NOT_FOUND');
      const row = await deps.store.readPattern(id, principal.id);
      if (row === undefined) throw new AppError('NOT_FOUND');
      await deps.access.require({ traceId, principal, sourceId: row.sourceId, auditAction: PATTERN_CHANGE_AUDIT_ACTION });
      const source = sourceOf(row.sourceId);
      // the version is looked at before what the request holds, as for an investigation
      if (row.version !== request.expectedVersion) throw new AppError('CONFLICT');
      const changes = changeOf(row, source, request);
      const result = await deps.store.changePattern({ id, ownerId: principal.id, expectedVersion: request.expectedVersion, ...changes }, { principal, traceId, audit: deps.audit });
      if (result.outcome === 'not-found') throw new AppError('NOT_FOUND');
      if (result.outcome === 'conflict') throw new AppError('CONFLICT');
      return shownPattern(deps.references, result.row);
    },
    async delete({ traceId, principal, id, expectedVersion }) {
      if (!UUID.test(id)) throw new AppError('NOT_FOUND');
      const row = await deps.store.readPattern(id, principal.id);
      if (row === undefined) throw new AppError('NOT_FOUND');
      await deps.access.require({ traceId, principal, sourceId: row.sourceId, auditAction: PATTERN_DELETE_AUDIT_ACTION });
      const result = await deps.store.deletePattern({ id, ownerId: principal.id, expectedVersion, retentionDays: retentionOf(deps.mapping).deletedInvestigationsDays }, { principal, traceId, audit: deps.audit });
      if (result.outcome === 'not-found') throw new AppError('NOT_FOUND');
      if (result.outcome === 'conflict') throw new AppError('CONFLICT');
      return { id: result.row.id, version: result.row.version, deletedAt: result.deletedAt, purgeAfter: result.purgeAfter };
    },
    async list({ traceId, principal, sourceId, limit, cursor }) {
      if (limit !== undefined && limit < 1) throw new AppError('INVALID_REQUEST');
      if (limit !== undefined && limit > MAX_PATTERN_LIST_LIMIT) throw new AppError('QUERY_BUDGET_EXCEEDED', { maxPage: MAX_PATTERN_LIST_LIMIT });
      await deps.access.require({ traceId, principal, sourceId, auditAction: PATTERN_LIST_AUDIT_ACTION });
      const source = sourceOf(sourceId);
      const binding = bindingOf(sourceId, principal);
      const position = cursor === undefined ? undefined : positionSchema.safeParse(deps.cursors.verify(cursor, binding));
      if (position !== undefined && !position.success) throw new AppError('CURSOR_INVALIDATED');
      const page = limit ?? DEFAULT_PATTERN_LIST_LIMIT;
      const found = await deps.store.listPatterns({ ownerId: principal.id, sourceId, limit: page, after: position?.data });
      return { items: found.rows.map((row) => ({ ...shownPattern(deps.references, row), availability: availabilityOf(row, source) })), nextCursor: found.next === undefined ? null : deps.cursors.mint(binding, { updatedKey: found.next.updatedKey, id: found.next.id }) };
    },
    async save({ traceId, principal, request }) {
      await deps.access.require({ traceId, principal, sourceId: request.sourceId, auditAction: PATTERN_SAVE_AUDIT_ACTION });
      const source = sourceOf(request.sourceId);
      const pattern = request.kind === 'definition' ? definitionOf(request, source) : presetRunOf(request, source);
      const result = await deps.store.savePattern(pattern, { principal, traceId, audit: deps.audit });
      if (result.outcome === 'limit') throw new AppError('INVALID_REQUEST', { reason: 'pattern-limit' });
      return shownPattern(deps.references, result.row);
    },
  };
}

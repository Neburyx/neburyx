import type { Count, DegreeByType, DegreePreview } from '@neburyx/contracts';
import { AppError } from '../errors.js';
import type { EntityReader } from '../entities/entity-reader.js';
import { entityLoadTemplate } from '../gate/templates/entity-load.js';
import { DEGREE_PREVIEW_BOUNDED_ID, DEGREE_PREVIEW_CHEAP_ID, degreePreviewBoundedTemplate, type DegreeItem, type DegreeValue } from '../gate/templates/degree-preview.js';
import { degreePairsOf, type DegreePair } from '../gate/templates/degree-pairs.js';
import type { Gate } from '../gate/types.js';
import type { SourceAccess } from '../investigations/source-access.js';
import type { MappingModel, SourceModel } from '../mapping/model.js';
import type { AuditSink, Principal } from '../seams/seams.js';
import type { DegreeVerdicts } from '../source-test/usability.js';
import type { DegreeCache } from './degree-cache.js';
import { sumOf } from './degree-sum.js';
import { neighborCountsOf, SCOPE_SUFFIX } from './neighbor-counts.js';

export interface DegreePreviewRequest {
  readonly traceId: string;
  readonly principal: Principal;
  readonly sourceId: string;
  readonly entityType: string;
  readonly stableId: string;
  readonly mask: boolean;
}

export interface DegreePreviewService {
  preview(request: DegreePreviewRequest): Promise<DegreePreview>;
}

const ONE_ROW = 1;
const TOTAL_SCOPE = `degree:total:${SCOPE_SUFFIX}`;
const CAPPED_REASON = 'Counts are capped for this entity type';
const IGNORED_REASON = 'A degree property of the source was not used: its value is not a usable count';
const DUPLICATE_REASON = 'More than one node has this stable ID; the first by element ID is counted';

const countOfValue = (value: DegreeValue, scope: string): Count => ({ value: value.value, quality: value.quality, scope, ...(value.observedAt === undefined ? {} : { observedAt: value.observedAt }) });

/** The entity types at the other end of the mapping rows of a pair, each once, in the order of the rows. */
function neighborTypesOf(source: SourceModel, entityType: string, pair: DegreePair): string[] {
  const ends = source.relationships.filter((row) => row.type === pair.relationshipType && (pair.direction === 'out' ? row.from === entityType : row.to === entityType)).map((row) => (pair.direction === 'out' ? row.to : row.from));
  return [...new Set(ends)];
}

function emptyPreviewOf(request: DegreePreviewRequest, pageSize: number, heavyOpThreshold: number): DegreePreview {
  return { ref: { sourceId: request.sourceId, entityType: request.entityType, stableId: request.stableId }, total: { value: 0, quality: 'exact', scope: TOTAL_SCOPE }, byType: [], byNeighborType: [], warnings: [], pageSize, heavyOpThreshold };
}

function previewOf(request: DegreePreviewRequest, source: SourceModel, pairs: readonly DegreePair[], item: Extract<DegreeItem, { found: true }>, capped: boolean): DegreePreview {
  const byType: DegreeByType[] = pairs.map((pair, index) => {
    const value = item.counts[index];
    if (value === undefined) throw new AppError('INTERNAL_ERROR');
    return { relationshipType: pair.relationshipType, direction: pair.direction, count: countOfValue(value, `degree:${pair.direction}:${pair.relationshipType}:${SCOPE_SUFFIX}`), neighborTypes: neighborTypesOf(source, request.entityType, pair) };
  });
  const floors = item.counts.map((value) => value.provenFloor);
  const cappedWarnings = capped ? pairs.map((pair) => ({ code: 'counts-capped' as const, relationshipType: pair.relationshipType, reason: CAPPED_REASON })) : [];
  const ignoredTypes = [...new Set(pairs.flatMap((pair, index) => (item.counts[index]?.propertyIgnored === true ? [pair.relationshipType] : [])))];
  const ignored = ignoredTypes.map((relationshipType) => ({ code: 'degree-property-ignored' as const, relationshipType, reason: IGNORED_REASON }));
  const duplicate = item.duplicate ? [{ code: 'duplicate-stable-id' as const, reason: DUPLICATE_REASON }] : [];
  return {
    ref: { sourceId: request.sourceId, entityType: request.entityType, stableId: request.stableId },
    total: sumOf(byType.map((entry) => entry.count), TOTAL_SCOPE, floors),
    byType,
    byNeighborType: neighborCountsOf(byType, floors),
    warnings: [...cappedWarnings, ...ignored, ...duplicate],
    pageSize: source.budgets.defaultPage,
    heavyOpThreshold: source.budgets.heavyOpThreshold,
  };
}

export function createDegreePreviewService(deps: { readonly gate: Gate; readonly mapping: MappingModel; readonly access: SourceAccess; readonly entities: EntityReader; readonly verdicts: DegreeVerdicts; readonly cache?: { readonly store: DegreeCache; readonly audit: AuditSink; readonly logger: { warn(fields: object, message: string): void } } }): DegreePreviewService {
  return {
    async preview(request) {
      await deps.access.require({ traceId: request.traceId, principal: request.principal, sourceId: request.sourceId, auditAction: degreePreviewBoundedTemplate.auditAction, rate: 'count' });
      const source = deps.mapping.sources.find((candidate) => candidate.id === request.sourceId);
      if (source === undefined || !source.entities.some((entity) => entity.type === request.entityType)) throw new AppError('NOT_FOUND');
      const pairs = degreePairsOf(source.relationships, request.entityType);
      const revision = deps.verdicts.revisionOf(request.sourceId);
      const key = { sourceId: request.sourceId, configHash: source.configHash, principalId: request.principal.id, entityType: request.entityType, stableId: request.stableId, mask: request.mask, verdictRevision: revision };
      const held = deps.cache?.store.get(key);
      if (deps.cache !== undefined && held !== undefined) {
        // a served answer skips the gate, so it keeps the gate's audit event
        await recordHit(deps.cache, request, pairs.length === 0 ? entityLoadTemplate.auditAction : degreePreviewBoundedTemplate.auditAction);
        return held;
      }
      const answered = pairs.length === 0 ? await emptyPreview(deps.entities, request, source.budgets.defaultPage, source.budgets.heavyOpThreshold) : await countedPreview(deps, request, source, pairs);
      // an answer read under a verdict that has since changed is returned to its caller and not kept
      if (deps.cache !== undefined && deps.verdicts.revisionOf(request.sourceId) === revision) deps.cache.store.set(key, answered);
      return answered;
    },
  };
}

/** An entity type with no mapped relationship has nothing to count, but the node must exist, which the entity read tells. */
async function emptyPreview(entities: EntityReader, request: DegreePreviewRequest, pageSize: number, heavyOpThreshold: number): Promise<DegreePreview> {
  const node = await entities.read(request);
  const duplicate = node.qualityFlags.includes('duplicate-stable-id') ? [{ code: 'duplicate-stable-id' as const, reason: DUPLICATE_REASON }] : [];
  return { ...emptyPreviewOf(request, pageSize, heavyOpThreshold), warnings: duplicate };
}

async function countedPreview(deps: { readonly gate: Gate; readonly verdicts: DegreeVerdicts }, request: DegreePreviewRequest, source: SourceModel, pairs: readonly DegreePair[]): Promise<DegreePreview> {
  const cheap = deps.verdicts.isCheap(request.sourceId, request.entityType, pairs.map((pair) => pair.relationshipType));
  const item = await readThroughGate(deps.gate, request, cheap ? DEGREE_PREVIEW_CHEAP_ID : DEGREE_PREVIEW_BOUNDED_ID);
  if (!item.found) throw new AppError('NOT_FOUND');
  return previewOf(request, source, pairs, item, !cheap);
}

function isDegreeItem(item: unknown): item is DegreeItem {
  return typeof item === 'object' && item !== null && 'found' in item && typeof item.found === 'boolean';
}

/** A read the gate refuses answers the same `NOT_FOUND` as a source the person may not read, so the two are never told apart; the gate has already recorded the denial. */
async function readThroughGate(gate: Gate, request: DegreePreviewRequest, templateId: string): Promise<DegreeItem> {
  try {
    const page = await gate.run({
      traceId: request.traceId,
      principal: request.principal,
      sourceId: request.sourceId,
      templateId,
      params: { entityType: request.entityType, stableId: request.stableId },
      limit: ONE_ROW,
      mask: request.mask,
    });
    const [item] = page.items;
    if (!isDegreeItem(item)) throw new AppError('INTERNAL_ERROR');
    return item;
  } catch (error) {
    if (error instanceof AppError && error.code === 'ACCESS_DENIED') throw new AppError('NOT_FOUND');
    throw error;
  }
}

/** A hit records the action its miss would have: the degree read's, or the entity read's for an entity type with no mapped relationship. */
async function recordHit(cache: NonNullable<Parameters<typeof createDegreePreviewService>[0]['cache']>, request: DegreePreviewRequest, action: string): Promise<void> {
  try {
    await cache.audit.record({ actorId: request.principal.id, actorRole: request.principal.role, action, result: 'success', sourceId: request.sourceId, traceId: request.traceId });
  } catch {
    // the answer does not depend on the audit write, as for a read through the gate; the log line carries no event data
    cache.logger.warn({ event: 'degree_preview.audit_failed' }, 'degree preview audit write failed');
  }
}

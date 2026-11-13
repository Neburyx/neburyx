import type { FastifyBaseLogger } from 'fastify';
import type { SavedPatternRunResponse } from '@neburyx/contracts';
import type { PatternRow, PatternStore } from '../db/patterns-repository.js';
import { AppError } from '../errors.js';
import { LINKED_ENTITIES_ID, linkedEntitiesTemplate } from '../gate/templates/linked-entities.js';
import { patternTemplate } from '../gate/templates/pattern.js';
import { sharedAttributeTemplate } from '../gate/templates/shared-attribute.js';
import type { TemplateRunService } from '../graph/template-run-service.js';
import type { SourceAccess } from '../investigations/source-access.js';
import type { StoredReferences } from '../investigations/stored-references.js';
import type { MappingModel, SourceModel } from '../mapping/model.js';
import type { Principal } from '../seams/seams.js';
import { availabilityOf, startTypeOf } from './availability.js';
import type { PatternRunService } from './run-service.js';

export interface SavedPatternRunCall {
  readonly traceId: string;
  readonly principal: Principal;
  /** The pattern, as `find` returned it for this caller. */
  readonly pattern: PatternRow;
  /** The starting entity for this run, replacing the one the pattern holds. */
  readonly anchor?: { readonly entityType: string; readonly stableId: string } | undefined;
  readonly limit?: number | undefined;
  readonly mask: boolean;
  readonly continue?: boolean | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface SavedPatternRunService {
  /** The pattern the caller may run: their own, or a shared one. Another person's private pattern, a deleted one, an unknown id and an id that is not a uuid are `NOT_FOUND`. */
  find(call: { readonly principal: Principal; readonly id: string }): Promise<PatternRow>;
  /** Whether a replay may still be answered: the caller still finds the pattern and its source is still configured. */
  stillRunnable(call: { readonly principal: Principal; readonly id: string; readonly sourceId: string }): Promise<boolean>;
  run(call: SavedPatternRunCall): Promise<SavedPatternRunResponse>;
}

/** The audit action a denied access to the pattern's source is recorded under: the action of the run the pattern's kind makes. */
function auditActionOf(row: PatternRow): string {
  if (row.kind === 'definition') return patternTemplate.auditAction;
  return row.templateId === LINKED_ENTITIES_ID ? linkedEntitiesTemplate.auditAction : sharedAttributeTemplate.auditAction;
}

/**
 * Runs a saved pattern. Nothing is read from the source before the answer is settled, in this order: the runner's access to the pattern's source; whether the pattern can still run against the current mapping (if not, the
 * answer says so, and no source is read); the starting entity (the one given, else the one the pattern holds) and its type; then the run itself, by the service of the pattern's kind: the pattern run for a pattern built in the
 * app, the template run for a saved run of a preset. Those services count the request, audit the read and answer exactly what their own routes answer. The time of the last run is recorded for the pattern's creator after an
 * answer that ran, and a failure to record it does not change the answer.
 */
export function createSavedPatternRunService(deps: {
  readonly store: Pick<PatternStore, 'readRunnablePattern' | 'recordPatternRun'>;
  readonly mapping: MappingModel;
  readonly access: SourceAccess;
  readonly references: StoredReferences;
  readonly patternRuns: PatternRunService;
  readonly templateRuns: TemplateRunService;
  readonly logger: Pick<FastifyBaseLogger, 'warn'>;
}): SavedPatternRunService {
  const sourceOf = (sourceId: string): SourceModel => {
    const source = deps.mapping.sources.find((candidate) => candidate.id === sourceId);
    if (source === undefined) throw new AppError('NOT_FOUND');
    return source;
  };

  return {
    async find({ principal, id }) {
      const row = await deps.store.readRunnablePattern(id, principal.id);
      if (row === undefined) throw new AppError('NOT_FOUND');
      return row;
    },
    async stillRunnable({ principal, id, sourceId }) {
      if (!deps.mapping.sources.some((candidate) => candidate.id === sourceId)) return false;
      return (await deps.store.readRunnablePattern(id, principal.id)) !== undefined;
    },
    async run(call) {
      const { pattern: row, principal } = call;
      await deps.access.require({ traceId: call.traceId, principal, sourceId: row.sourceId, auditAction: auditActionOf(row) });
      const source = sourceOf(row.sourceId);
      const availability = availabilityOf(row, source);
      if (availability.status === 'unavailable') {
        deps.access.admit({ traceId: call.traceId, principal, sourceId: row.sourceId });
        return availability;
      }
      const held = row.anchorEntityType === null || row.anchorStableId === null ? undefined : { entityType: row.anchorEntityType, stableId: deps.references.entityId(row.sourceId, row.anchorEntityType, row.anchorStableId) };
      const anchor = call.anchor ?? held;
      if (anchor === undefined || anchor.entityType !== startTypeOf(row, source)) throw new AppError('INVALID_REQUEST');
      const run = { traceId: call.traceId, principal, sourceId: row.sourceId, mask: call.mask, continue: call.continue, signal: call.signal };
      const answer: SavedPatternRunResponse =
        row.kind === 'definition'
          ? await deps.patternRuns.run({ ...run, definition: row.definition, anchor, limit: call.limit })
          : await deps.templateRuns.run({ ...run, id: row.presetId ?? '', params: { ...row.params, ...(call.limit === undefined ? {} : { limit: call.limit }), ref: anchor } });
      if (answer.status === 'ok' && row.ownerId === principal.id) {
        try {
          await deps.store.recordPatternRun(row.id, principal.id);
        } catch (error) {
          deps.logger.warn({ event: 'pattern.last_run_failed', patternId: row.id, error: error instanceof Error ? error.name : 'unknown' }, 'the time of the last run was not recorded');
        }
      }
      return answer;
    },
  };
}

import type { CoverageEntity, CoverageResponse } from '@neburyx/contracts';
import { AppError } from '../errors.js';
import { degreePreviewBoundedTemplate } from '../gate/templates/degree-preview.js';
import type { SourceAccess } from '../investigations/source-access.js';
import type { MappingModel, SourceModel } from '../mapping/model.js';
import type { AuditSink, Principal } from '../seams/seams.js';
import type { DegreeVerdicts, SourceUsability } from '../source-test/usability.js';
import { notRetrievedOf } from './coverage-sum.js';
import type { DegreeCache } from './degree-cache.js';

export interface CoverageCall {
  readonly traceId: string;
  readonly principal: Principal;
  readonly sourceId: string;
  readonly mask: boolean;
  readonly entities: readonly CoverageEntity[];
}

export interface CoverageService {
  coverage(call: CoverageCall): Promise<CoverageResponse>;
}

interface CoverageDeps {
  readonly mapping: MappingModel;
  readonly access: SourceAccess;
  readonly verdicts: DegreeVerdicts;
  readonly audit: AuditSink;
  readonly logger: { warn(fields: object, message: string): void };
  readonly cache?: { readonly store: DegreeCache; readonly usability: SourceUsability };
}

/** A type whose label another type shares has no preview, because its nodes cannot be told from the other's. */
function sharesLabel(source: SourceModel, entityType: string): boolean {
  const label = source.entities.find((entity) => entity.type === entityType)?.label;
  return source.entities.filter((entity) => entity.label === label).length > 1;
}

export function createCoverageService(deps: CoverageDeps): CoverageService {
  return {
    async coverage(call) {
      if (call.entities.some((entity) => entity.ref.sourceId !== call.sourceId)) throw new AppError('SOURCE_MISMATCH');
      if (new Set(call.entities.map((entity) => `${entity.ref.entityType}\u0000${entity.ref.stableId}`)).size !== call.entities.length) throw new AppError('INVALID_REQUEST');
      await deps.access.require({ traceId: call.traceId, principal: call.principal, sourceId: call.sourceId, auditAction: degreePreviewBoundedTemplate.auditAction });
      const source = deps.mapping.sources.find((candidate) => candidate.id === call.sourceId);
      if (source === undefined || call.entities.some((entity) => !source.entities.some((known) => known.type === entity.ref.entityType))) throw new AppError('NOT_FOUND');
      const cache = deps.cache;
      if (cache !== undefined && !cache.usability.isUsable(call.sourceId)) throw new AppError('SOURCE_UNAVAILABLE');
      const revision = deps.verdicts.revisionOf(call.sourceId);
      const parts = call.entities.map((entity) => ({
        loadedRelationships: entity.loadedRelationships,
        loadedQuality: entity.loadedQuality,
        preview: sharesLabel(source, entity.ref.entityType)
          ? undefined
          : cache?.store.get({ sourceId: call.sourceId, configHash: source.configHash, principalId: call.principal.id, entityType: entity.ref.entityType, stableId: entity.ref.stableId, mask: call.mask, verdictRevision: revision }),
      }));
      const response = { notRetrieved: notRetrievedOf(parts) };
      await recordRead(deps, call);
      return response;
    },
  };
}

async function recordRead(deps: CoverageDeps, call: CoverageCall): Promise<void> {
  try {
    await deps.audit.record({ actorId: call.principal.id, actorRole: call.principal.role, action: degreePreviewBoundedTemplate.auditAction, result: 'success', sourceId: call.sourceId, traceId: call.traceId });
  } catch {
    // the answer does not depend on the audit write, as for a read through the gate; the log line carries no event data
    deps.logger.warn({ event: 'coverage.audit_failed' }, 'coverage audit write failed');
  }
}

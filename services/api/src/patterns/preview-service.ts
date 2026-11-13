import type { PatternPreviewResponse } from '@neburyx/contracts';
import { AppError } from '../errors.js';
import type { SourceAccess } from '../investigations/source-access.js';
import type { MappingModel } from '../mapping/model.js';
import { previewOrProblems } from './preview.js';
import type { PatternValidateCall } from './validate-service.js';

export const PATTERN_PREVIEW_AUDIT_ACTION = 'pattern.preview';

export interface PatternPreviewService {
  preview(call: PatternValidateCall): Promise<PatternPreviewResponse>;
}

/** What a pattern will read, in words: it answers from the mapping and the definition alone, never from the source, so it reads nothing. A source the person may not read answers as a missing one, and a call counts against the source's rate as the validation does. */
export function createPatternPreviewService(deps: { readonly mapping: MappingModel; readonly access: SourceAccess }): PatternPreviewService {
  return {
    async preview(call) {
      await deps.access.require({ traceId: call.traceId, principal: call.principal, sourceId: call.sourceId, auditAction: PATTERN_PREVIEW_AUDIT_ACTION, rate: 'count' });
      const source = deps.mapping.sources.find((candidate) => candidate.id === call.sourceId);
      if (source === undefined) throw new AppError('NOT_FOUND');
      return previewOrProblems(call.definition, source, { mask: call.mask });
    },
  };
}

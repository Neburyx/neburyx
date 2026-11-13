import type { PatternValidateResponse } from '@neburyx/contracts';
import { AppError } from '../errors.js';
import type { SourceAccess } from '../investigations/source-access.js';
import type { MappingModel } from '../mapping/model.js';
import type { Principal } from '../seams/seams.js';
import { validatePattern } from './validate.js';

export const PATTERN_VALIDATE_AUDIT_ACTION = 'pattern.validate';

export interface PatternValidateCall {
  readonly traceId: string;
  readonly principal: Principal;
  readonly sourceId: string;
  readonly definition: unknown;
  readonly mask: boolean;
}

export interface PatternValidateService {
  validate(call: PatternValidateCall): Promise<PatternValidateResponse>;
}

/** Whether a pattern is acceptable for a source: it answers from the mapping and the definition alone, never from the source, so it reads nothing. A source the person may not read answers as a missing one. */
export function createPatternValidateService(deps: { readonly mapping: MappingModel; readonly access: SourceAccess }): PatternValidateService {
  return {
    async validate(call) {
      await deps.access.require({ traceId: call.traceId, principal: call.principal, sourceId: call.sourceId, auditAction: PATTERN_VALIDATE_AUDIT_ACTION, rate: 'count' });
      const source = deps.mapping.sources.find((candidate) => candidate.id === call.sourceId);
      if (source === undefined) throw new AppError('NOT_FOUND');
      const problems = validatePattern(call.definition, source, { mask: call.mask });
      return problems.length === 0 ? { status: 'ok' } : { status: 'invalid', problems };
    },
  };
}

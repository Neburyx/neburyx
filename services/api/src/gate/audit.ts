import { AppError } from '../errors.js';
import type { AuditResult } from '../seams/seams.js';
import type { ErrorCode } from '@neburyx/contracts';

export const FALLBACK_AUDIT_ACTION = 'gate.read';

const REFUSED_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>(['INVALID_REQUEST', 'QUERY_BUDGET_EXCEEDED', 'SOURCE_MISMATCH', 'NOT_FOUND']);

export function auditResultFor(failure: AppError | undefined): AuditResult {
  if (!failure) return 'success';
  if (failure.code === 'ACCESS_DENIED') return 'denied';
  if (failure.reason === 'unusable') return 'refused';
  return REFUSED_CODES.has(failure.code) ? 'refused' : 'failed';
}

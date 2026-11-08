import { AppError, RequestCancelled, type ErrorReason } from '../errors.js';
import type { AuditResult } from '../seams/seams.js';
import type { ErrorCode } from '@neburyx/contracts';

export const FALLBACK_AUDIT_ACTION = 'gate.read';

const REFUSED_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>(['INVALID_REQUEST', 'QUERY_BUDGET_EXCEEDED', 'SOURCE_MISMATCH', 'NOT_FOUND', 'CURSOR_INVALIDATED']);

/** A read the gate refused for its indexes made no data read: it is a refusal, not a failure of the source. */
const INDEX_REFUSALS: ReadonlySet<ErrorReason> = new Set<ErrorReason>(['index-unavailable', 'index-building', 'index-failed', 'index-list-unreadable']);

export function auditResultFor(failure: AppError | RequestCancelled | undefined): AuditResult {
  if (!failure) return 'success';
  if (failure instanceof RequestCancelled) return 'failed';
  if (failure.code === 'ACCESS_DENIED') return 'denied';
  if (failure.code === 'SOURCE_UNAVAILABLE' && failure.reason !== undefined && INDEX_REFUSALS.has(failure.reason)) return 'refused';
  return REFUSED_CODES.has(failure.code) ? 'refused' : 'failed';
}

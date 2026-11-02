import { allowedDetails, ERROR_TABLE, type ErrorCode, type ErrorResponse } from '@neburyx/contracts';

/** Why a read could not reach a source; a fixed tag that is never sent in a response or written to a log. */
export const UNAVAILABLE_REASONS = ['unreachable', 'authentication', 'credentials', 'database', 'refused', 'pool-full', 'closed'] as const;
export type UnavailableReason = (typeof UNAVAILABLE_REASONS)[number];
/** What an `AppError` may be tagged with: an unavailable reason, or `read-failed` on the `INTERNAL_ERROR` of a read the adapter could not run. */
export type ErrorReason = UnavailableReason | 'read-failed';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details: unknown;
  readonly reason: ErrorReason | undefined;

  constructor(code: ErrorCode, details?: unknown, reason?: ErrorReason) {
    super(code);
    this.code = code;
    this.details = details;
    this.reason = reason;
  }
}

export function errorResponse(code: ErrorCode, traceId: string, details?: unknown): ErrorResponse {
  const { message, retryable } = ERROR_TABLE[code];
  const allowed = allowedDetails(code, details);
  return { error: { code, message, retryable, traceId, ...(allowed ? { details: allowed } : {}) } };
}

export function errorStatus(code: ErrorCode): number {
  return ERROR_TABLE[code].status;
}

export function codeForFailure(error: unknown): ErrorCode {
  try {
    if (error instanceof AppError) return error.code;
    const status = typeof error === 'object' && error !== null && 'statusCode' in error ? error.statusCode : undefined;
    if (status === 415) return 'UNSUPPORTED_MEDIA_TYPE';
    if (status === 404) return 'NOT_FOUND';
    if (typeof status === 'number' && status >= 400 && status < 500) return 'INVALID_REQUEST';
  } catch {
    return 'INTERNAL_ERROR';
  }
  return 'INTERNAL_ERROR';
}

export function detailsOf(error: unknown): unknown {
  try {
    return error instanceof AppError ? error.details : undefined;
  } catch {
    return undefined;
  }
}

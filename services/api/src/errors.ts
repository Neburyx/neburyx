import { allowedDetails, CONFLICT_ENTRIES, ERROR_TABLE, SOURCE_UNAVAILABLE_ENTRIES, SOURCE_UNAVAILABLE_REASONS, type ErrorCode, type ErrorResponse, type SourceUnavailableReason } from '@neburyx/contracts';

/** Why a read could not reach a source, as the adapter tells it; a fixed tag, sent in a response only as the public reason it maps to (`unavailableReasonOf`). */
export const UNAVAILABLE_REASONS = ['unreachable', 'authentication', 'credentials', 'database', 'refused', 'pool-full', 'closed'] as const;
export type UnavailableReason = (typeof UNAVAILABLE_REASONS)[number];
/** Why the gate refused a read that needs an index: the index is not there, is still building or failed, or the list of indexes could not be read whole. */
export type IndexRefusalReason = 'index-unavailable' | 'index-building' | 'index-failed' | 'index-list-unreadable';
/**
 * What an `AppError` may be tagged with: an unavailable reason, an index refusal reason on the `SOURCE_UNAVAILABLE` of a read refused before any data was read, `read-failed` on the `INTERNAL_ERROR`
 * of a read the adapter could not run, `read-cut` on the `INTERNAL_ERROR` of a read of a template that is not paged and returned more rows than its limit, or `unreadable-node` or `unreadable-edge` on the
 * `INTERNAL_ERROR` of an entity read whose row the normalizer left out.
 */
export type ErrorReason = UnavailableReason | IndexRefusalReason | 'repeated-timeouts' | 'read-failed' | 'read-cut' | 'unreadable-node' | 'unreadable-edge';

/** The reason a `SOURCE_UNAVAILABLE` gives the person: the adapter's `database`, `pool-full` and `closed`, any other tag and none are `unreachable`, and `credentials` is `authentication`. */
export function unavailableReasonOf(reason: ErrorReason | undefined): SourceUnavailableReason {
  switch (reason) {
    case 'authentication':
    case 'credentials':
      return 'authentication';
    case 'refused':
    case 'repeated-timeouts':
    case 'index-unavailable':
    case 'index-building':
    case 'index-failed':
    case 'index-list-unreadable':
      return reason;
    default:
      return 'unreachable';
  }
}

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

/**
 * The request was cancelled by the client (its connection closed before the answer). It is not an `AppError` and has no error code: nobody is left to read an answer, so the route writes none,
 * and the gate passes it on unchanged and audits it as a failed read.
 */
export class RequestCancelled extends Error {
  constructor() {
    super('REQUEST_CANCELLED');
    this.name = 'RequestCancelled';
  }
}

/** The body of an error. A `SOURCE_UNAVAILABLE` always carries its reason, taken from the details (`unreachable` when they name none), with that reason's sentence and retry flag. */
export function errorResponse(code: ErrorCode, traceId: string, details?: unknown): ErrorResponse {
  const allowed = allowedDetails(code, details);
  if (code === 'SOURCE_UNAVAILABLE') {
    const reason = SOURCE_UNAVAILABLE_REASONS.find((candidate) => candidate === allowed?.reason) ?? 'unreachable';
    // only the breaker's reason has a wait to give
    const wait = reason === 'repeated-timeouts' ? allowed?.retryAfterMs : undefined;
    return { error: { code, ...SOURCE_UNAVAILABLE_ENTRIES[reason], traceId, details: { reason, ...(wait === undefined ? {} : { retryAfterMs: wait }) } } };
  }
  if (code === 'CONFLICT' && (allowed?.reason === 'status-change-not-allowed' || allowed?.reason === 'investigation-read-only')) {
    return { error: { code, ...CONFLICT_ENTRIES[allowed.reason], traceId, details: allowed } };
  }
  const { message, retryable } = ERROR_TABLE[code];
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

/** The details an error is answered with; for `SOURCE_UNAVAILABLE`, the public reason its tag maps to. */
export function detailsOf(error: unknown): unknown {
  try {
    if (!(error instanceof AppError)) return undefined;
    if (error.code !== 'SOURCE_UNAVAILABLE') return error.details;
    const reason = unavailableReasonOf(error.reason);
    const wait = reason === 'repeated-timeouts' && typeof error.details === 'object' && error.details !== null && 'retryAfterMs' in error.details ? error.details.retryAfterMs : undefined;
    return { reason, ...(wait === undefined ? {} : { retryAfterMs: wait }) };
  } catch {
    return undefined;
  }
}

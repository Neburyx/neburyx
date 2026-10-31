import type { ErrorCode } from './error-codes.js';
import { ERROR_CODES } from './error-codes.js';

export interface ErrorEntry {
  readonly message: string;
  readonly status: number;
  readonly retryable: boolean;
}

export const ERROR_TABLE: Readonly<Record<ErrorCode, ErrorEntry>> = {
  QUERY_BUDGET_EXCEEDED: { message: 'Refine your filters to continue.', status: 422, retryable: true },
  QUERY_TIMEOUT: { message: 'The source did not answer in time. Try again or refine your filters.', status: 504, retryable: true },
  SOURCE_UNAVAILABLE: { message: 'The data source is not available. Try again shortly.', status: 503, retryable: true },
  SOURCE_BUSY: { message: 'The data source is busy. Try again shortly.', status: 503, retryable: true },
  RATE_LIMITED: { message: 'Too many requests. Try again shortly.', status: 429, retryable: true },
  ACCESS_DENIED: { message: 'You do not have access to this.', status: 403, retryable: false },
  CURSOR_INVALIDATED: { message: 'This page of results is no longer valid. Start again.', status: 409, retryable: false },
  PARTIAL_RESULT: { message: 'Some results could not be loaded.', status: 206, retryable: true },
  EVIDENCE_NOT_AVAILABLE: { message: 'The evidence for this item is not available.', status: 404, retryable: false },
  CONFLICTED_VIEW_VERSION: { message: 'This view was changed elsewhere. Reload to continue.', status: 409, retryable: false },
  CONFLICT: { message: 'This item was changed elsewhere. Reload to continue.', status: 409, retryable: false },
  EXPORT_FAILED: { message: 'The export could not be created.', status: 500, retryable: true },
  ASK_UNSUPPORTED: { message: 'This question is not supported.', status: 422, retryable: false },
  ASK_PLAN_INVALID: { message: 'The question could not be turned into a valid plan.', status: 422, retryable: false },
  INVALID_REQUEST: { message: 'The request is not valid.', status: 400, retryable: false },
  UNSUPPORTED_MEDIA_TYPE: { message: 'The request content type is not supported.', status: 415, retryable: false },
  NOT_FOUND: { message: 'Not found.', status: 404, retryable: false },
  INTERNAL_ERROR: { message: 'Something went wrong. Quote the trace ID if you contact support.', status: 500, retryable: false },
  SOURCE_MISMATCH: { message: 'The request mixes more than one source.', status: 400, retryable: false },
};

export function findMissingCodes(table: Readonly<Record<string, unknown>>): readonly ErrorCode[] {
  return ERROR_CODES.filter((code) => !(code in table));
}

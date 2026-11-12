import type { AccessDeniedReason, ConflictReason, ErrorCode, InvalidRequestReason, SourceUnavailableReason } from './error-codes.js';
import { ERROR_CODES } from './error-codes.js';

export interface ErrorEntry {
  readonly message: string;
  readonly status: number;
  readonly retryable: boolean;
}

/** The sentence and the retry flag of each reason of `SOURCE_UNAVAILABLE`; `unreachable` is also the entry of an answer that gives no reason. */
export const SOURCE_UNAVAILABLE_ENTRIES: Readonly<Record<SourceUnavailableReason, Omit<ErrorEntry, 'status'>>> = {
  unreachable: { message: 'The source did not answer. Try again shortly.', retryable: true },
  authentication: { message: 'The source refused the login. Ask an administrator.', retryable: false },
  refused: { message: 'The source does not allow this read for the login.', retryable: false },
  'index-unavailable': { message: 'A needed index is not there, so the read was not run.', retryable: false },
  'index-building': { message: 'A needed index is still building, so the read is slow. Try again later.', retryable: true },
  'index-failed': { message: 'A needed index failed, so the read was not run.', retryable: false },
  'index-list-unreadable': { message: "The source's indexes could not be listed, so the read was not run.", retryable: false },
  'repeated-timeouts': { message: 'The source has timed out repeatedly and is being left to recover. Try again shortly.', retryable: true },
};

/** The sentence of each reason of `CONFLICT`; a `CONFLICT` with no reason keeps the entry of `ERROR_TABLE`. */
export const CONFLICT_ENTRIES: Readonly<Record<ConflictReason, Omit<ErrorEntry, 'status'>>> = {
  'status-change-not-allowed': { message: 'An archived investigation must be reopened before it can be closed.', retryable: false },
  'investigation-read-only': { message: 'This investigation is closed or archived. Reopen it to make changes.', retryable: false },
  'source-changed': { message: 'This source now points to a different database or is no longer configured. This investigation is read-only.', retryable: false },
};

/** The sentence of each reason of `ACCESS_DENIED`; a changed access is never said in more than that. */
export const ACCESS_DENIED_ENTRIES: Readonly<Record<AccessDeniedReason, Omit<ErrorEntry, 'status'>>> = {
  'access-changed': { message: 'Your access changed since this export was made. Export again to get a file that matches your current access.', retryable: false },
  'export-source-changed': { message: 'The source of this export changed since it was made. The file is no longer available.', retryable: false },
  'ai-preview-off': { message: 'The AI preview is not switched on for this deployment. The switch is a safety rail that whoever runs the deployment sets, not a lock.', retryable: false },
};

/** The sentence of each reason of `INVALID_REQUEST`; the limit itself is in the details. */
export const INVALID_REQUEST_ENTRIES: Readonly<Record<InvalidRequestReason, Omit<ErrorEntry, 'status'>>> = {
  'export-too-large': { message: 'This view holds more than one export can. Hide some items, then export again.', retryable: false },
};

export const ERROR_TABLE: Readonly<Record<ErrorCode, ErrorEntry>> = {
  QUERY_BUDGET_EXCEEDED: { message: 'Refine your filters to continue.', status: 422, retryable: true },
  QUERY_TIMEOUT: { message: 'The source did not answer in time. Try again or refine your filters.', status: 504, retryable: true },
  SOURCE_UNAVAILABLE: { ...SOURCE_UNAVAILABLE_ENTRIES.unreachable, status: 503 },
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
  AUDIT_UNAVAILABLE: { message: 'The action could not be recorded, so nothing was returned.', status: 503, retryable: true },
};

export function findMissingCodes(table: Readonly<Record<string, unknown>>): readonly ErrorCode[] {
  return ERROR_CODES.filter((code) => !(code in table));
}

import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from './error-codes.js';
import { errorResponseSchema } from './error-response.js';

const TAS_CODES = [
  'QUERY_BUDGET_EXCEEDED',
  'QUERY_TIMEOUT',
  'SOURCE_UNAVAILABLE',
  'SOURCE_BUSY',
  'RATE_LIMITED',
  'ACCESS_DENIED',
  'CURSOR_INVALIDATED',
  'PARTIAL_RESULT',
  'EVIDENCE_NOT_AVAILABLE',
  'CONFLICTED_VIEW_VERSION',
  'CONFLICT',
  'EXPORT_FAILED',
  'ASK_UNSUPPORTED',
  'ASK_PLAN_INVALID',
];
const ADDED_CODES = ['INVALID_REQUEST', 'UNSUPPORTED_MEDIA_TYPE', 'NOT_FOUND', 'INTERNAL_ERROR', 'SOURCE_MISMATCH'];

const validBody = { error: { code: 'NOT_FOUND', message: 'Not found.', retryable: false, traceId: 'tr-1' } };

describe('error codes', () => {
  it('hold the 14 codes of the architecture and the five added ones, each once', () => {
    expect([...ERROR_CODES].sort()).toEqual([...TAS_CODES, ...ADDED_CODES].sort());
  });
});

describe('ErrorResponse', () => {
  it.each([
    ['a body without a trace ID', { error: { ...validBody.error, traceId: undefined } }],
    ['an unknown code', { error: { ...validBody.error, code: 'MADE_UP' } }],
    ['an empty message', { error: { ...validBody.error, message: '' } }],
    ['a details object with an unknown field', { error: { ...validBody.error, details: { query: 'MATCH (n)' } } }],
    ['a body without the error wrapper', validBody.error],
    ['a message other than the fixed one', { error: { ...validBody.error, message: 'MATCH (n) RETURN n' } }],
    ['a retryable flag other than the fixed one', { error: { ...validBody.error, retryable: true } }],
    ['details on a code that names none', { error: { ...validBody.error, details: { maxPage: 50 } } }],
    ['details of another code', { error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again shortly.', retryable: true, traceId: 'tr-1', details: { maxPage: 50 } } }],
  ])('rejects %s', (_name, body) => {
    expect(errorResponseSchema.safeParse(body).success).toBe(false);
  });

  const conflict = { code: 'CONFLICT', retryable: false, traceId: 'tr-1' };
  const readOnlyMessage = 'This investigation is closed or archived. Reopen it to make changes.';
  const notAllowedMessage = 'An archived investigation must be reopened before it can be closed.';
  const unavailable = { code: 'SOURCE_UNAVAILABLE', message: 'The source did not answer. Try again shortly.', retryable: true, traceId: 'tr-1' };

  it.each([
    ['a source-unavailable reason on CONFLICT', { error: { ...conflict, message: 'This item was changed elsewhere. Reload to continue.', details: { reason: 'unreachable' } } }],
    ['a conflict reason on SOURCE_UNAVAILABLE', { error: { ...unavailable, details: { reason: 'investigation-read-only' } } }],
    ['a read-only reason with the plain message', { error: { ...conflict, message: 'This item was changed elsewhere. Reload to continue.', details: { reason: 'investigation-read-only', status: 'closed' } } }],
    ['a read-only reason with no status', { error: { ...conflict, message: readOnlyMessage, details: { reason: 'investigation-read-only' } } }],
    ['a status on a not-allowed reason', { error: { ...conflict, message: notAllowedMessage, details: { reason: 'status-change-not-allowed', status: 'closed' } } }],
    ['a status of open', { error: { ...conflict, message: readOnlyMessage, details: { reason: 'investigation-read-only', status: 'open' } } }],
    ['a status with no reason', { error: { ...conflict, message: 'This item was changed elsewhere. Reload to continue.', details: { status: 'closed' } } }],
    ['a retryable read-only refusal', { error: { ...conflict, retryable: true, message: readOnlyMessage, details: { reason: 'investigation-read-only', status: 'closed' } } }],
  ])('rejects %s', (_name, body) => {
    expect(errorResponseSchema.safeParse(body).success).toBe(false);
  });

  it('accepts a CONFLICT with no reason and each reason with its own message', () => {
    expect(errorResponseSchema.safeParse({ error: { ...conflict, message: 'This item was changed elsewhere. Reload to continue.' } }).success).toBe(true);
    expect(errorResponseSchema.safeParse({ error: { ...conflict, message: notAllowedMessage, details: { reason: 'status-change-not-allowed' } } }).success).toBe(true);
    expect(errorResponseSchema.safeParse({ error: { ...conflict, message: readOnlyMessage, details: { reason: 'investigation-read-only', status: 'archived' } } }).success).toBe(true);
  });

  it('accepts a full body, with and without details', () => {
    expect(errorResponseSchema.safeParse(validBody).success).toBe(true);
    const budget = { code: 'QUERY_BUDGET_EXCEEDED', message: 'Refine your filters to continue.', retryable: true, traceId: 'tr-1' };
    expect(errorResponseSchema.safeParse({ error: { ...budget, details: { maxPage: 50 } } }).success).toBe(true);
    expect(errorResponseSchema.safeParse({ error: budget }).success).toBe(true);
  });

  describe('an unavailable source', () => {
    const unavailable = (reason: string, message: string, retryable: boolean) => ({ error: { code: 'SOURCE_UNAVAILABLE', message, retryable, traceId: 'tr-1', details: { reason } } });

    it.each([
      ['unreachable', 'The source did not answer. Try again shortly.', true],
      ['authentication', 'The source refused the login. Ask an administrator.', false],
      ['refused', 'The source does not allow this read for the login.', false],
      ['index-unavailable', 'A needed index is not there, so the read was not run.', false],
      ['index-building', 'A needed index is still building, so the read is slow. Try again later.', true],
      ['index-failed', 'A needed index failed, so the read was not run.', false],
      ['index-list-unreadable', "The source's indexes could not be listed, so the read was not run.", false],
    ])('accepts the reason %s with its own sentence and retry flag, and no other', (reason, message, retryable) => {
      expect(errorResponseSchema.safeParse(unavailable(reason, message, retryable)).success).toBe(true);
      expect(errorResponseSchema.safeParse(unavailable(reason, message, !retryable)).success).toBe(false);
      expect(errorResponseSchema.safeParse(unavailable(reason, 'The data source is not available. Try again shortly.', retryable)).success).toBe(false);
    });

    it.each([
      ['no reason', { error: { code: 'SOURCE_UNAVAILABLE', message: 'The source did not answer. Try again shortly.', retryable: true, traceId: 'tr-1' } }],
      ['the reason it no longer has, unusable', unavailable('unusable', 'The source did not answer. Try again shortly.', true)],
      ["a reason of the adapter's own", unavailable('pool-full', 'The source did not answer. Try again shortly.', true)],
      ['the sentence of another reason', unavailable('index-failed', 'A needed index is not there, so the read was not run.', false)],
    ])('refuses %s', (_name, body) => {
      expect(errorResponseSchema.safeParse(body).success).toBe(false);
    });

    it('allows a reason in the details of no other code', () => {
      const budget = { code: 'QUERY_BUDGET_EXCEEDED', message: 'Refine your filters to continue.', retryable: true, traceId: 'tr-1' };
      expect(errorResponseSchema.safeParse({ error: { ...budget, details: { reason: 'unreachable' } } }).success).toBe(false);
    });
  });

  it('accepts the timeout in the details of a timed-out query and in no other code', () => {
    const timeout = { code: 'QUERY_TIMEOUT', message: 'The source did not answer in time. Try again or refine your filters.', retryable: true, traceId: 'tr-1' };
    expect(errorResponseSchema.safeParse({ error: { ...timeout, details: { timeoutMs: 5000 } } }).success).toBe(true);
    expect(errorResponseSchema.safeParse({ error: { ...timeout, code: 'ACCESS_DENIED', details: { timeoutMs: 5000 } } }).success).toBe(false);
  });
});

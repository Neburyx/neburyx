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

  it('accepts a full body, with and without details', () => {
    expect(errorResponseSchema.safeParse(validBody).success).toBe(true);
    const budget = { code: 'QUERY_BUDGET_EXCEEDED', message: 'Refine your filters to continue.', retryable: true, traceId: 'tr-1' };
    expect(errorResponseSchema.safeParse({ error: { ...budget, details: { maxPage: 50 } } }).success).toBe(true);
    expect(errorResponseSchema.safeParse({ error: budget }).success).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from './error-codes.js';
import { allowedDetails, ERROR_DETAIL_KEYS } from './error-details.js';

describe('allowedDetails', () => {
  it.each([{ maxPage: '50' }, { maxPage: 0 }, { maxPage: 1.5 }, { query: 'MATCH (n)' }, 'text', 42, null, undefined])(
    'drops %j',
    (details) => {
      expect(allowedDetails('QUERY_BUDGET_EXCEEDED', details)).toBeUndefined();
    },
  );

  it('keeps only the named field of a code', () => {
    expect(allowedDetails('QUERY_BUDGET_EXCEEDED', { maxPage: 50, retryAfterMs: 5, query: 'MATCH (n)' })).toEqual({ maxPage: 50 });
    expect(allowedDetails('RATE_LIMITED', { retryAfterMs: 2000, maxPage: 50 })).toEqual({ retryAfterMs: 2000 });
    expect(allowedDetails('SOURCE_UNAVAILABLE', { reason: 'repeated-timeouts', retryAfterMs: 2000, maxPage: 50 })).toEqual({ reason: 'repeated-timeouts', retryAfterMs: 2000 });
  });

  it('keeps the timeout of a query that timed out and drops anything else', () => {
    expect(allowedDetails('QUERY_TIMEOUT', { timeoutMs: 5000, maxPage: 50, query: 'MATCH (n)' })).toEqual({ timeoutMs: 5000 });
    expect(allowedDetails('QUERY_TIMEOUT', { timeoutMs: 0 })).toBeUndefined();
    expect(allowedDetails('QUERY_TIMEOUT', { timeoutMs: '5000' })).toBeUndefined();
    expect(allowedDetails('QUERY_BUDGET_EXCEEDED', { timeoutMs: 5000 })).toBeUndefined();
  });

  it('keeps the reason of an unavailable source when it is one of the closed set, and only for that code', () => {
    expect(allowedDetails('SOURCE_UNAVAILABLE', { reason: 'index-building', timeoutMs: 5000 })).toEqual({ reason: 'index-building' });
    expect(allowedDetails('SOURCE_UNAVAILABLE', { reason: 'unusable' })).toBeUndefined();
    expect(allowedDetails('SOURCE_UNAVAILABLE', { reason: 'pool-full' })).toBeUndefined();
    expect(allowedDetails('QUERY_TIMEOUT', { reason: 'unreachable' })).toBeUndefined();
  });

  it('allows no field for a code that names none', () => {
    expect(allowedDetails('ACCESS_DENIED', { maxPage: 50 })).toBeUndefined();
  });

  it('names a field list for every code', () => {
    expect(Object.keys(ERROR_DETAIL_KEYS).sort()).toEqual([...ERROR_CODES].sort());
  });
});

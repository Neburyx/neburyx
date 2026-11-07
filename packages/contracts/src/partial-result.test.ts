import { describe, expect, it } from 'vitest';
import { errorBodySchema, errorDetailsSchema } from './error-codes.js';
import { allowedDetails } from './error-details.js';
import { errorResponseSchema } from './error-response.js';
import { ERROR_TABLE } from './error-table.js';

const body = (details?: unknown) => ({
  error: { code: 'PARTIAL_RESULT', message: ERROR_TABLE.PARTIAL_RESULT.message, retryable: ERROR_TABLE.PARTIAL_RESULT.retryable, traceId: 'trace-1', ...(details === undefined ? {} : { details }) },
});

const refused: ReadonlyArray<readonly [string, unknown]> = [
  ['retained equal to requested', { retained: 5, requested: 5 }],
  ['retained above requested', { retained: 6, requested: 5 }],
  ['a negative retained', { retained: -1, requested: 5 }],
  ['a fractional retained', { retained: 1.5, requested: 5 }],
  ['a requested of zero', { retained: 0, requested: 0 }],
  ['a text count', { retained: '2', requested: 5 }],
  ['retained alone', { retained: 2 }],
  ['requested alone', { requested: 5 }],
  ['an empty details object', {}],
];

describe('the PARTIAL_RESULT details', () => {
  it('accepts retained 2 of requested 5 in the error body and in the response schema, and allows both counts', () => {
    expect(errorBodySchema.safeParse(body({ retained: 2, requested: 5 })).success).toBe(true);
    expect(errorResponseSchema.safeParse(body({ retained: 2, requested: 5 })).success).toBe(true);
    expect(allowedDetails('PARTIAL_RESULT', { retained: 2, requested: 5 })).toEqual({ retained: 2, requested: 5 });
  });

  it('accepts retained 0', () => {
    expect(errorResponseSchema.safeParse(body({ retained: 0, requested: 5 })).success).toBe(true);
  });

  it.each(refused)('refuses %s and allows neither count', (_name, details) => {
    expect(errorBodySchema.safeParse(body(details)).success).toBe(false);
    expect(errorResponseSchema.safeParse(body(details)).success).toBe(false);
    expect(allowedDetails('PARTIAL_RESULT', details)).toBeUndefined();
  });

  it('refuses a body with a field that is not a count, and allows only the counts of one that is offered', () => {
    const details = { retained: 2, requested: 5, query: 'MATCH (n)' };
    expect(errorBodySchema.safeParse(body(details)).success).toBe(false);
    expect(errorResponseSchema.safeParse(body(details)).success).toBe(false);
    expect(allowedDetails('PARTIAL_RESULT', details)).toEqual({ retained: 2, requested: 5 });
  });

  it('refuses a body with no details', () => {
    expect(errorBodySchema.safeParse(body()).success).toBe(false);
    expect(errorResponseSchema.safeParse(body()).success).toBe(false);
    expect(allowedDetails('PARTIAL_RESULT', undefined)).toBeUndefined();
  });

  it('leaves the counts out of every other code', () => {
    expect(allowedDetails('QUERY_TIMEOUT', { timeoutMs: 5000, retained: 2, requested: 5 })).toEqual({ timeoutMs: 5000 });
    expect(allowedDetails('SOURCE_BUSY', { retained: 2, requested: 5 })).toBeUndefined();
    expect(errorDetailsSchema.shape.retained).toBeDefined();
  });
});

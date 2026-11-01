import { describe, expect, it } from 'vitest';
import { isConnectionError } from './database-errors.js';

describe('isConnectionError', () => {
  it.each([
    Object.assign(new Error('x'), { code: 'ECONNREFUSED' }),
    Object.assign(new Error('x'), { code: '57P01' }),
    Object.assign(new Error('x'), { code: '08006' }),
    Object.assign(new Error('x'), { code: '28P01' }),
    new Error('timeout exceeded when trying to connect'),
    new Error('Connection terminated unexpectedly'),
  ])('recognizes %s', (error) => {
    expect(isConnectionError(error)).toBe(true);
  });

  it.each([Object.assign(new Error('x'), { code: '42P01' }), new Error('something else'), 'text', undefined, null])('does not take %s for a connection error', (error) => {
    expect(isConnectionError(error)).toBe(false);
  });
});

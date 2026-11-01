import { describe, expect, it } from 'vitest';
import { readyResponseSchema } from './ready.js';

describe('readyResponseSchema', () => {
  it('accepts a ready and a not ready answer', () => {
    expect(readyResponseSchema.safeParse({ status: 'ready', checks: { database: 'ok', migrations: 'ok' } }).success).toBe(true);
    expect(readyResponseSchema.safeParse({ status: 'not_ready', checks: { database: 'ok', migrations: 'pending' } }).success).toBe(true);
    expect(readyResponseSchema.safeParse({ status: 'not_ready', checks: { database: 'unreachable', migrations: 'unknown' } }).success).toBe(true);
  });

  it.each([
    ['an unknown status', { status: 'up', checks: { database: 'ok', migrations: 'ok' } }],
    ['an unknown check state', { status: 'ready', checks: { database: 'slow', migrations: 'ok' } }],
    ['a missing check', { status: 'ready', checks: { database: 'ok' } }],
    ['an unknown migrations state', { status: 'ready', checks: { database: 'ok', migrations: 'late' } }],
    ['a field it does not define', { status: 'ready', checks: { database: 'ok', migrations: 'ok' }, host: 'db' }],
  ])('rejects %s', (_name, value) => {
    expect(readyResponseSchema.safeParse(value).success).toBe(false);
  });
});

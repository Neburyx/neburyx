import { describe, expect, it } from 'vitest';
import { readyResponseSchema } from './ready.js';

describe('readyResponseSchema', () => {
  it('accepts a ready and a not ready answer', () => {
    expect(readyResponseSchema.safeParse({ status: 'ready', checks: { database: 'ok', migrations: 'ok' }, sources: { reachable: 1, unreachable: 0, unknown: 0 } }).success).toBe(true);
    expect(readyResponseSchema.safeParse({ status: 'not_ready', checks: { database: 'ok', migrations: 'pending' }, sources: { reachable: 0, unreachable: 2, unknown: 1 } }).success).toBe(true);
    expect(readyResponseSchema.safeParse({ status: 'not_ready', checks: { database: 'unreachable', migrations: 'unknown' }, sources: { reachable: 0, unreachable: 0, unknown: 0 } }).success).toBe(true);
  });

  const sources = { reachable: 1, unreachable: 0, unknown: 0 };
  const checks = { database: 'ok', migrations: 'ok' };

  it.each([
    ['an unknown status', { status: 'up', checks, sources }],
    ['an unknown check state', { status: 'ready', checks: { database: 'slow', migrations: 'ok' }, sources }],
    ['a missing check', { status: 'ready', checks: { database: 'ok' }, sources }],
    ['an unknown migrations state', { status: 'ready', checks: { database: 'ok', migrations: 'late' }, sources }],
    ['a field it does not define', { status: 'ready', checks, sources, host: 'db' }],
    ['no sources member', { status: 'ready', checks }],
    ['a source ID in the counts', { status: 'ready', checks, sources: { ...sources, alpha: 1 } }],
    ['a negative count', { status: 'ready', checks, sources: { ...sources, unknown: -1 } }],
    ['a count that is not whole', { status: 'ready', checks, sources: { ...sources, reachable: 1.5 } }],
    ['a missing count', { status: 'ready', checks, sources: { reachable: 1, unreachable: 0 } }],
    ['a source count inside the checks', { status: 'ready', checks: { ...checks, sources: 'ok' }, sources }],
  ])('rejects %s', (_name, value) => {
    expect(readyResponseSchema.safeParse(value).success).toBe(false);
  });
});

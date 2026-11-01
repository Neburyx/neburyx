import { describe, expect, it } from 'vitest';
import { migrationsState } from './readiness-repository.js';

describe('migrationsState', () => {
  it.each([
    [['0001', '0002'], ['0001', '0002'], 'ok'],
    [['0001', '0002'], ['0001'], 'pending'],
    [['0001', '0002'], [], 'pending'],
    [['0001'], ['0001', '0002'], 'ok'],
    [[], ['0001'], 'ok'],
    [[], [], 'ok'],
  ] as const)('with %j shipped and %j applied the state is %s', (shipped, applied, expected) => {
    expect(migrationsState(shipped, applied)).toBe(expected);
  });
});

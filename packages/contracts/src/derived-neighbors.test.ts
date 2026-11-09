import { describe, expect, it } from 'vitest';
import { DERIVED_NEIGHBOR_CAP, derivedNeighborsRequestSchema, derivedNeighborsResponseSchema } from './derived-neighbors.js';

const ref = { sourceId: 's', entityType: 'maker', stableId: 'A-1' };
const result = { ruleId: 'shared', ruleVersion: 1, count: { value: 0, quality: 'exact', scope: 'derived:neighbors' }, nodes: [], edges: [], warnings: [] };

describe('the derived neighbors contract', () => {
  it('caps a run at 25 other ends', () => {
    expect(DERIVED_NEIGHBOR_CAP).toBe(25);
  });

  it('takes a source, an entity reference and the masking flag, and nothing else', () => {
    expect(derivedNeighborsRequestSchema.safeParse({ sourceId: 's', ref: { entityType: 'maker', stableId: 'A-1' }, mask: true }).success).toBe(true);
    for (const extra of [{ ruleId: 'shared' }, { limit: 5 }, { via: ['X'] }]) {
      expect(derivedNeighborsRequestSchema.safeParse({ sourceId: 's', ref: { entityType: 'maker', stableId: 'A-1' }, ...extra }).success).toBe(false);
    }
  });

  it('answers one result for each rule, with a count that carries its quality', () => {
    expect(derivedNeighborsResponseSchema.safeParse({ ref, results: [result] }).success).toBe(true);
    expect(derivedNeighborsResponseSchema.safeParse({ ref, results: [{ ...result, count: { value: 25, quality: 'lowerBound', scope: 'x' } }] }).success).toBe(true);
  });

  it('refuses a result with a field the contract does not name, or without a rule version', () => {
    expect(derivedNeighborsResponseSchema.safeParse({ ref, results: [{ ...result, extra: 1 }] }).success).toBe(false);
    expect(derivedNeighborsResponseSchema.safeParse({ ref, results: [{ ...result, ruleVersion: 0 }] }).success).toBe(false);
    expect(derivedNeighborsResponseSchema.safeParse({ ref, results: [{ ruleId: 'x' }] }).success).toBe(false);
  });
});

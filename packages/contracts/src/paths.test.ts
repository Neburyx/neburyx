import { describe, expect, it } from 'vitest';
import { pathsRequestSchema, pathsResponseSchema } from './paths.js';

const request = { sourceId: 'demo', from: { entityType: 'maker', stableId: 'A-1' }, to: { entityType: 'maker', stableId: 'Z-1' }, relTypes: ['LINKS'], maxHops: 3, limit: 5 };

describe('the paths request', () => {
  it('takes two ends, the relationship types, the hop count and the limit', () => {
    expect(pathsRequestSchema.safeParse(request).success).toBe(true);
    expect(pathsRequestSchema.safeParse({ ...request, direction: 'in', mask: true }).success).toBe(true);
  });

  it('refuses an unknown field, a missing end, no relationship type, a hop count or limit below one and a direction other than out, in or both', () => {
    const bad: Record<string, unknown>[] = [{ extra: 1 }, { from: undefined }, { to: undefined }, { relTypes: [] }, { maxHops: 0 }, { limit: 0 }, { direction: 'sideways' }];
    for (const change of bad) expect(pathsRequestSchema.safeParse({ ...request, ...change }).success).toBe(false);
  });
});

describe('the paths response', () => {
  it('holds paths, nodes, relationships and the flags, and no path of no steps', () => {
    const ok = { status: 'ok', paths: [], nodes: [], edges: [], capReached: false, partial: false, elapsedMs: 3, warnings: [] };
    expect(pathsResponseSchema.safeParse(ok).success).toBe(true);
    expect(pathsResponseSchema.safeParse({ ...ok, paths: [{ hops: 1, steps: [] }] }).success).toBe(false);
  });
});

describe('the heavy stop and the continue of a search', () => {
  it('takes a continue flag, and answers a heavy stop with a lower bound at the threshold and a continue limit of at most 25', () => {
    expect(pathsRequestSchema.safeParse({ ...request, continue: true }).success).toBe(true);
    const heavy = { status: 'heavy', estimate: { value: 500, quality: 'lowerBound', scope: 'paths:estimate' }, threshold: 500, continueLimit: 25, warnings: [] };
    expect(pathsResponseSchema.safeParse(heavy).success).toBe(true);
    expect(pathsResponseSchema.safeParse({ ...heavy, estimate: { value: 500, quality: 'exact', scope: 'paths:estimate' } }).success).toBe(false);
    expect(pathsResponseSchema.safeParse({ ...heavy, estimate: { value: 400, quality: 'lowerBound', scope: 'paths:estimate' } }).success).toBe(false);
    expect(pathsResponseSchema.safeParse({ ...heavy, continueLimit: 26 }).success).toBe(false);
  });

  it('carries an optional estimate on the paths of a search that was probed', () => {
    const ok = { status: 'ok', paths: [], nodes: [], edges: [], capReached: false, partial: false, elapsedMs: 1, warnings: [] };
    expect(pathsResponseSchema.safeParse({ ...ok, estimate: { value: 7, quality: 'exact', scope: 'paths:estimate' } }).success).toBe(true);
  });
});

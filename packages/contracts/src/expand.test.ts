import { describe, expect, it } from 'vitest';
import { edgeSchema } from './graph.js';
import { expandPageSchema, expandRequestSchema, expandResponseSchema } from './expand.js';

const request = { sourceId: 'demo', ref: { entityType: 'hub', stableId: 'H-1' }, neighborTypes: ['leaf'] };
const ref = { sourceId: 'demo', entityType: 'hub', stableId: 'H-1' };
const edge = { ref: { sourceId: 'demo', type: 'LINKED', from: 'hub', to: 'leaf', stableId: 'r1' }, from: ref, to: { ...ref, entityType: 'leaf', stableId: 'l1' }, type: 'LINKED', direction: 'out', semantics: 'stored', properties: [], evidenceRefs: [], qualityFlags: [] };
const page = { neighborType: 'leaf', returned: 1, hasMore: false, matchingTotal: { value: 1, quality: 'exact', scope: 'expand:page' } };

describe('the expand request', () => {
  it('takes a node, neighbor types and optionally relationship types, a direction, a sort, a page size, cursors and the mask flag', () => {
    expect(expandRequestSchema.safeParse(request).success).toBe(true);
    expect(expandRequestSchema.safeParse({ ...request, relTypes: ['LINKED'], direction: 'in', sort: 'observed', limit: 10, cursors: { leaf: 'v1.a.b' }, mask: true }).success).toBe(true);
  });

  it.each([
    ['no neighbor type', { ...request, neighborTypes: [] }],
    ['an empty relationship type list', { ...request, relTypes: [] }],
    ['an unknown direction', { ...request, direction: 'sideways' }],
    ['an unknown sort', { ...request, sort: 'newest' }],
    ['a page size that is not a whole number', { ...request, limit: 1.5 }],
    ['an unknown field', { ...request, offset: 5 }],
    ['an empty source', { ...request, sourceId: '' }],
    ['a cursor that is not text', { ...request, cursors: { leaf: 3 } }],
  ])('refuses %s', (_name, body) => {
    expect(expandRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe('the window of the expand request', () => {
  it.each([[{ days: 7 }], [{ days: 3650 }], [{ from: '2026-01-01', to: '2026-01-31' }]])('takes %j', (window) => {
    expect(expandRequestSchema.safeParse({ ...request, window }).success).toBe(true);
  });

  it.each([[{}], [{ days: 0 }], [{ days: 3651 }], [{ days: 1.5 }], [{ days: 1, from: '2026-01-01', to: '2026-01-02' }], [{ from: '2026-01-31', to: '2026-01-01' }], [{ from: '2026-02-30', to: '2026-03-01' }], [{ days: 7, other: 1 }], ['7 days'], [null]])('refuses %j', (window) => {
    expect(expandRequestSchema.safeParse({ ...request, window }).success).toBe(false);
  });
});

describe('the expand response', () => {
  it('holds the node, the page size, the nodes and edges, one page for each type and the warnings', () => {
    expect(expandResponseSchema.safeParse({ ref, pageSize: 25, nodes: [], edges: [edge], pages: [page], warnings: [] }).success).toBe(true);
  });

  it('refuses a page size of zero and a page with a count that is not labelled', () => {
    expect(expandResponseSchema.safeParse({ ref, pageSize: 0, nodes: [], edges: [], pages: [], warnings: [] }).success).toBe(false);
    expect(expandPageSchema.safeParse({ ...page, matchingTotal: 3 }).success).toBe(false);
    expect(expandPageSchema.safeParse({ ...page, matchingTotal: { quality: 'unknown', value: 3, scope: 'x' } }).success).toBe(false);
  });
});

describe('the direction of an edge', () => {
  it.each(['from-to', 'out', 'in'])('accepts %s and nothing else', (direction) => {
    expect(edgeSchema.safeParse({ ...edge, direction }).success).toBe(true);
    expect(edgeSchema.safeParse({ ...edge, direction: 'both' }).success).toBe(false);
  });
});

describe('what the answer says of a window', () => {
  const answer = { ref, pageSize: 25, nodes: [], edges: [], pages: [page], warnings: [] };

  it('holds the two instants and, for each page, how the window applied, and accepts an answer with neither', () => {
    expect(expandResponseSchema.safeParse(answer).success).toBe(true);
    const windowed = { ...answer, window: { from: '2026-11-05T00:00:00.000Z', to: '2026-11-13T00:00:00.000Z' }, pages: [{ ...page, window: { applied: 'partial', notAppliedTo: ['TOUCHED'], undatedLeftOut: 2 } }] };
    expect(expandResponseSchema.safeParse(windowed).success).toBe(true);
    expect(expandPageSchema.safeParse({ ...page, window: { applied: 'full', notAppliedTo: [] } }).success).toBe(true);
  });

  it.each([
    ['an applied that is not full, partial or none', { applied: 'most', notAppliedTo: [] }],
    ['no list of the types it did not apply to', { applied: 'full' }],
    ['a negative number left out', { applied: 'full', notAppliedTo: [], undatedLeftOut: -1 }],
    ['a field that is not named', { applied: 'full', notAppliedTo: [], extra: 1 }],
  ])('refuses %s', (_name, window) => {
    expect(expandPageSchema.safeParse({ ...page, window }).success).toBe(false);
  });

  it('refuses instants that are not dates and times', () => {
    expect(expandResponseSchema.safeParse({ ...answer, window: { from: 'yesterday', to: 'today' } }).success).toBe(false);
  });
});

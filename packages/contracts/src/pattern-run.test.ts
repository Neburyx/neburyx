import { describe, expect, it } from 'vitest';
import { patternMatchSchema, patternRunHeavySchema, patternRunOkSchema, patternRunRequestSchema, patternRunResponseSchema } from './pattern-run.js';

const ref = (entityType: string, stableId: string) => ({ sourceId: 'demo', entityType, stableId });
const hop = (over: Record<string, unknown> = {}) => ({ relationshipType: 'LINKS', from: ref('maker', 'W-1'), to: ref('maker', 'W-2'), stableId: 'L-1', ...over });
const match = (over: Record<string, unknown> = {}) => ({ match: ref('maker', 'W-2'), hops: 1, through: [], relationships: [hop()], ...over });
const count = { value: 1, quality: 'exact', scope: 'template:pattern' };
const ok = (over: Record<string, unknown> = {}) => ({ status: 'ok', templateVersion: '1', count, matches: [match()], nodes: [], edges: [], notices: [], warnings: [], ...over });
const heavy = (over: Record<string, unknown> = {}) => ({ status: 'heavy', templateVersion: '1', estimate: { value: 500, quality: 'lowerBound', scope: 'template:pattern:estimate' }, threshold: 500, continueLimit: 25, notices: [], warnings: [], ...over });

describe('the request of a pattern run', () => {
  const body = { sourceId: 'demo', definition: { anchorType: 'maker' }, anchor: { entityType: 'maker', stableId: 'p1.token' } };

  it('takes the source, any object as the definition, the anchor, and a limit, a mask and a continue', () => {
    expect(patternRunRequestSchema.safeParse(body).success).toBe(true);
    expect(patternRunRequestSchema.safeParse({ ...body, limit: 10, mask: true, continue: true }).success).toBe(true);
    expect(patternRunRequestSchema.safeParse({ ...body, definition: { anything: 1, steps: 'not a list' } }).success).toBe(true);
  });

  it('takes the cursor of the page before, as text that is not empty', () => {
    expect(patternRunRequestSchema.safeParse({ ...body, cursor: 'v1.a.b' }).success).toBe(true);
    expect(patternRunRequestSchema.safeParse({ ...body, cursor: '' }).success).toBe(false);
    expect(patternRunRequestSchema.safeParse({ ...body, cursor: 7 }).success).toBe(false);
  });

  it.each([
    ['no source', { ...body, sourceId: undefined }],
    ['no definition', { ...body, definition: undefined }],
    ['a definition that is a list', { ...body, definition: [] }],
    ['no anchor', { ...body, anchor: undefined }],
    ['an anchor with an extra key', { ...body, anchor: { ...body.anchor, extra: 1 } }],
    ['a limit of zero', { ...body, limit: 0 }],
    ['a limit that is not whole', { ...body, limit: 1.5 }],
    ['a key the schema does not name', { ...body, params: {} }],
  ])('refuses %s', (_name, input) => {
    expect(patternRunRequestSchema.safeParse(input).success).toBe(false);
  });
});

describe('the answer of a pattern run', () => {
  it('carries a next cursor of one or more characters, or none', () => {
    expect(patternRunOkSchema.safeParse(ok({ nextCursor: 'v1.a.b' })).success).toBe(true);
    expect(patternRunOkSchema.safeParse(ok()).success).toBe(true);
    expect(patternRunOkSchema.safeParse(ok({ nextCursor: '' })).success).toBe(false);
    expect(patternRunOkSchema.safeParse(ok({ nextCursor: null })).success).toBe(false);
  });

  it('holds the matches with a path for each: one entity between and one relationship for each hop', () => {
    expect(patternRunOkSchema.safeParse(ok()).success).toBe(true);
    const two = match({ hops: 2, through: [ref('tool', 'T-1')], relationships: [hop(), hop({ from: ref('tool', 'T-1') })] });
    expect(patternMatchSchema.safeParse(two).success).toBe(true);
    expect(patternMatchSchema.safeParse(match({ hops: 4, through: [ref('a', 'W-3'), null, ref('c', 'W-4')], relationships: [hop(), hop(), hop(), hop()] })).success).toBe(true);
  });

  it('accepts a null where an entity or a relationship type is unusable, and refuses an empty relationship type', () => {
    expect(patternMatchSchema.safeParse(match({ relationships: [hop({ relationshipType: null, from: null, to: null })] })).success).toBe(true);
    expect(patternMatchSchema.safeParse(match({ relationships: [hop({ relationshipType: '' })] })).success).toBe(false);
    expect(patternMatchSchema.safeParse(match({ relationships: [{ from: null, to: null }] })).success).toBe(false);
  });

  it.each([
    ['a path with too few entities between', match({ hops: 2, through: [], relationships: [hop(), hop()] })],
    ['a path with too many entities between', match({ hops: 1, through: [ref('tool', 'T-1')] })],
    ['a path with a hop missing', match({ hops: 2, through: [ref('tool', 'T-1')], relationships: [hop()] })],
    ['no hops', match({ hops: 0, through: [], relationships: [] })],
    ['five hops', match({ hops: 5, through: [null, null, null, null], relationships: [hop(), hop(), hop(), hop(), hop()] })],
    ['a key the schema does not name', match({ extra: 1 })],
  ])('refuses %s', (_name, input) => {
    expect(patternMatchSchema.safeParse(input).success).toBe(false);
  });

  it('refuses an answer with a missing member or an extra key', () => {
    expect(patternRunOkSchema.safeParse(ok({ notices: undefined })).success).toBe(false);
    expect(patternRunOkSchema.safeParse(ok({ extra: 1 })).success).toBe(false);
  });

  it('stops as heavy with a lower bound at the threshold and no rows, and never with another quality or value', () => {
    expect(patternRunHeavySchema.safeParse(heavy()).success).toBe(true);
    expect(patternRunHeavySchema.safeParse(heavy({ estimate: { value: 500, quality: 'exact', scope: 's' } })).success).toBe(false);
    expect(patternRunHeavySchema.safeParse(heavy({ estimate: { value: 499, quality: 'lowerBound', scope: 's' } })).success).toBe(false);
    expect(patternRunHeavySchema.safeParse(heavy({ continueLimit: 26 })).success).toBe(false);
    expect(patternRunHeavySchema.safeParse(heavy({ matches: [] })).success).toBe(false);
  });

  it('is one of the two, told apart by the status', () => {
    expect(patternRunResponseSchema.safeParse(ok()).success).toBe(true);
    expect(patternRunResponseSchema.safeParse(heavy()).success).toBe(true);
    expect(patternRunResponseSchema.safeParse({ ...ok(), status: 'heavy' }).success).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { MAX_PATTERN_PROBLEMS } from './pattern.js';
import { PATTERN_UNAVAILABLE_CODES, listedPatternSchema, patternAvailabilitySchema, patternListResponseSchema, savedPatternSchema } from './saved-pattern.js';
import { patternUnavailableSchema, savedPatternRunRequestSchema, savedPatternRunResponseSchema } from './saved-pattern-run.js';

const ref = (entityType: string, stableId: string) => ({ sourceId: 'demo', entityType, stableId });
const count = { value: 1, quality: 'exact', scope: 'template:pattern' };
const patternAnswer = { status: 'ok', templateVersion: '1', count, matches: [{ match: ref('maker', 'W-2'), hops: 1, through: [], relationships: [{ relationshipType: 'LINKS', from: ref('maker', 'W-1'), to: ref('maker', 'W-2') }] }], nodes: [], edges: [], notices: [], warnings: [] };
const templateAnswer = { status: 'ok', templateId: 'linked-entities', templateVersion: '1', count, matchIds: [ref('maker', 'W-2')], nodes: [], edges: [], notices: [], warnings: [] };
const unavailable = { status: 'unavailable', reasons: [{ code: 'unknown-entity-type', path: ['steps', 0, 'arrivesAt'] }] };
const base = { id: '0192f000-0000-7000-8000-000000000001', sourceId: 'demo', name: 'A pattern', askForStartingEntity: true, anchor: null, visibility: 'private', lastRunAt: null, createdAt: '2026-03-01T10:00:00.000Z', updatedAt: '2026-03-01T10:00:00.000Z', version: 1 };
const definitionPattern = { ...base, kind: 'definition', definition: { anchorType: 'maker', steps: [] } };

describe('the request of a saved run', () => {
  it('takes any of the starting entity, a limit, a mask and a continue, or none of them', () => {
    expect(savedPatternRunRequestSchema.safeParse({}).success).toBe(true);
    expect(savedPatternRunRequestSchema.safeParse({ cursor: 'v1.a.b' }).success).toBe(true);
    expect(savedPatternRunRequestSchema.safeParse({ cursor: '' }).success).toBe(false);
    expect(savedPatternRunRequestSchema.safeParse({ anchor: { entityType: 'maker', stableId: 'p1.token' }, limit: 5, mask: true, continue: false }).success).toBe(true);
  });

  it.each([
    ['a source', { sourceId: 'demo' }],
    ['a definition', { definition: {} }],
    ['an extra key', { extra: 1 }],
    ['a limit below one', { limit: 0 }],
    ['an anchor with an extra key', { anchor: { entityType: 'maker', stableId: 'x', extra: 1 } }],
    ['an anchor whose stable ID is longer than a reference may be', { anchor: { entityType: 'maker', stableId: 'x'.repeat(2_000_000) } }],
  ])('refuses %s', (_name, body) => {
    expect(savedPatternRunRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe('the availability of a saved pattern', () => {
  it('is available, or unavailable with one to the cap of reasons, each a known code and a path of keys and indices', () => {
    expect(patternAvailabilitySchema.safeParse({ status: 'available' }).success).toBe(true);
    expect(patternAvailabilitySchema.safeParse(unavailable).success).toBe(true);
    for (const code of PATTERN_UNAVAILABLE_CODES) expect(patternAvailabilitySchema.safeParse({ status: 'unavailable', reasons: [{ code }] }).success).toBe(true);
    expect(patternAvailabilitySchema.safeParse({ status: 'unavailable', reasons: Array.from({ length: MAX_PATTERN_PROBLEMS }, () => ({ code: 'unknown-property' })) }).success).toBe(true);
  });

  it.each([
    ['an unknown code', { status: 'unavailable', reasons: [{ code: 'because' }] }],
    ['no reasons', { status: 'unavailable', reasons: [] }],
    ['too many reasons', { status: 'unavailable', reasons: Array.from({ length: MAX_PATTERN_PROBLEMS + 1 }, () => ({ code: 'unknown-property' })) }],
    ['a path with an object in it', { status: 'unavailable', reasons: [{ code: 'unknown-property', path: [{}] }] }],
    ['reasons on an available pattern', { status: 'available', reasons: [] }],
  ])('refuses %s', (_name, value) => {
    expect(patternAvailabilitySchema.safeParse(value).success).toBe(false);
  });
});

describe('the answer of a saved run', () => {
  it('is the answer of the pattern run, of the template run, or unavailable', () => {
    for (const answer of [patternAnswer, templateAnswer, unavailable]) expect(savedPatternRunResponseSchema.safeParse(answer).success).toBe(true);
    expect(patternUnavailableSchema.safeParse(unavailable).success).toBe(true);
  });

  it('refuses a mixture of them', () => {
    expect(savedPatternRunResponseSchema.safeParse({ ...unavailable, matches: [] }).success).toBe(false);
    expect(savedPatternRunResponseSchema.safeParse({ ...patternAnswer, status: 'unavailable' }).success).toBe(false);
  });
});

const listedOwner = { owner: { name: 'Person' }, ownedByYou: true };

describe('a pattern in the list', () => {
  it('carries its availability, and the answers of save, change and delete do not', () => {
    expect(listedPatternSchema.safeParse({ ...definitionPattern, ...listedOwner, availability: { status: 'available' } }).success).toBe(true);
    expect(listedPatternSchema.safeParse({ ...definitionPattern, availability: { status: 'available' } }).success).toBe(false);
    expect(listedPatternSchema.safeParse(definitionPattern).success).toBe(false);
    expect(savedPatternSchema.safeParse(definitionPattern).success).toBe(true);
    expect(savedPatternSchema.safeParse({ ...definitionPattern, availability: { status: 'available' } }).success).toBe(false);
    expect(patternListResponseSchema.safeParse({ items: [{ ...definitionPattern, ...listedOwner, availability: unavailable }], nextCursor: null }).success).toBe(true);
    expect(patternListResponseSchema.safeParse({ items: [definitionPattern], nextCursor: null }).success).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { SEARCH_GROUP_CAP, searchRequestSchema, searchResultSchema } from './search.js';

const node = {
  ref: { sourceId: 'demo', entityType: 'widget', stableId: 'AC-1' },
  display: { title: 'AC-1', type: 'widget' },
  properties: [],
  qualityFlags: [],
  provenanceRefs: [],
  authorization: { canInspect: true, canExport: true },
};
const result = {
  sourceId: 'demo',
  exact: [node],
  counts: { exact: { value: 1, quality: 'exact', scope: 'search:exact' } },
  cap: 25,
  searchable: true,
  disabledTypes: [],
  dropped: { 'not-mapped': 0, 'ambiguous-type': 0, 'no-stable-id': 0 },
  warnings: [],
  elapsedMs: 12,
};

describe('the search request', () => {
  it.each([
    ['an empty text', { sourceId: 'demo', text: '' }],
    ['201 characters', { sourceId: 'demo', text: 'a'.repeat(201) }],
    ['an empty source', { sourceId: '', text: 'ab' }],
    ['a field the contract does not name', { sourceId: 'demo', text: 'ab', limit: 5 }],
    ['a mask that is not a boolean', { sourceId: 'demo', text: 'ab', mask: 'true' }],
    ['no text', { sourceId: 'demo' }],
  ])('refuses %s', (_name, body) => {
    expect(searchRequestSchema.safeParse(body).success).toBe(false);
  });

  it('counts the length of the text in characters, not in UTF-16 units', () => {
    expect(searchRequestSchema.safeParse({ sourceId: 'demo', text: '😀'.repeat(200) }).success).toBe(true);
    expect(searchRequestSchema.safeParse({ sourceId: 'demo', text: '😀'.repeat(201) }).success).toBe(false);
    expect(searchRequestSchema.safeParse({ sourceId: 'demo', text: '😀' }).success).toBe(true);
    expect(searchRequestSchema.safeParse({ sourceId: 'demo', text: '😀😀' }).success).toBe(true);
  });

  it('accepts a text of 1 and of 200 characters, with and without the mask', () => {
    expect(searchRequestSchema.safeParse({ sourceId: 'demo', text: 'ab' }).success).toBe(true);
    expect(searchRequestSchema.safeParse({ sourceId: 'demo', text: 'a'.repeat(200), mask: true }).success).toBe(true);
  });
});

describe('the search result', () => {
  it('accepts an answer with exact and lower-bound counts', () => {
    expect(searchResultSchema.safeParse(result).success).toBe(true);
    expect(searchResultSchema.safeParse({ ...result, counts: { exact: { value: SEARCH_GROUP_CAP, quality: 'lowerBound', scope: 'search:exact' } } }).success).toBe(true);
  });

  it('refuses a count that is neither exact nor a lower bound', () => {
    expect(searchResultSchema.safeParse({ ...result, counts: { exact: { value: 3, quality: 'estimated', scope: 'search:exact' } } }).success).toBe(false);
    expect(searchResultSchema.safeParse({ ...result, counts: { exact: { quality: 'unknown', scope: 'search:exact' } } }).success).toBe(false);
  });

  it('refuses an unknown reason for a disabled type and an unknown field', () => {
    expect(searchResultSchema.safeParse({ ...result, disabledTypes: [{ entityType: 'widget', reason: 'because' }] }).success).toBe(false);
    expect(searchResultSchema.safeParse({ ...result, extra: true }).success).toBe(false);
  });

  it('holds the cap as a named constant of 25', () => {
    expect(SEARCH_GROUP_CAP).toBe(25);
  });
});

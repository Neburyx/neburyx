import { describe, expect, it } from 'vitest';
import { SEARCH_GROUP_CAP, searchRequestSchema, searchResultSchema, typeaheadTextSchema } from './search.js';

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
  failures: [],
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

describe('the type-ahead flag of the search request', () => {
  it.each([
    ['one character', { sourceId: 'demo', text: 'a', typeahead: true }],
    ['201 characters', { sourceId: 'demo', text: 'a'.repeat(201), typeahead: true }],
    ['one character outside the basic plane', { sourceId: 'demo', text: '😀', typeahead: true }],
    ['a flag that is not a boolean', { sourceId: 'demo', text: 'ab', typeahead: 'yes' }],
    ['one character with the flag true and a mask', { sourceId: 'demo', text: 'a', typeahead: true, mask: true }],
  ])('refuses %s', (_name, body) => {
    expect(searchRequestSchema.safeParse(body).success).toBe(false);
  });

  it.each([
    ['one character without the flag', { sourceId: 'demo', text: 'a' }],
    ['one character with the flag false', { sourceId: 'demo', text: 'a', typeahead: false }],
    ['two characters with the flag', { sourceId: 'demo', text: 'ab', typeahead: true }],
    ['200 code points with the flag', { sourceId: 'demo', text: '😀'.repeat(200), typeahead: true }],
  ])('accepts %s', (_name, body) => {
    expect(searchRequestSchema.safeParse(body).success).toBe(true);
  });

  it('counts the text of a type-ahead lookup in code points, 2 to 200', () => {
    expect(typeaheadTextSchema.safeParse('😀').success).toBe(false);
    expect(typeaheadTextSchema.safeParse('😀😀').success).toBe(true);
    expect(typeaheadTextSchema.safeParse('a'.repeat(201)).success).toBe(false);
  });
});

describe('the startsWith group of the search result', () => {
  const group = { nodes: [node], count: { value: 1, quality: 'exact', scope: 'search:startsWith' }, dropped: { 'not-mapped': 0, 'ambiguous-type': 0, 'no-stable-id': 0 }, warnings: [] };

  it('is optional, and holds nodes, a count, the rows left out and the warnings', () => {
    expect(searchResultSchema.safeParse(result).success).toBe(true);
    expect(searchResultSchema.safeParse({ ...result, startsWith: group }).success).toBe(true);
  });

  it.each([
    ['an estimated count', { ...group, count: { value: 3, quality: 'estimated', scope: 'search:startsWith' } }],
    ['an unknown count', { ...group, count: { quality: 'unknown', scope: 'search:startsWith' } }],
    ['no list of dropped rows', { nodes: group.nodes, count: group.count, warnings: [] }],
    ['a field the contract does not name', { ...group, cap: 25 }],
  ])('refuses %s', (_name, startsWith) => {
    expect(searchResultSchema.safeParse({ ...result, startsWith }).success).toBe(false);
  });

  it('takes a lower bound', () => {
    expect(searchResultSchema.safeParse({ ...result, startsWith: { ...group, count: { value: 25, quality: 'lowerBound', scope: 'search:startsWith' } } }).success).toBe(true);
  });
});

describe('the failures of the search result', () => {
  const group = { nodes: [], count: { quality: 'unknown', scope: 'search:startsWith' }, dropped: { 'not-mapped': 0, 'ambiguous-type': 0, 'no-stable-id': 0 }, warnings: [] };
  const failedPrefix = { ...result, startsWith: group, failures: [{ group: 'startsWith', code: 'QUERY_TIMEOUT', timeoutMs: 5000 }] };
  const answeredGroup = { ...group, count: { value: 0, quality: 'exact', scope: 'search:startsWith' } };
  const failedExact = { ...result, exact: [], counts: { exact: { quality: 'unknown', scope: 'search:exact' } }, startsWith: answeredGroup, failures: [{ group: 'exact', code: 'SOURCE_BUSY' }] };

  it.each([
    ['a failed prefix group, unknown and empty', failedPrefix],
    ['a failed exact group, unknown and empty, beside an answered prefix group', failedExact],
  ])('accepts %s', (_name, body) => {
    expect(searchResultSchema.safeParse(body).success).toBe(true);
  });

  it.each([
    ['a failed group whose count is not unknown', { ...failedPrefix, startsWith: { ...group, count: { value: 0, quality: 'exact', scope: 'search:startsWith' } } }],
    ['an unknown count of a group that did not fail', { ...failedPrefix, failures: [] }],
    ['a failed group that holds hits', { ...failedPrefix, startsWith: { ...group, nodes: [node] } }],
    ['a failed exact group that holds hits', { ...failedExact, exact: [node] }],
    ['an unknown exact count with no failure', { ...result, counts: { exact: { quality: 'unknown', scope: 'search:exact' } } }],
    ['a group that fails twice', { ...failedPrefix, failures: [...failedPrefix.failures, ...failedPrefix.failures] }],
    ['a failure of the prefix group when there is no prefix group', { ...result, failures: [{ group: 'startsWith', code: 'QUERY_TIMEOUT' }] }],
    ['a failure code that belongs to the whole search', { ...failedPrefix, failures: [{ group: 'startsWith', code: 'SOURCE_UNAVAILABLE' }] }],
    ['an exact failure with no prefix group to answer', { ...failedExact, startsWith: undefined }],
    ['both groups failed', { ...failedPrefix, exact: [], counts: { exact: { quality: 'unknown', scope: 'search:exact' } }, failures: [...failedPrefix.failures, { group: 'exact', code: 'SOURCE_BUSY' }] }],
    ['no list of failures', Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'failures'))],
  ])('refuses %s', (_name, body) => {
    expect(searchResultSchema.safeParse(body).success).toBe(false);
  });
});

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
  related: { hits: [], count: { value: 0, quality: 'exact', scope: 'search:related' }, searchable: true, disabledTypes: [] },
  evidence: { hits: [], count: { value: 0, quality: 'exact', scope: 'search:evidence' }, searchable: false, disabledRelationshipTypes: [] },
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

  it('accepts a related group with hits, and holds its count as exact or a lower bound only', () => {
    const related = { hits: [{ node, matchedProperties: ['batchRef'] }], count: { value: 1, quality: 'exact', scope: 'search:related' }, searchable: true, disabledTypes: [{ entityType: 'widget', reason: 'index-unavailable' }] };
    expect(searchResultSchema.safeParse({ ...result, related }).success).toBe(true);
    expect(searchResultSchema.safeParse({ ...result, related: { ...related, count: { value: SEARCH_GROUP_CAP, quality: 'lowerBound', scope: 'search:related' } } }).success).toBe(true);
    expect(searchResultSchema.safeParse({ ...result, related: { ...related, count: { value: 1, quality: 'estimated', scope: 'search:related' } } }).success).toBe(false);
    expect(searchResultSchema.safeParse({ ...result, related: { ...related, count: { quality: 'unknown', scope: 'search:related' } } }).success).toBe(false);
  });

  it('refuses an answer with no related group, a related hit that is not a node and an unknown field of the group', () => {
    const { related: _related, ...without } = result;
    expect(searchResultSchema.safeParse(without).success).toBe(false);
    expect(searchResultSchema.safeParse({ ...result, related: { ...result.related, hits: [{ node: { title: 'x' } }] } }).success).toBe(false);
    expect(searchResultSchema.safeParse({ ...result, related: { ...result.related, extra: true } }).success).toBe(false);
    expect(searchResultSchema.safeParse({ ...result, related: { ...result.related, hits: [{ node }] } }).success).toBe(false);
    expect(searchResultSchema.safeParse({ ...result, related: { ...result.related, hits: [{ node, matchedProperties: [''] }] } }).success).toBe(false);
    expect(searchResultSchema.safeParse({ ...result, related: { ...result.related, hits: [{ node, matchedProperties: [], via: 'OWNS' }] } }).success).toBe(false);
  });

  it('accepts a group whose read failed with an unknown count and no hits, and refuses an unknown count for a group that did not fail', () => {
    const failedRelated = { ...result, related: { ...result.related, count: { quality: 'unknown', scope: 'search:related' } }, failures: [{ group: 'related', code: 'QUERY_TIMEOUT', timeoutMs: 5000 }] };
    expect(searchResultSchema.safeParse(failedRelated).success).toBe(true);
    const failedExact = { ...result, exact: [], counts: { exact: { quality: 'unknown', scope: 'search:exact' } }, failures: [{ group: 'exact', code: 'SOURCE_BUSY' }] };
    expect(searchResultSchema.safeParse(failedExact).success).toBe(true);
    expect(searchResultSchema.safeParse({ ...result, related: { ...result.related, count: { quality: 'unknown', scope: 'search:related' } } }).success).toBe(false);
    expect(searchResultSchema.safeParse({ ...result, counts: { exact: { quality: 'unknown', scope: 'search:exact' } } }).success).toBe(false);
  });

  it('refuses a failed group that still has a number or hits, a group named twice, and a code that fails the whole search', () => {
    const failedRelated = { ...result, related: { ...result.related, count: { quality: 'unknown', scope: 'search:related' } }, failures: [{ group: 'related', code: 'QUERY_TIMEOUT' }] };
    expect(searchResultSchema.safeParse({ ...failedRelated, related: { ...failedRelated.related, count: { value: 0, quality: 'exact', scope: 'search:related' } } }).success).toBe(false);
    expect(searchResultSchema.safeParse({ ...failedRelated, related: { ...failedRelated.related, hits: [{ node, matchedProperties: [] }] } }).success).toBe(false);
    expect(searchResultSchema.safeParse({ ...failedRelated, failures: [...failedRelated.failures, ...failedRelated.failures] }).success).toBe(false);
    expect(searchResultSchema.safeParse({ ...failedRelated, failures: [{ group: 'related', code: 'SOURCE_UNAVAILABLE' }] }).success).toBe(false);
    expect(searchResultSchema.safeParse({ ...failedRelated, failures: [{ group: 'evidence', code: 'QUERY_TIMEOUT' }] }).success).toBe(false);
    expect(searchResultSchema.safeParse({ ...failedRelated, failures: [{ group: 'related', code: 'QUERY_TIMEOUT', timeoutMs: 0 }] }).success).toBe(false);
  });

  describe('the evidence group', () => {
    const supports = { sourceId: 'demo', type: 'MADE_FROM', from: 'widget', to: 'gadget', stableId: 'L-1' };
    const hit = { supports, records: [{ sourceRecordId: 'REC-1' }], rules: [] };
    const evidence = { hits: [hit], count: { value: 1, quality: 'exact', scope: 'search:evidence' }, searchable: true, disabledRelationshipTypes: [{ relationshipType: 'MADE_FROM', from: 'widget', to: 'part', reason: 'no-stable-id' }] };

    it('accepts a hit with rules', () => {
      expect(searchResultSchema.safeParse({ ...result, evidence: { ...evidence, hits: [{ ...hit, rules: [{ ruleId: 'first', ruleVersion: 1 }, { ruleId: 'second', ruleVersion: 2 }] }] } }).success).toBe(true);
    });

    it('accepts hits, a count of its own and the rows left out', () => {
      expect(searchResultSchema.safeParse({ ...result, evidence }).success).toBe(true);
      expect(searchResultSchema.safeParse({ ...result, evidence: { ...evidence, count: { value: SEARCH_GROUP_CAP, quality: 'lowerBound', scope: 'search:evidence' } } }).success).toBe(true);
    });

    it.each([
      ['an answer with no evidence group', undefined],
      ['a hit with no reference', { ...evidence, hits: [{ ...hit, supports: undefined }] }],
      ['a reference in the old shape', { ...evidence, hits: [{ ...hit, supports: { sourceId: 'demo', stableId: 'L-1' } }] }],
      ['an aggregate reference', { ...evidence, hits: [{ ...hit, supports: { sourceId: 'demo', aggregate: { type: 'MADE_FROM', from: node.ref, to: node.ref } } }] }],
      ['a hit with no record', { ...evidence, hits: [{ ...hit, records: [] }] }],
      ['an empty record ID', { ...evidence, hits: [{ ...hit, records: [{ sourceRecordId: '' }] }] }],
      ['a hit with no list of rules', { ...evidence, hits: [{ supports, records: hit.records }] }],
      ['a rule with no ruleId', { ...evidence, hits: [{ ...hit, rules: [{ ruleVersion: 1 }] }] }],
      ['a rule with an empty ruleId', { ...evidence, hits: [{ ...hit, rules: [{ ruleId: '', ruleVersion: 1 }] }] }],
      ['a rule version of zero', { ...evidence, hits: [{ ...hit, rules: [{ ruleId: 'first', ruleVersion: 0 }] }] }],
      ['a rule version that is not an integer', { ...evidence, hits: [{ ...hit, rules: [{ ruleId: 'first', ruleVersion: 1.5 }] }] }],
      ['a rule version that is text', { ...evidence, hits: [{ ...hit, rules: [{ ruleId: 'first', ruleVersion: '1' }] }] }],
      ['a reason for a row left out that is not one of the two', { ...evidence, disabledRelationshipTypes: [{ relationshipType: 'MADE_FROM', from: 'widget', to: 'part', reason: 'because' }] }],
      ['a row left out with no ends', { ...evidence, disabledRelationshipTypes: [{ relationshipType: 'MADE_FROM', reason: 'no-stable-id' }] }],
      ['an estimated count', { ...evidence, count: { value: 1, quality: 'estimated', scope: 'search:evidence' } }],
      ['a field the group does not name', { ...evidence, facets: [] }],
    ])('refuses %s', (_name, group) => {
      expect(searchResultSchema.safeParse({ ...result, evidence: group }).success).toBe(false);
    });
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
  const unread = { ...result.related, searchable: false };
  const failedExact = { ...result, exact: [], counts: { exact: { quality: 'unknown', scope: 'search:exact' } }, startsWith: answeredGroup, failures: [{ group: 'exact', code: 'SOURCE_BUSY' }] };

  const failedRelated = { ...result, related: { ...result.related, count: { quality: 'unknown', scope: 'search:related' } }, failures: [{ group: 'related', code: 'QUERY_TIMEOUT', timeoutMs: 5000 }] };

  it.each([
    ['a failed related group, unknown and empty, beside an answered exact group', failedRelated],
    ['a failed prefix group, unknown and empty', failedPrefix],
    ['a failed exact group, unknown and empty, beside an answered prefix group', failedExact],
  ])('accepts %s', (_name, body) => {
    expect(searchResultSchema.safeParse(body).success).toBe(true);
  });

  describe('of the evidence group', () => {
    const answered = { ...result, evidence: { hits: [], count: { value: 0, quality: 'exact', scope: 'search:evidence' }, searchable: true, disabledRelationshipTypes: [] } };
    const failedEvidence = { ...answered, evidence: { ...answered.evidence, count: { quality: 'unknown', scope: 'search:evidence' } }, failures: [{ group: 'evidence', code: 'QUERY_TIMEOUT', timeoutMs: 5000 }] };
    const supports = { sourceId: 'demo', type: 'MADE_FROM', from: 'widget', to: 'gadget', stableId: 'L-1' };

    it('accepts a failed evidence group, unknown and empty, beside an answered exact group', () => {
      expect(searchResultSchema.safeParse(failedEvidence).success).toBe(true);
    });

    const noExact = { ...result, searchable: false, exact: [], counts: { exact: { value: 0, quality: 'exact', scope: 'search:exact' } } };
    const unknownRelated = { quality: 'unknown', scope: 'search:related' };
    const unknownEvidence = { quality: 'unknown', scope: 'search:evidence' };

    it('accepts an answer in which nothing was searched, and a failed evidence group beside an answered related group when the exact group was not searched', () => {
      const nothing = { ...noExact, related: { ...result.related, searchable: false }, evidence: { ...answered.evidence, searchable: false } };
      expect(searchResultSchema.safeParse(nothing).success).toBe(true);
      const beside = { ...noExact, evidence: { ...failedEvidence.evidence }, failures: failedEvidence.failures };
      expect(searchResultSchema.safeParse(beside).success).toBe(true);
    });

    it.each([
      ['the evidence group was the only one read and it failed', { ...noExact, related: { ...result.related, searchable: false }, evidence: failedEvidence.evidence, failures: failedEvidence.failures }],
      ['the related and the evidence group were the only ones read and both failed', { ...noExact, related: { ...result.related, count: unknownRelated }, evidence: { ...failedEvidence.evidence, count: unknownEvidence }, failures: [{ group: 'related', code: 'QUERY_TIMEOUT' }, { group: 'evidence', code: 'QUERY_TIMEOUT' }] }],
    ])('refuses an answer in which %s', (_name, body) => {
      expect(searchResultSchema.safeParse(body).success).toBe(false);
    });

    it.each([
      ['an unknown evidence count with no failure', { ...failedEvidence, failures: [] }],
      ['a failed evidence group whose count is not unknown', { ...failedEvidence, evidence: answered.evidence }],
      ['a failed evidence group that holds hits', { ...failedEvidence, evidence: { ...failedEvidence.evidence, hits: [{ supports, records: [{ sourceRecordId: 'REC-1' }], rules: [] }] } }],
      ['a failure of an evidence group that was not read', { ...failedEvidence, evidence: { ...failedEvidence.evidence, searchable: false } }],
      ['a failure of a related group that was not read', { ...result, related: { ...result.related, searchable: false, count: { quality: 'unknown', scope: 'search:related' } }, failures: [{ group: 'related', code: 'QUERY_TIMEOUT' }] }],
      ['a failure of an exact group that was not read', { ...result, searchable: false, exact: [], counts: { exact: { quality: 'unknown', scope: 'search:exact' } }, failures: [{ group: 'exact', code: 'QUERY_TIMEOUT' }] }],
      ['every group that was read failed', { ...failedEvidence, searchable: true, exact: [], counts: { exact: { quality: 'unknown', scope: 'search:exact' } }, related: { ...result.related, count: { quality: 'unknown', scope: 'search:related' } }, failures: [{ group: 'exact', code: 'QUERY_TIMEOUT' }, { group: 'related', code: 'QUERY_TIMEOUT' }, { group: 'evidence', code: 'QUERY_TIMEOUT' }] }],
    ])('refuses %s', (_name, body) => {
      expect(searchResultSchema.safeParse(body).success).toBe(false);
    });
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
    ['an exact failure with no other group to answer', { ...failedExact, startsWith: undefined, related: unread }],
    ['both groups failed', { ...failedPrefix, related: unread, exact: [], counts: { exact: { quality: 'unknown', scope: 'search:exact' } }, failures: [...failedPrefix.failures, { group: 'exact', code: 'SOURCE_BUSY' }] }],
    ['a failed related group whose count is not unknown', { ...failedRelated, related: { ...result.related } }],
    ['a failed related group that holds hits', { ...failedRelated, related: { ...failedRelated.related, hits: [{ node, matchedProperties: [] }] } }],
    ['an unknown related count with no failure', { ...failedRelated, failures: [] }],
    ['an exact and a related group that both failed', { ...failedRelated, exact: [], counts: { exact: { quality: 'unknown', scope: 'search:exact' } }, failures: [...failedRelated.failures, { group: 'exact', code: 'SOURCE_BUSY' }] }],
    ['no list of failures', Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'failures'))],
  ])('refuses %s', (_name, body) => {
    expect(searchResultSchema.safeParse(body).success).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { SEARCH_GROUP_CAP, relationshipsOf, searchMoreRequestSchema, searchMoreResultSchema, searchRequestSchema, searchResultSchema, typeaheadTextSchema } from './search.js';

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
  exactMatches: [{ ref: node.ref, matchedProperties: ['widgetId'] }],
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
  facets: {
    searchable: true,
    total: { value: 1, quality: 'exact', scope: 'search:facet:total' },
    entityType: [{ entityType: 'widget', count: { value: 1, quality: 'exact', scope: 'search:facet:entityType' } }],
    matchMode: [{ mode: 'exact', count: { value: 1, quality: 'exact', scope: 'search:facet:matchMode' } }],
  },
  filters: { entityTypes: [], matchModes: [] },
};
const { facets: _facets, filters: _filters, ...typeahead } = result;

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
    expect(searchResultSchema.safeParse({ ...result, disabledTypes: [{ entityType: 'widget', property: 'widgetId', reason: 'because', typeSearched: false }] }).success).toBe(false);
    expect(searchResultSchema.safeParse({ ...result, extra: true }).success).toBe(false);
  });

  describe('a property that is not searched', () => {
    const entry = (property: string, reason: string, typeSearched: boolean) => ({ entityType: 'widget', property, reason, typeSearched });
    const accepts = (disabledTypes: unknown[]): boolean => searchResultSchema.safeParse({ ...result, disabledTypes, related: { ...result.related, disabledTypes } }).success;

    it.each(['index-unavailable', 'index-building', 'index-failed'])('is named with its type, its property and the reason %s', (reason) => {
      expect(accepts([entry('ownerName', reason, true)])).toBe(true);
    });

    it('names the type as not searched in every entry of it, each with its own property and reason', () => {
      expect(accepts([entry('widgetId', 'index-building', false), entry('ownerName', 'index-failed', false)])).toBe(true);
    });

    it.each([
      ['an entry with no property', [{ entityType: 'widget', reason: 'index-unavailable', typeSearched: true }]],
      ['an entry that does not say whether the type is searched', [{ entityType: 'widget', property: 'ownerName', reason: 'index-unavailable' }]],
      ['the reason no-stable-id, which only a relationship row has', [entry('ownerName', 'no-stable-id', true)]],
      ['a property named twice', [entry('ownerName', 'index-failed', true), entry('ownerName', 'index-building', true)]],
      ['two entries of a type that disagree on whether it is searched', [entry('widgetId', 'index-building', false), entry('ownerName', 'index-failed', true)]],
    ])('is refused for %s', (_name, disabledTypes) => {
      expect(accepts(disabledTypes)).toBe(false);
    });
  });

  it('accepts a related group with hits, and holds its count as exact or a lower bound only', () => {
    const related = { hits: [{ node, matchedProperties: ['batchRef'] }], count: { value: 1, quality: 'exact', scope: 'search:related' }, searchable: true, disabledTypes: [{ entityType: 'widget', property: 'ownerRef', reason: 'index-unavailable', typeSearched: true }] };
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
    const failedExact = { ...result, exact: [], exactMatches: [], counts: { exact: { quality: 'unknown', scope: 'search:exact' } }, failures: [{ group: 'exact', code: 'SOURCE_BUSY' }] };
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
    const evidence = {
      hits: [hit],
      count: { value: 1, quality: 'exact', scope: 'search:evidence' },
      searchable: true,
      disabledRelationshipTypes: [
        ...['index-unavailable', 'index-building', 'index-failed'].map((reason) => ({ relationshipType: 'USED_IN', from: 'widget', to: 'part', property: `record-${reason}`, reason })),
      ],
    };

    const member = (record = 'REC-1') => ({ records: [{ sourceRecordId: record }] });
    const aggregateHit = { aggregate: { type: 'MADE_FROM', from: node.ref, to: node.ref }, members: [member('REC-1'), { ...member('REC-2'), observedAt: '2026-01-02T03:04:05Z' }], memberCount: { value: 2, quality: 'exact' as const, scope: 'members' }, rules: [] };

    it('accepts an aggregate hit with its members, as exact or a lower bound', () => {
      expect(searchResultSchema.safeParse({ ...result, evidence: { ...evidence, hits: [hit, aggregateHit], count: { value: 3, quality: 'exact', scope: 'search:evidence' } } }).success).toBe(true);
      expect(searchResultSchema.safeParse({ ...result, evidence: { ...evidence, hits: [{ ...aggregateHit, memberCount: { value: 2, quality: 'lowerBound', scope: 'members' } }] } }).success).toBe(true);
    });

    it('accepts a record that cannot be read, named by its property, in a stored hit and in a member', () => {
      const unreadable = { property: 'docId', unreadable: true };
      expect(searchResultSchema.safeParse({ ...result, evidence: { ...evidence, hits: [{ ...hit, records: [unreadable] }] } }).success).toBe(true);
      expect(searchResultSchema.safeParse({ ...result, evidence: { ...evidence, hits: [{ ...aggregateHit, members: [{ records: [{ sourceRecordId: 'REC-1' }, unreadable] }], memberCount: { value: 1, quality: 'exact', scope: 'members' } }] } }).success).toBe(true);
    });

    it('counts a stored hit as one relationship and an aggregate as its members', () => {
      expect(relationshipsOf([hit, aggregateHit])).toBe(3);
      expect(relationshipsOf([])).toBe(0);
    });

    it.each([
      ['a record marked unreadable with no property', { ...hit, records: [{ unreadable: true }] }],
      ['a record marked unreadable that also holds a value', { ...hit, records: [{ property: 'docId', unreadable: true, sourceRecordId: 'REC-1' }] }],
      ['a record marked readable', { ...hit, records: [{ property: 'docId', unreadable: false }] }],
      ['an aggregate with no member', { ...aggregateHit, members: [], memberCount: { value: 0, quality: 'exact', scope: 'members' } }],
      ['a member count that is not the members listed', { ...aggregateHit, memberCount: { value: 3, quality: 'exact', scope: 'members' } }],
      ['an estimated member count', { ...aggregateHit, memberCount: { value: 2, quality: 'estimated', scope: 'members' } }],
      ['an unknown member count', { ...aggregateHit, memberCount: { quality: 'unknown', scope: 'members' } }],
      ['a member with no record', { ...aggregateHit, members: [{ records: [] }, member('REC-2')] }],
      ['a member with an element ID', { ...aggregateHit, members: [{ ...member(), elementId: '5:r:1' }, member('REC-2')] }],
      ['a member with a reference', { ...aggregateHit, members: [{ ...member(), ref: node.ref }, member('REC-2')] }],
      ['a member with a stable ID', { ...aggregateHit, members: [{ ...member(), stableId: 'L-1' }, member('REC-2')] }],
      ['an aggregate with a stored reference', { ...aggregateHit, supports: hit.supports }],
      ['an aggregate with no member count', { aggregate: aggregateHit.aggregate, members: aggregateHit.members, rules: [] }],
      ['an aggregate whose end has no stable ID', { ...aggregateHit, aggregate: { type: 'MADE_FROM', from: { sourceId: 'demo', entityType: 'widget' }, to: node.ref } }],
    ])('refuses %s', (_name, refused) => {
      expect(searchResultSchema.safeParse({ ...result, evidence: { ...evidence, hits: [refused] } }).success).toBe(false);
    });

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
      ['a reason for a row left out that is not one of its reasons', { ...evidence, disabledRelationshipTypes: [{ relationshipType: 'MADE_FROM', from: 'widget', to: 'part', reason: 'because' }] }],
      ['a row left out with no ends', { ...evidence, disabledRelationshipTypes: [{ relationshipType: 'MADE_FROM', property: 'recordId', reason: 'index-unavailable' }] }],
      ['a whole row left out for having no stable ID', { ...evidence, disabledRelationshipTypes: [{ relationshipType: 'MADE_FROM', from: 'widget', to: 'part', reason: 'no-stable-id' }] }],
      ['a property not searched with no property named', { ...evidence, disabledRelationshipTypes: [{ relationshipType: 'MADE_FROM', from: 'widget', to: 'part', reason: 'index-building' }] }],
      ['a row with no stable ID that names a property', { ...evidence, disabledRelationshipTypes: [{ relationshipType: 'MADE_FROM', from: 'widget', to: 'part', property: 'recordId', reason: 'no-stable-id' }] }],
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
    expect(searchResultSchema.safeParse({ ...typeahead, startsWith: group }).success).toBe(true);
  });

  it.each([
    ['an estimated count', { ...group, count: { value: 3, quality: 'estimated', scope: 'search:startsWith' } }],
    ['an unknown count', { ...group, count: { quality: 'unknown', scope: 'search:startsWith' } }],
    ['no list of dropped rows', { nodes: group.nodes, count: group.count, warnings: [] }],
    ['a field the contract does not name', { ...group, cap: 25 }],
    ['a next cursor, as the group is capped and has no next page', { ...group, count: { value: 25, quality: 'lowerBound', scope: 'search:startsWith' }, nextCursor: 'v1.a.b' }],
  ])('refuses %s', (_name, startsWith) => {
    expect(searchResultSchema.safeParse({ ...typeahead, startsWith }).success).toBe(false);
  });

  it('takes a lower bound with no cursor', () => {
    expect(searchResultSchema.safeParse({ ...typeahead, startsWith: { ...group, count: { value: 25, quality: 'lowerBound', scope: 'search:startsWith' } } }).success).toBe(true);
  });
});

describe('the failures of the search result', () => {
  const group = { nodes: [], count: { quality: 'unknown', scope: 'search:startsWith' }, dropped: { 'not-mapped': 0, 'ambiguous-type': 0, 'no-stable-id': 0 }, warnings: [] };
  const failedPrefix = { ...typeahead, startsWith: group, failures: [{ group: 'startsWith', code: 'QUERY_TIMEOUT', timeoutMs: 5000 }] };
  const answeredGroup = { ...group, count: { value: 0, quality: 'exact', scope: 'search:startsWith' } };
  const unread = { ...result.related, searchable: false };
  const failedExact = { ...typeahead, exact: [], exactMatches: [], counts: { exact: { quality: 'unknown', scope: 'search:exact' } }, startsWith: answeredGroup, failures: [{ group: 'exact', code: 'SOURCE_BUSY' }] };

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

    const noExact = { ...result, searchable: false, exact: [], exactMatches: [], counts: { exact: { value: 0, quality: 'exact', scope: 'search:exact' } } };
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
      ['a failure of an exact group that was not read', { ...result, searchable: false, exact: [], exactMatches: [], counts: { exact: { quality: 'unknown', scope: 'search:exact' } }, failures: [{ group: 'exact', code: 'QUERY_TIMEOUT' }] }],
      ['every group that was read failed', { ...failedEvidence, searchable: true, exact: [], exactMatches: [], counts: { exact: { quality: 'unknown', scope: 'search:exact' } }, related: { ...result.related, count: { quality: 'unknown', scope: 'search:related' } }, failures: [{ group: 'exact', code: 'QUERY_TIMEOUT' }, { group: 'related', code: 'QUERY_TIMEOUT' }, { group: 'evidence', code: 'QUERY_TIMEOUT' }] }],
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
    ['both groups failed', { ...failedPrefix, related: unread, exact: [], exactMatches: [], counts: { exact: { quality: 'unknown', scope: 'search:exact' } }, failures: [...failedPrefix.failures, { group: 'exact', code: 'SOURCE_BUSY' }] }],
    ['a failed related group whose count is not unknown', { ...failedRelated, related: { ...result.related } }],
    ['a failed related group that holds hits', { ...failedRelated, related: { ...failedRelated.related, hits: [{ node, matchedProperties: [] }] } }],
    ['an unknown related count with no failure', { ...failedRelated, failures: [] }],
    ['an exact and a related group that both failed', { ...failedRelated, exact: [], exactMatches: [], counts: { exact: { quality: 'unknown', scope: 'search:exact' } }, failures: [...failedRelated.failures, { group: 'exact', code: 'SOURCE_BUSY' }] }],
    ['no list of failures', Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'failures'))],
  ])('refuses %s', (_name, body) => {
    expect(searchResultSchema.safeParse(body).success).toBe(false);
  });
});

describe('the facets of the search result', () => {
  const entry = (entityType: string, value = 1, quality: 'exact' | 'lowerBound' = 'exact') => ({ entityType, count: { value, quality, scope: 'search:facet:entityType' } });
  const mode = (name: string, value = 1, quality: 'exact' | 'lowerBound' = 'exact') => ({ mode: name, count: { value, quality, scope: 'search:facet:matchMode' } });
  const total = { value: 2, quality: 'exact', scope: 'search:facet:total' };
  const facets = { searchable: true, total, entityType: [entry('widget'), entry('gadget')], matchMode: [mode('exact'), mode('related'), mode('evidence')] };
  const parse = (override: Record<string, unknown>) => searchResultSchema.safeParse({ ...result, ...override }).success;

  it('accepts entries of every kind with exact and lower-bound counts, and an answer that has nothing to count', () => {
    expect(parse({ facets })).toBe(true);
    expect(parse({ facets: { ...facets, total: { value: 25, quality: 'lowerBound', scope: 'search:facet:total' }, entityType: [entry('widget', 25, 'lowerBound')] } })).toBe(true);
    expect(parse({ facets: { searchable: false } })).toBe(true);
    expect(parse({ facets: { ...facets, entityType: [], matchMode: [] } })).toBe(true);
  });

  it('accepts a type-ahead answer, which holds neither the facets nor the filters', () => {
    const group = { nodes: [], count: { value: 0, quality: 'exact', scope: 'search:startsWith' }, dropped: { 'not-mapped': 0, 'ambiguous-type': 0, 'no-stable-id': 0 }, warnings: [] };
    expect(searchResultSchema.safeParse({ ...typeahead, startsWith: group }).success).toBe(true);
  });

  it.each([
    ['an entity-type entry with the scope of the match modes', { ...facets, entityType: [{ entityType: 'widget', count: { value: 1, quality: 'exact', scope: 'search:facet:matchMode' } }] }],
    ['a match-mode entry with the scope of the entity types', { ...facets, matchMode: [{ mode: 'exact', count: { value: 1, quality: 'exact', scope: 'search:facet:entityType' } }] }],
    ['a total with the scope of a group', { ...facets, total: { value: 2, quality: 'exact', scope: 'search:exact' } }],
    ['an entity type with two entries', { ...facets, entityType: [entry('widget'), entry('widget', 2)] }],
    ['a match mode with two entries', { ...facets, matchMode: [mode('exact'), mode('exact', 2)] }],
    ['a match mode the search does not know', { ...facets, matchMode: [mode('startsWith')] }],
    ['an exact count with no value', { ...facets, total: { quality: 'exact', scope: 'search:facet:total' } }],
    ['a lower bound with no value', { ...facets, entityType: [{ entityType: 'widget', count: { quality: 'lowerBound', scope: 'search:facet:entityType' } }] }],
    ['an estimated count', { ...facets, total: { value: 2, quality: 'estimated', scope: 'search:facet:total' } }],
    ['a negative count', { ...facets, total: { value: -1, quality: 'exact', scope: 'search:facet:total' } }],
    ['an entry with an empty entity type', { ...facets, entityType: [entry('')] }],
    ['an unknown field', { ...facets, group: 'facets' }],
    ['a total on a facet that has nothing to count', { searchable: false, total }],
    ['no total on a facet that has something to count', { searchable: true, entityType: [], matchMode: [] }],
  ])('refuses %s', (_name, value) => {
    expect(parse({ facets: value })).toBe(false);
  });

  it('refuses an answer that is not a type-ahead answer and has no facets or no filters', () => {
    const { facets: _dropped, ...withoutFacets } = result;
    const { filters: _kept, ...withoutFilters } = result;
    expect(searchResultSchema.safeParse(withoutFacets).success).toBe(false);
    expect(searchResultSchema.safeParse(withoutFilters).success).toBe(false);
  });

  it('refuses a type-ahead answer that holds the facets or the filters', () => {
    const group = { nodes: [], count: { value: 0, quality: 'exact', scope: 'search:startsWith' }, dropped: { 'not-mapped': 0, 'ambiguous-type': 0, 'no-stable-id': 0 }, warnings: [] };
    expect(searchResultSchema.safeParse({ ...typeahead, startsWith: group }).success).toBe(true);
    expect(searchResultSchema.safeParse({ ...typeahead, startsWith: group, facets }).success).toBe(false);
    expect(searchResultSchema.safeParse({ ...typeahead, startsWith: group, filters: result.filters }).success).toBe(false);
  });

  it('refuses filters with an unknown mode, an empty entity type or an unknown field', () => {
    expect(parse({ filters: { entityTypes: ['widget'], matchModes: ['related'] } })).toBe(true);
    expect(parse({ filters: { entityTypes: [], matchModes: ['startsWith'] } })).toBe(false);
    expect(parse({ filters: { entityTypes: [''], matchModes: [] } })).toBe(false);
    expect(parse({ filters: { entityTypes: [], matchModes: [], text: 'x' } })).toBe(false);
  });
});

describe('the failure of the facet read in the search result', () => {
  const failed = { searchable: true, total: { quality: 'unknown', scope: 'search:facet:total' }, entityType: [], matchMode: [] };
  const facetsFailure = { group: 'facets', code: 'QUERY_TIMEOUT', timeoutMs: 5000 };
  const unread = { hits: [], count: { quality: 'unknown', scope: 'search:related' }, searchable: true, disabledTypes: [] };
  const parse = (override: Record<string, unknown>) => searchResultSchema.safeParse({ ...result, ...override }).success;

  it('accepts an answer in which only the facet read failed, the failed shape, and the failure named once', () => {
    expect(parse({ facets: failed, failures: [facetsFailure] })).toBe(true);
    expect(parse({ facets: failed, failures: [{ group: 'facets', code: 'INTERNAL_ERROR' }] })).toBe(true);
  });

  it('accepts the sole result group that was read answering while the facet read fails, and exact answering while related and the facet read fail', () => {
    const onlyExact = { related: { ...result.related, searchable: false }, evidence: { ...result.evidence, searchable: false } };
    expect(parse({ ...onlyExact, facets: failed, failures: [facetsFailure] })).toBe(true);
    expect(parse({ related: unread, facets: failed, failures: [{ group: 'related', code: 'QUERY_TIMEOUT', timeoutMs: 5000 }, facetsFailure] })).toBe(true);
  });

  it('refuses an answer in which every result group that was read failed, whether the facet read answered or failed', () => {
    const exactFailed = { exact: [], exactMatches: [], counts: { exact: { quality: 'unknown', scope: 'search:exact' } } };
    const onlyExact = { related: { ...result.related, searchable: false }, evidence: { ...result.evidence, searchable: false } };
    expect(parse({ ...onlyExact, ...exactFailed, failures: [{ group: 'exact', code: 'SOURCE_BUSY' }] })).toBe(false);
    expect(parse({ ...onlyExact, ...exactFailed, facets: failed, failures: [{ group: 'exact', code: 'SOURCE_BUSY' }, facetsFailure] })).toBe(false);
  });

  it('accepts an answer in which no result group could be read and there is nothing to count', () => {
    const nothing = { searchable: false, related: { ...result.related, searchable: false }, evidence: { ...result.evidence, searchable: false }, facets: { searchable: false }, counts: { exact: { value: 0, quality: 'exact', scope: 'search:exact' } }, exact: [], exactMatches: [] };
    expect(parse(nothing)).toBe(true);
  });

  it.each([
    ['a failed facet read with entries', { facets: { ...failed, entityType: [{ entityType: 'widget', count: { value: 1, quality: 'exact', scope: 'search:facet:entityType' } }] }, failures: [facetsFailure] }],
    ['a failed facet read with match-mode entries', { facets: { ...failed, matchMode: [{ mode: 'exact', count: { value: 1, quality: 'exact', scope: 'search:facet:matchMode' } }] }, failures: [facetsFailure] }],
    ['a failed facet read with nothing to count', { facets: { searchable: false }, failures: [facetsFailure] }],
    ['a failed facet read whose total has a value', { facets: { ...failed, total: { value: 0, quality: 'exact', scope: 'search:facet:total' } }, failures: [facetsFailure] }],
    ['an unknown total with no failure of the facet read', { facets: failed, failures: [] }],
    ['an unknown entry with no failure of the facet read', { facets: { searchable: true, total: { value: 1, quality: 'exact', scope: 'search:facet:total' }, entityType: [{ entityType: 'widget', count: { quality: 'unknown', scope: 'search:facet:entityType' } }], matchMode: [] } }],
    ['the facet failure named twice', { facets: failed, failures: [facetsFailure, facetsFailure] }],
    ['a facet failure with a code that belongs to the whole search', { facets: failed, failures: [{ group: 'facets', code: 'SOURCE_UNAVAILABLE' }] }],
  ])('refuses %s', (_name, override) => {
    expect(parse(override)).toBe(false);
  });

  it('refuses a facet failure in a type-ahead answer, which reads no facets', () => {
    const group = { nodes: [], count: { value: 0, quality: 'exact', scope: 'search:startsWith' }, dropped: { 'not-mapped': 0, 'ambiguous-type': 0, 'no-stable-id': 0 }, warnings: [] };
    expect(searchResultSchema.safeParse({ ...typeahead, startsWith: group, failures: [facetsFailure] }).success).toBe(false);
  });
});

describe('the relationship context of the related hits in the search result', () => {
  const ref = node.ref;
  const hit = { node: { ...node, ref: { ...ref, stableId: 'RL-1' } }, matchedProperties: ['batchRef'] };
  const related = (hits: unknown[], extra: Record<string, unknown> = {}) => ({ hits, count: { value: hits.length, quality: 'exact', scope: 'search:related' }, searchable: true, disabledTypes: [], ...extra });
  const context = { relationshipType: 'OWNS', direction: 'out', with: ref };
  const contextFailure = { group: 'context', code: 'QUERY_TIMEOUT', timeoutMs: 5000 };
  const parse = (override: Record<string, unknown>) => searchResultSchema.safeParse({ ...result, ...override }).success;

  it('accepts a related hit with a context that names an exact match, in either direction, and one with none', () => {
    expect(parse({ related: related([{ ...hit, context }]) })).toBe(true);
    expect(parse({ related: related([{ ...hit, context: { ...context, direction: 'in' } }]) })).toBe(true);
    expect(parse({ related: related([hit]) })).toBe(true);
  });

  it.each([
    ['a context that names a record the answer does not hold as an exact match', { related: related([{ ...hit, context: { ...context, with: { ...ref, stableId: 'OTHER' } } }]) }],
    ['a direction that is neither out nor in', { related: related([{ ...hit, context: { ...context, direction: 'both' } }]) }],
    ['a context with a field the contract does not name', { related: related([{ ...hit, context: { ...context, title: 'AC-1' } }]) }],
    ['a context with no relationship type', { related: related([{ ...hit, context: { direction: 'out', with: ref } }]) }],
  ])('refuses %s', (_name, override) => {
    expect(parse(override)).toBe(false);
  });

  it('accepts the types left out of the context read, and refuses an empty list of them', () => {
    const left = { entityType: 'widget', property: 'widgetId', reason: 'index-unavailable', typeSearched: false };
    expect(parse({ related: related([hit], { context: { disabledTypes: [left] } }) })).toBe(true);
    expect(parse({ related: related([hit], { context: { disabledTypes: [] } }) })).toBe(false);
  });

  it('accepts a failed context read named once, beside hits that hold no context, and counts it as no result group', () => {
    expect(parse({ related: related([hit]), failures: [contextFailure] })).toBe(true);
    expect(parse({ related: related([hit]), failures: [{ group: 'context', code: 'INTERNAL_ERROR' }] })).toBe(true);
  });

  it.each([
    ['a failed context read beside a hit that holds a context', { related: related([{ ...hit, context }]), failures: [contextFailure] }],
    ['a failed context read when the related group holds no hit', { related: related([]), failures: [contextFailure] }],
    ['a failed context read when the exact group holds no hit', { exact: [], exactMatches: [], counts: { exact: { value: 0, quality: 'exact', scope: 'search:exact' } }, related: related([hit]), failures: [contextFailure] }],
    ['the context failure named twice', { related: related([hit]), failures: [contextFailure, contextFailure] }],
    ['a context failure with a code that belongs to the whole search', { related: related([hit]), failures: [{ group: 'context', code: 'SOURCE_UNAVAILABLE' }] }],
  ])('refuses %s', (_name, override) => {
    expect(parse(override)).toBe(false);
  });

  it('does not count a failed context read among the result groups that failed', () => {
    const onlyExact = { related: related([], { searchable: false }), evidence: { ...result.evidence, searchable: false } };
    expect(parse({ ...onlyExact, failures: [contextFailure] })).toBe(false);
    expect(parse({ related: related([hit]), failures: [{ group: 'related', code: 'SOURCE_BUSY' }, contextFailure] })).toBe(false);
  });
});

describe('the selection of a search request', () => {
  const accepts = (body: Record<string, unknown>) => searchRequestSchema.safeParse({ sourceId: 'demo', text: 'ab', ...body }).success;

  it('accepts a list of entity types, a list of match modes and both, each of different names', () => {
    expect(accepts({ entityTypes: ['widget'] })).toBe(true);
    expect(accepts({ entityTypes: ['widget', 'gadget'], matchModes: ['exact', 'related', 'evidence'] })).toBe(true);
    expect(accepts({ matchModes: ['evidence'], mask: true, typeahead: false })).toBe(true);
    expect(accepts({})).toBe(true);
  });

  it.each([
    ['an empty list of entity types', { entityTypes: [] }],
    ['an empty list of match modes', { matchModes: [] }],
    ['an entity type twice', { entityTypes: ['widget', 'widget'] }],
    ['a match mode twice', { matchModes: ['exact', 'exact'] }],
    ['an unknown match mode', { matchModes: ['startsWith'] }],
    ['a match mode that is not text', { matchModes: [1] }],
    ['an entity type that is not text', { entityTypes: [7] }],
    ['an empty entity type', { entityTypes: [''] }],
    ['a selection that is not a list', { entityTypes: 'widget' }],
    ['an unknown field beside the selection', { entityTypes: ['widget'], types: ['widget'] }],
    ['entity types with type-ahead', { typeahead: true, entityTypes: ['widget'] }],
    ['match modes with type-ahead', { typeahead: true, matchModes: ['exact'] }],
  ])('refuses %s', (_name, body) => {
    expect(accepts(body)).toBe(false);
  });
});

describe('the cursors of the groups of a search result', () => {
  const lowerBound = (scope: string) => ({ value: 25, quality: 'lowerBound', scope });

  it('accepts a cursor on each group whose count is a lower bound', () => {
    const paged = {
      ...result,
      counts: { exact: lowerBound('search:exact') },
      exactNextCursor: 'v1.a.b',
      related: { ...result.related, count: lowerBound('search:related'), nextCursor: 'v1.c.d' },
      evidence: { ...result.evidence, searchable: true, count: lowerBound('search:evidence'), nextCursor: 'v1.e.f' },
    };
    expect(searchResultSchema.safeParse(paged).success).toBe(true);
  });

  it.each([
    ['the exact group', { exactNextCursor: 'v1.a.b' }],
    ['the related group', { related: { ...result.related, nextCursor: 'v1.a.b' } }],
    ['the evidence group', { evidence: { ...result.evidence, nextCursor: 'v1.a.b' } }],
    ['an empty cursor', { counts: { exact: lowerBound('search:exact') }, exactNextCursor: '' }],
  ])('refuses a cursor on %s whose count is exact', (_name, change) => {
    expect(searchResultSchema.safeParse({ ...result, ...change }).success).toBe(false);
  });
});

describe('the request for the next page of a group', () => {
  const body = { sourceId: 'demo', text: 'AC-1', group: 'exact', cursor: 'v1.a.b' };

  it('accepts a group, a cursor, a mask and entity types', () => {
    for (const group of ['exact', 'related', 'evidence']) expect(searchMoreRequestSchema.safeParse({ ...body, group }).success).toBe(true);
    expect(searchMoreRequestSchema.safeParse({ ...body, mask: true, entityTypes: ['widget'] }).success).toBe(true);
  });

  it.each([
    ['no cursor', { cursor: undefined }],
    ['an empty cursor', { cursor: '' }],
    ['the facets, which are not a group', { group: 'facets' }],
    ['the startsWith group, which has no next page', { group: 'startsWith' }],
    ['match modes, as the group is the mode', { matchModes: ['exact'] }],
    ['an empty list of entity types', { entityTypes: [] }],
    ['an empty text', { text: '' }],
    ['a field the contract does not name', { limit: 50 }],
  ])('refuses %s', (_name, change) => {
    expect(searchMoreRequestSchema.safeParse({ ...body, ...change }).success).toBe(false);
  });
});

describe('the exact matches a request for the next page of the related group carries', () => {
  const body = { sourceId: 'demo', text: 'AC-1', group: 'related', cursor: 'v1.a.b' };
  const refs = (count: number) => Array.from({ length: count }, (_, index) => ({ ...node.ref, stableId: `AC-${index}` }));

  it('accepts none, one and as many as the cap for the related group', () => {
    expect(searchMoreRequestSchema.safeParse(body).success).toBe(true);
    expect(searchMoreRequestSchema.safeParse({ ...body, exactRefs: [] }).success).toBe(true);
    expect(searchMoreRequestSchema.safeParse({ ...body, exactRefs: refs(SEARCH_GROUP_CAP) }).success).toBe(true);
  });

  it.each([
    ['more than the cap', { exactRefs: refs(SEARCH_GROUP_CAP + 1) }],
    ['the exact group', { group: 'exact', exactRefs: refs(1) }],
    ['the evidence group', { group: 'evidence', exactRefs: refs(1) }],
    ['a reference with a field the contract does not name', { exactRefs: [{ ...node.ref, title: 'AC-1' }] }],
    ['a reference with no stable ID', { exactRefs: [{ sourceId: 'demo', entityType: 'widget' }] }],
  ])('refuses %s', (_name, change) => {
    expect(searchMoreRequestSchema.safeParse({ ...body, ...change }).success).toBe(false);
  });
});

describe('the relationship context of a page of the related group', () => {
  const hit = { node, matchedProperties: [] };
  const page = { sourceId: 'demo', group: 'related', hits: [hit], count: { value: 1, quality: 'exact', scope: 'search:related' }, dropped: result.dropped, warnings: [] };
  const failure = { group: 'context', code: 'QUERY_TIMEOUT', timeoutMs: 5000 };

  it('accepts a page that keeps its hits, count and cursor beside the failure of its context read, and the types left out of the read', () => {
    expect(searchMoreResultSchema.safeParse({ ...page, contextFailure: failure }).success).toBe(true);
    expect(searchMoreResultSchema.safeParse({ ...page, count: { value: 1, quality: 'lowerBound', scope: 'search:related' }, nextCursor: 'v1.a.b', contextFailure: failure }).success).toBe(true);
    expect(searchMoreResultSchema.safeParse({ ...page, context: { disabledTypes: [{ entityType: 'widget', property: 'widgetId', reason: 'index-unavailable', typeSearched: false }] } }).success).toBe(true);
  });

  it.each([
    ['a context failure named for another group', { contextFailure: { ...failure, group: 'related' } }],
    ['a context failure beside a hit that holds a context', { hits: [{ ...hit, context: { relationshipType: 'OWNS', direction: 'out', with: node.ref } }], contextFailure: failure }],
    ['a context failure with no hit', { hits: [], count: { value: 0, quality: 'exact', scope: 'search:related' }, contextFailure: failure }],
    ['a context failure beside the failure of the page', { hits: [], count: { quality: 'unknown', scope: 'search:related' }, failure: { group: 'related', code: 'SOURCE_BUSY' }, contextFailure: failure }],
    ['a context failure with a code of the whole request', { contextFailure: { ...failure, code: 'SOURCE_UNAVAILABLE' } }],
    ['an empty list of left-out types', { context: { disabledTypes: [] } }],
  ])('refuses %s', (_name, change) => {
    expect(searchMoreResultSchema.safeParse({ ...page, ...change }).success).toBe(false);
  });

  it('refuses a context failure on the page of another group', () => {
    expect(searchMoreResultSchema.safeParse({ sourceId: 'demo', group: 'exact', nodes: [node], count: { value: 1, quality: 'exact', scope: 'search:exact' }, dropped: result.dropped, warnings: [], contextFailure: failure }).success).toBe(false);
  });
});

describe('the next page of a group', () => {
  const page = { sourceId: 'demo', group: 'exact', nodes: [node], matches: [{ ref: node.ref, matchedProperties: ['widgetId'] }], count: { value: 1, quality: 'exact', scope: 'search:exact' }, dropped: result.dropped, warnings: [] };

  it('accepts a last page, a page with a next cursor, and a failed page in the shape of its group', () => {
    expect(searchMoreResultSchema.safeParse(page).success).toBe(true);
    expect(searchMoreResultSchema.safeParse({ ...page, count: { value: 1, quality: 'lowerBound', scope: 'search:exact' }, nextCursor: 'v1.a.b' }).success).toBe(true);
    expect(searchMoreResultSchema.safeParse({ ...page, nodes: [], matches: [], count: { quality: 'unknown', scope: 'search:exact' }, failure: { group: 'exact', code: 'QUERY_TIMEOUT', timeoutMs: 5000 } }).success).toBe(true);
    expect(searchMoreResultSchema.safeParse({ sourceId: 'demo', group: 'related', hits: [{ node, matchedProperties: ['batchRef'] }], count: { value: 1, quality: 'exact', scope: 'search:related' }, dropped: result.dropped, warnings: [] }).success).toBe(true);
  });

  it('holds one entry of matched properties for each node of an exact page, in the same place, and for no other group', () => {
    const other = { ...node, ref: { ...node.ref, stableId: 'W-2' } };
    const entry = (target: typeof node) => ({ ref: target.ref, matchedProperties: ['widgetId'] });
    const two = { ...page, nodes: [node, other], count: { value: 2, quality: 'exact', scope: 'search:exact' } };
    expect(searchMoreResultSchema.safeParse({ ...two, matches: [entry(node), entry(other)] }).success).toBe(true);
    expect(searchMoreResultSchema.safeParse({ ...two, matches: [entry(other), entry(node)] }).success).toBe(false);
    expect(searchMoreResultSchema.safeParse({ ...two, matches: [entry(node)] }).success).toBe(false);
    expect(searchMoreResultSchema.safeParse({ ...page, matches: [{ ...entry(node), value: 'W-1' }] }).success).toBe(false);
    const { matches: _removed, ...without } = page;
    expect(searchMoreResultSchema.safeParse(without).success).toBe(false);
    const related = { sourceId: 'demo', group: 'related', hits: [{ node, matchedProperties: ['batchRef'] }], count: { value: 1, quality: 'exact', scope: 'search:related' }, dropped: result.dropped, warnings: [] };
    expect(searchMoreResultSchema.safeParse({ ...related, matches: [] }).success).toBe(false);
  });

  it.each([
    ['a cursor with an exact count', { nextCursor: 'v1.a.b' }],
    ['an unknown count with no failure', { count: { quality: 'unknown', scope: 'search:exact' } }],
    ['a failure with hits', { failure: { group: 'exact', code: 'QUERY_TIMEOUT' }, count: { quality: 'unknown', scope: 'search:exact' } }],
    ['a failure with a known count', { nodes: [], matches: [], failure: { group: 'exact', code: 'SOURCE_BUSY' } }],
    ['a failure of another group', { nodes: [], matches: [], count: { quality: 'unknown', scope: 'search:exact' }, failure: { group: 'related', code: 'SOURCE_BUSY' } }],
    ['a failure with a cursor', { nodes: [], matches: [], count: { quality: 'unknown', scope: 'search:exact' }, nextCursor: 'v1.a.b', failure: { group: 'exact', code: 'SOURCE_BUSY' } }],
    ['a failure code that fails the whole request', { nodes: [], matches: [], count: { quality: 'unknown', scope: 'search:exact' }, failure: { group: 'exact', code: 'CURSOR_INVALIDATED' } }],
    ['hits in the shape of another group', { nodes: undefined, hits: [] }],
    ['a page of the startsWith group, which has no next page', { group: 'startsWith', count: { value: 1, quality: 'exact', scope: 'search:startsWith' } }],
  ])('refuses %s', (_name, change) => {
    expect(searchMoreResultSchema.safeParse({ ...page, ...change }).success).toBe(false);
  });
});

describe('the unreferenced hits of a group', () => {
  const hit = { entityType: 'widget', title: 'widget', properties: [{ key: 'nickname', value: 'needle', dataClass: 'text', masked: false }], reason: 'no-stable-id' };
  const counted = (value: number, scope: string) => ({ value, quality: 'exact', scope });

  it('holds one entry of matched properties for each exact match, with the reference of the match in the same place', () => {
    const other = { ...node, ref: { ...node.ref, stableId: 'W-2' } };
    const two = { ...result, exact: [node, other], counts: { exact: { value: 2, quality: 'exact', scope: 'search:exact' } } };
    const entry = (target: typeof node) => ({ ref: target.ref, matchedProperties: ['widgetId'] });
    expect(searchResultSchema.safeParse({ ...two, exactMatches: [entry(node), entry(other)] }).success).toBe(true);
    expect(searchResultSchema.safeParse({ ...two, exactMatches: [entry(other), entry(node)] }).success).toBe(false);
    expect(searchResultSchema.safeParse({ ...two, exactMatches: [entry(node)] }).success).toBe(false);
    expect(searchResultSchema.safeParse({ ...result, exactMatches: [] }).success).toBe(false);
    const { exactMatches: _removed, ...without } = result;
    expect(searchResultSchema.safeParse(without).success).toBe(false);
  });

  it('refuses an entry of matched properties with an unknown field, an empty name or a value', () => {
    const entry = result.exactMatches[0];
    expect(searchResultSchema.safeParse({ ...result, exactMatches: [{ ...entry, value: 'W-1' }] }).success).toBe(false);
    expect(searchResultSchema.safeParse({ ...result, exactMatches: [{ ...entry, matchedProperties: [''] }] }).success).toBe(false);
    expect(searchResultSchema.safeParse({ ...result, exactMatches: [{ ref: node.ref }] }).success).toBe(false);
    expect(searchResultSchema.safeParse({ ...result, exactMatches: [{ ...entry, matchedProperties: [] }] }).success).toBe(true);
  });

  it('are listed in the exact, related and startsWith groups and in a page of the exact and related groups', () => {
    expect(searchResultSchema.safeParse({ ...result, exactUnreferenced: [hit], counts: { exact: counted(2, 'search:exact') } }).success).toBe(true);
    expect(searchResultSchema.safeParse({ ...result, related: { ...result.related, unreferenced: [hit], count: counted(1, 'search:related') } }).success).toBe(true);
    const startsWith = { nodes: [], unreferenced: [hit], count: counted(1, 'search:startsWith'), dropped: { 'not-mapped': 0, 'ambiguous-type': 0, 'no-stable-id': 1 }, warnings: [] };
    expect(searchResultSchema.safeParse({ ...typeahead, startsWith }).success).toBe(true);
    const page = { sourceId: 'demo', count: counted(1, 'search:exact'), dropped: { 'not-mapped': 0, 'ambiguous-type': 0, 'no-stable-id': 1 }, warnings: [] };
    for (const shape of [{ group: 'exact', nodes: [], matches: [] }, { group: 'related', hits: [] }]) expect(searchMoreResultSchema.safeParse({ ...page, ...shape, unreferenced: [hit] }).success, shape.group).toBe(true);
    expect(searchMoreResultSchema.safeParse({ ...page, group: 'evidence', hits: [], unreferenced: [hit] }).success).toBe(false);
  });

  it('carry no reference, no cursor and no element ID: a hit with any other field is refused', () => {
    for (const extra of [{ ref: node.ref }, { elementId: '4:x:1' }, { nextCursor: 'v1.a.b' }, { stableId: '1.5' }]) {
      expect(searchResultSchema.safeParse({ ...result, exactUnreferenced: [{ ...hit, ...extra }] }).success, Object.keys(extra)[0]).toBe(false);
    }
    expect(searchResultSchema.safeParse({ ...result, exactUnreferenced: [{ ...hit, reason: 'ambiguous-type' }] }).success).toBe(false);
  });

  it('are absent rather than an empty list', () => {
    expect(searchResultSchema.safeParse({ ...result, exactUnreferenced: [] }).success).toBe(false);
  });

  it('are none in a group whose read failed, nor in a failed page', () => {
    const failedRelated = { ...result, related: { ...result.related, unreferenced: [hit], count: { quality: 'unknown', scope: 'search:related' } }, failures: [{ group: 'related', code: 'QUERY_TIMEOUT' }] };
    expect(searchResultSchema.safeParse(failedRelated).success).toBe(false);
    const failedPage = { sourceId: 'demo', group: 'exact', nodes: [], matches: [], unreferenced: [hit], count: { quality: 'unknown', scope: 'search:exact' }, dropped: { 'not-mapped': 0, 'ambiguous-type': 0, 'no-stable-id': 0 }, warnings: [], failure: { group: 'exact', code: 'QUERY_TIMEOUT' } };
    expect(searchMoreResultSchema.safeParse(failedPage).success).toBe(false);
  });
});

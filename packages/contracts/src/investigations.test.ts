import { describe, expect, it } from 'vitest';
import { edgeEntrySchema, investigationListQuerySchema, investigationListResponseSchema, openInvestigationRequestSchema, openInvestigationResponseSchema } from './investigations.js';

const investigation = {
  id: '0192f000-0000-7000-8000-0000000000a1',
  sourceId: 'demo',
  title: 'Widget W-1',
  caseRef: null,
  status: 'open',
  startingEntity: { entityType: 'widget', stableId: 'W-1' },
  sourceState: 'available',
  createdAt: '2026-11-05T10:00:00.000Z',
  lastEditedAt: '2026-11-05T10:00:00.000Z',
  version: 1,
};
const entity = { ref: { sourceId: 'demo', entityType: 'widget', stableId: 'W-1' }, display: { title: 'Widget W-1', type: 'widget' }, properties: [], qualityFlags: [], provenanceRefs: [], authorization: { canInspect: true, canExport: true } };

describe('the answer to opening an investigation', () => {
  it.each([
    ['an available source with its entity, new', { investigation, created: true, entity, draft: { version: 1 } }],
    ['an available source with its entity, resumed', { investigation, created: false, entity, draft: { version: 2 } }],
    ['a repointed source, resumed, with no entity', { investigation: { ...investigation, sourceState: 'repointed' }, created: false, draft: { version: 1 } }],
    ['a removed source, resumed, with no entity', { investigation: { ...investigation, sourceState: 'removed' }, created: false, draft: { version: 1 } }],
  ])('accepts %s', (_name, answer) => {
    expect(openInvestigationResponseSchema.safeParse(answer).success).toBe(true);
  });

  it.each([
    ['an available source without its entity', { investigation, created: true, draft: { version: 1 } }],
    ['an answer without the version of the draft', { investigation, created: true, entity }],
    ['a draft version of zero', { investigation, created: true, entity, draft: { version: 0 } }],
    ['a repointed source with an entity', { investigation: { ...investigation, sourceState: 'repointed' }, created: false, entity, draft: { version: 1 } }],
    ['a repointed source reported as new', { investigation: { ...investigation, sourceState: 'repointed' }, created: true, draft: { version: 1 } }],
    ['a removed source with an entity', { investigation: { ...investigation, sourceState: 'removed' }, created: false, entity, draft: { version: 1 } }],
    ['a state that does not exist', { investigation: { ...investigation, sourceState: 'gone' }, created: false, draft: { version: 1 } }],
  ])('refuses %s', (_name, answer) => {
    expect(openInvestigationResponseSchema.safeParse(answer).success).toBe(false);
  });
});

describe('the request to open an investigation', () => {
  const request = { sourceId: 'demo', entity: { sourceId: 'demo', entityType: 'widget', stableId: 'W-1' } };

  it('takes a stable ID and a case reference of their limits, counted as characters', () => {
    expect(openInvestigationRequestSchema.safeParse({ ...request, entity: { ...request.entity, stableId: '😀'.repeat(200) }, caseRef: '😀'.repeat(100) }).success).toBe(true);
  });

  it('takes an ID of any length up to the limit of a body, and a raw value to resolve, with any characters', () => {
    expect(openInvestigationRequestSchema.safeParse({ ...request, entity: { ...request.entity, stableId: 'a'.repeat(201) } }).success).toBe(true);
    expect(openInvestigationRequestSchema.safeParse({ ...request, entity: { ...request.entity, stableId: 'a'.repeat(266_691) } }).success).toBe(true);
    expect(openInvestigationRequestSchema.safeParse({ ...request, entity: { sourceId: 'demo', entityType: 'widget', value: '.\u0000\ud800' } }).success).toBe(true);
  });

  it.each([
    ['a reference longer than the largest token', { ...request, entity: { ...request.entity, stableId: 'a'.repeat(266_692) } }],
    ['a raw value longer than the limit of a value', { ...request, entity: { sourceId: 'demo', entityType: 'widget', value: 'a'.repeat(100_001) } }],
    ['an entity with both a reference and a value', { ...request, entity: { ...request.entity, value: 'x' } }],
    ['a case reference of 101 characters', { ...request, caseRef: 'a'.repeat(101) }],
    ['a field it does not know', { ...request, title: 'Mine' }],
  ])('refuses %s', (_name, body) => {
    expect(openInvestigationRequestSchema.safeParse(body).success).toBe(false);
  });
});

const listed = { ...investigation, sourceAlias: 'Demo source', save: { state: 'unsaved', savedAt: null } };
const countsOf = (investigations: number, sources: number) => ({ investigations: { value: investigations, quality: 'exact', scope: 'investigations' }, sources: { value: sources, quality: 'exact', scope: 'investigation-sources' }, savedViews: { count: { value: 0, quality: 'exact', scope: 'named-views' }, lastEditedAt: null } });

describe('the list of investigations', () => {
  it.each([
    ['an unsaved row', { items: [listed], hasMore: false, counts: countsOf(1, 1) }],
    ['a saved row with the time of its view', { items: [{ ...listed, save: { state: 'saved', savedAt: '2026-11-05T10:05:00.000Z' } }], hasMore: true, counts: countsOf(7, 3) }],
    ['no rows', { items: [], hasMore: false, counts: countsOf(0, 0) }],
    ['named views with the time of the newest', { items: [], hasMore: false, counts: { ...countsOf(0, 0), savedViews: { count: { value: 3, quality: 'exact', scope: 'named-views' }, lastEditedAt: '2026-11-05T12:30:00.000Z' } } }],
    ['a row of a source taken out of the configuration', { items: [{ ...listed, sourceState: 'removed' }], hasMore: false, counts: countsOf(1, 1) }],
  ])('accepts %s', (_name, answer) => {
    expect(investigationListResponseSchema.safeParse(answer).success).toBe(true);
  });

  it.each([
    ['a row without its source alias', { items: [{ ...investigation, save: listed.save }], hasMore: false, counts: countsOf(1, 1) }],
    ['a saved row with no time', { items: [{ ...listed, save: { state: 'saved', savedAt: null } }], hasMore: false, counts: countsOf(1, 1) }],
    ['an unsaved row with a time', { items: [{ ...listed, save: { state: 'unsaved', savedAt: '2026-11-05T10:05:00.000Z' } }], hasMore: false, counts: countsOf(1, 1) }],
    ['an answer without hasMore', { items: [], counts: countsOf(0, 0) }],
    ['a cursor', { items: [], hasMore: false, counts: countsOf(0, 0), nextCursor: null }],
    ['an answer without counts', { items: [], hasMore: false }],
    ['counts without the sources', { items: [], hasMore: false, counts: { investigations: countsOf(0, 0).investigations, savedViews: countsOf(0, 0).savedViews } }],
    ['counts without the saved views', { items: [], hasMore: false, counts: { investigations: countsOf(0, 0).investigations, sources: countsOf(0, 0).sources } }],
    ['saved views with a time that is not a time', { items: [], hasMore: false, counts: { ...countsOf(0, 0), savedViews: { ...countsOf(0, 0).savedViews, lastEditedAt: 'yesterday' } } }],
    ['saved views whose count is not exact', { items: [], hasMore: false, counts: { ...countsOf(0, 0), savedViews: { count: { value: 2, quality: 'estimated', scope: 'named-views' }, lastEditedAt: null } } }],
    ['a count that is not exact', { items: [], hasMore: false, counts: { ...countsOf(0, 0), investigations: { value: 3, quality: 'lowerBound', scope: 'investigations' } } }],
    ['a count with another scope', { items: [], hasMore: false, counts: { ...countsOf(0, 0), sources: { value: 0, quality: 'exact', scope: 'investigations' } } }],
    ['a count with no value', { items: [], hasMore: false, counts: { ...countsOf(0, 0), sources: { quality: 'unknown', scope: 'investigation-sources' } } }],
    ['a negative count', { items: [], hasMore: false, counts: { ...countsOf(0, 0), investigations: { value: -1, quality: 'exact', scope: 'investigations' } } }],
    ['an extra count', { items: [], hasMore: false, counts: { ...countsOf(0, 0), patterns: { value: 0, quality: 'exact', scope: 'patterns' } } }],
  ])('refuses %s', (_name, answer) => {
    expect(investigationListResponseSchema.safeParse(answer).success).toBe(false);
  });
});

describe('the query of the list of investigations', () => {
  it.each([[{}], [{ limit: '5' }], [{ limit: '25', sort: 'lastEdited' }], [{ sort: 'lastEdited' }], [{ limit: '1' }]])('accepts %j', (query) => {
    expect(investigationListQuerySchema.safeParse(query).success).toBe(true);
  });

  it('reads the limit as a number', () => {
    expect(investigationListQuerySchema.parse({ limit: '7' })).toEqual({ limit: 7 });
  });

  it.each([[{ limit: '0' }], [{ limit: '26' }], [{ limit: '1.5' }], [{ limit: 'x' }], [{ limit: '' }], [{ limit: '-1' }], [{ sort: 'name' }], [{ sort: '' }], [{ other: '1' }], [{ limit: ['5', '6'] }]])('refuses %j', (query) => {
    expect(investigationListQuerySchema.safeParse(query).success).toBe(false);
  });
});

describe('an edge of a stored document', () => {
  const ends = { t: 'LINKS', from: { t: 'widget', id: 'W-1' }, to: { t: 'gizmo', id: 'W-1' } };

  it.each([[ends], [{ ...ends, id: 'REL-1' }], [{ ...ends, ruleId: 'shared-gizmo' }]])('accepts %j', (edge) => {
    expect(edgeEntrySchema.safeParse(edge).success).toBe(true);
  });

  it.each([
    ['an end with no type', { ...ends, to: { id: 'W-1' } }],
    ['an end that is only an ID', { ...ends, from: 'W-1' }],
    ['both an id and a rule', { ...ends, id: 'REL-1', ruleId: 'shared-gizmo' }],
    ['an unknown field', { ...ends, extra: 1 }],
    ['an empty type', { ...ends, from: { t: '', id: 'W-1' } }],
  ])('refuses %s', (_name, edge) => {
    expect(edgeEntrySchema.safeParse(edge).success).toBe(false);
  });
});

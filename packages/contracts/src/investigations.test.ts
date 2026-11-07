import { describe, expect, it } from 'vitest';
import { investigationListQuerySchema, investigationListResponseSchema, openInvestigationRequestSchema, openInvestigationResponseSchema } from './investigations.js';

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
    ['an available source with its entity, new', { investigation, created: true, entity }],
    ['an available source with its entity, resumed', { investigation, created: false, entity }],
    ['a repointed source, resumed, with no entity', { investigation: { ...investigation, sourceState: 'repointed' }, created: false }],
    ['a removed source, resumed, with no entity', { investigation: { ...investigation, sourceState: 'removed' }, created: false }],
  ])('accepts %s', (_name, answer) => {
    expect(openInvestigationResponseSchema.safeParse(answer).success).toBe(true);
  });

  it.each([
    ['an available source without its entity', { investigation, created: true }],
    ['a repointed source with an entity', { investigation: { ...investigation, sourceState: 'repointed' }, created: false, entity }],
    ['a repointed source reported as new', { investigation: { ...investigation, sourceState: 'repointed' }, created: true }],
    ['a removed source with an entity', { investigation: { ...investigation, sourceState: 'removed' }, created: false, entity }],
    ['a state that does not exist', { investigation: { ...investigation, sourceState: 'gone' }, created: false }],
  ])('refuses %s', (_name, answer) => {
    expect(openInvestigationResponseSchema.safeParse(answer).success).toBe(false);
  });
});

describe('the request to open an investigation', () => {
  const request = { sourceId: 'demo', entity: { sourceId: 'demo', entityType: 'widget', stableId: 'W-1' } };

  it('takes a stable ID and a case reference of their limits, counted as characters', () => {
    expect(openInvestigationRequestSchema.safeParse({ ...request, entity: { ...request.entity, stableId: '😀'.repeat(200) }, caseRef: '😀'.repeat(100) }).success).toBe(true);
  });

  it.each([
    ['a stable ID of 201 characters', { ...request, entity: { ...request.entity, stableId: 'a'.repeat(201) } }],
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

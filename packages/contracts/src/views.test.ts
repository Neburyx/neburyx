import { describe, expect, it } from 'vitest';
import { renameViewRequestSchema, restoreViewResponseSchema, saveViewRequestSchema, saveViewResponseSchema, viewListQuerySchema, viewListResponseSchema } from './views.js';

const VIEW = { id: '0192f000-0000-7000-8000-0000000000a1', name: 'First look', notes: null, savedBy: { name: 'Local workspace' }, createdAt: '2026-11-10T08:00:00.000Z', version: 1 };

describe('the request to save a named view', () => {
  it.each([
    ['a name and a note', { name: 'First look', notes: 'a note' }],
    ['a name and no note', { name: 'First look', notes: null }],
    ['a name of 120 characters counted as characters', { name: '😀'.repeat(120), notes: null }],
    ['a note of 10,000 characters', { name: 'a', notes: 'n'.repeat(10_000) }],
    ['a title of 200 characters with the version it replaces', { name: 'a', notes: null, title: 't'.repeat(200), expectedInvestigationVersion: 3 }],
  ])('accepts %s', (_name, request) => {
    expect(saveViewRequestSchema.safeParse(request).success).toBe(true);
  });

  it.each([
    ['no name', { notes: null }],
    ['an empty name', { name: '', notes: null }],
    ['a name of 121 characters', { name: 'a'.repeat(121), notes: null }],
    ['a name with a NUL', { name: 'a\u0000b', notes: null }],
    ['a name with an unpaired surrogate', { name: 'a\ud800b', notes: null }],
    ['no note field', { name: 'a' }],
    ['a note of 10,001 characters', { name: 'a', notes: 'n'.repeat(10_001) }],
    ['a note with a NUL', { name: 'a', notes: 'a\u0000b' }],
    ['a note with an unpaired surrogate', { name: 'a', notes: 'a\udc00b' }],
    ['an empty title', { name: 'a', notes: null, title: '', expectedInvestigationVersion: 1 }],
    ['a title of 201 characters', { name: 'a', notes: null, title: 't'.repeat(201), expectedInvestigationVersion: 1 }],
    ['a title with a NUL', { name: 'a', notes: null, title: 't\u0000', expectedInvestigationVersion: 1 }],
    ['a title without the version it replaces', { name: 'a', notes: null, title: 'A title' }],
    ['a version without a title', { name: 'a', notes: null, expectedInvestigationVersion: 1 }],
    ['a version of zero', { name: 'a', notes: null, title: 'A title', expectedInvestigationVersion: 0 }],
    ['an unknown field', { name: 'a', notes: null, extra: true }],
  ])('refuses %s', (_name, request) => {
    expect(saveViewRequestSchema.safeParse(request).success).toBe(false);
  });
});

describe('the answer to saving a named view', () => {
  const answer = { view: VIEW, draft: { version: 2, notes: null, basedOnViewId: VIEW.id }, save: { state: 'saved', savedAt: VIEW.createdAt } };

  it.each([
    ['the view and the draft', answer],
    ['the title and version of the investigation', { ...answer, investigation: { title: 'A title', version: 2 } }],
  ])('accepts %s', (_name, body) => {
    expect(saveViewResponseSchema.safeParse(body).success).toBe(true);
  });

  it.each([
    ['a draft that is not based on a view', { ...answer, draft: { version: 2, notes: null, basedOnViewId: null } }],
    ['a state that is not saved', { ...answer, save: { state: 'unsaved', savedAt: null } }],
    ['a view without who saved it', { ...answer, view: { ...VIEW, savedBy: undefined } }],
    ['an unknown field', { ...answer, extra: 1 }],
  ])('refuses %s', (_name, body) => {
    expect(saveViewResponseSchema.safeParse(body).success).toBe(false);
  });
});

describe('the query of the list of views', () => {
  it.each([
    ['nothing', {}],
    ['a limit', { limit: '100' }],
    ['a limit of 0, which the route refuses as a request', { limit: '0' }],
    ['a limit above the maximum, which the route refuses as a budget', { limit: '101' }],
    ['a limit of ten digits, which the route also refuses as a budget', { limit: '10000000000' }],
    ['a cursor', { cursor: 'v1.a.b' }],
  ])('accepts %s', (_name, query) => {
    expect(viewListQuerySchema.safeParse(query).success).toBe(true);
  });

  it.each([
    ['a limit that is not a whole number', { limit: '1.5' }],
    ['a negative limit', { limit: '-1' }],
    ['a limit with text', { limit: '5x' }],
    ['an empty cursor', { cursor: '' }],
    ['a cursor of 2,049 characters', { cursor: 'c'.repeat(2049) }],
    ['an unknown parameter', { sort: 'name' }],
  ])('refuses %s', (_name, query) => {
    expect(viewListQuerySchema.safeParse(query).success).toBe(false);
  });
});

describe('the answer to listing views', () => {
  const answer = { items: [VIEW], nextCursor: null, count: { value: 1, quality: 'exact', scope: 'named-views' }, draft: { basedOnViewId: VIEW.id, updatedAt: '2026-11-10T09:42:00.000Z' } };

  it('accepts a page with a next cursor and a draft based on no view', () => {
    expect(viewListResponseSchema.safeParse({ ...answer, nextCursor: 'v1.a.b', draft: { ...answer.draft, basedOnViewId: null } }).success).toBe(true);
  });

  it.each([
    ['a count that is not exact', { ...answer, count: { value: 1, quality: 'estimated', scope: 'named-views' } }],
    ['a count of another scope', { ...answer, count: { value: 1, quality: 'exact', scope: 'investigations' } }],
    ['an item with its layout', { ...answer, items: [{ ...VIEW, layout: {} }] }],
    ['no draft', { items: [], nextCursor: null, count: answer.count }],
  ])('refuses %s', (_name, body) => {
    expect(viewListResponseSchema.safeParse(body).success).toBe(false);
  });
});

describe('the request to rename a view', () => {
  it('takes a name of 1 to 120 characters and nothing else', () => {
    expect(renameViewRequestSchema.safeParse({ name: 'a' }).success).toBe(true);
    expect(renameViewRequestSchema.safeParse({ name: '😀'.repeat(120) }).success).toBe(true);
  });

  it.each([
    ['no name', {}],
    ['an empty name', { name: '' }],
    ['a name of 121 characters', { name: 'a'.repeat(121) }],
    ['a name with a NUL', { name: 'a\u0000' }],
    ['a name with an unpaired surrogate', { name: '\udc00' }],
    ['another field', { name: 'a', notes: 'x' }],
  ])('refuses %s', (_name, body) => {
    expect(renameViewRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe('the answer to restoring a view', () => {
  const layout = { schemaVersion: 1, layout: 'force', nodes: [], edges: [], groups: [] };
  const queryContext = { schemaVersion: 1, loaded: { nodes: [], edges: [] }, expansions: [], filters: { entityTypes: [], relTypes: [], time: null, properties: [] } };
  const answer = { draft: { version: 4, layout, queryContext, notes: 'a note', basedOnViewId: VIEW.id }, save: { state: 'saved', savedAt: VIEW.createdAt } };

  it('accepts the draft and that it is saved', () => {
    expect(restoreViewResponseSchema.safeParse(answer).success).toBe(true);
  });

  it.each([
    ['a draft based on no view', { ...answer, draft: { ...answer.draft, basedOnViewId: null } }],
    ['a state that is not saved', { ...answer, save: { state: 'unsaved', savedAt: null } }],
    ['a draft without its note', { ...answer, draft: { version: 4, layout, queryContext, basedOnViewId: VIEW.id } }],
    ['an unknown field', { ...answer, view: VIEW }],
  ])('refuses %s', (_name, body) => {
    expect(restoreViewResponseSchema.safeParse(body).success).toBe(false);
  });
});

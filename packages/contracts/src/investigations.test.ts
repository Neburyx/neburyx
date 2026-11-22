import { describe, expect, it } from 'vitest';
import { investigationResponseSchema, edgeEntrySchema, queryContextDocumentSchema, investigationListQuerySchema, investigationListResponseSchema, openInvestigationRequestSchema, openInvestigationResponseSchema, renameRequestSchema, statusChangeRequestSchema, statusChangeResponseSchema, layoutDocumentSchema } from './investigations.js';

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
    ['an available source with its entity, new', { investigation, created: true, entity, draft: { version: 1, notes: null, basedOnViewId: null } }],
    ['an available source with its entity, resumed', { investigation, created: false, entity, draft: { version: 2, notes: null, basedOnViewId: null } }],
    ['an available source, resumed with a note and the view it is based on', { investigation, created: false, entity, draft: { version: 3, notes: 'a note', basedOnViewId: '0192f000-0000-7000-8000-0000000000a1' } }],
    ['a repointed source, resumed, with no entity', { investigation: { ...investigation, sourceState: 'repointed' }, created: false, draft: { version: 1, notes: null, basedOnViewId: null } }],
    ['a removed source, resumed, with no entity', { investigation: { ...investigation, sourceState: 'removed' }, created: false, draft: { version: 1, notes: null, basedOnViewId: null } }],
  ])('accepts %s', (_name, answer) => {
    expect(openInvestigationResponseSchema.safeParse(answer).success).toBe(true);
  });

  it.each([
    ['an available source without its entity', { investigation, created: true, draft: { version: 1, notes: null, basedOnViewId: null } }],
    ['an answer without the version of the draft', { investigation, created: true, entity }],
    ['a draft without its notes', { investigation, created: true, entity, draft: { version: 1, basedOnViewId: null } }],
    ['a draft without the view it is based on', { investigation, created: true, entity, draft: { version: 1, notes: null } }],
    ['a draft based on something that is not a view ID', { investigation, created: true, entity, draft: { version: 1, notes: null, basedOnViewId: 'not-an-id' } }],
    ['a note of 10,001 characters', { investigation, created: true, entity, draft: { version: 1, notes: 'n'.repeat(10_001), basedOnViewId: null } }],
    ['a draft version of zero', { investigation, created: true, entity, draft: { version: 0 } }],
    ['a repointed source with an entity', { investigation: { ...investigation, sourceState: 'repointed' }, created: false, entity, draft: { version: 1, notes: null, basedOnViewId: null } }],
    ['a repointed source reported as new', { investigation: { ...investigation, sourceState: 'repointed' }, created: true, draft: { version: 1, notes: null, basedOnViewId: null } }],
    ['a removed source with an entity', { investigation: { ...investigation, sourceState: 'removed' }, created: false, entity, draft: { version: 1, notes: null, basedOnViewId: null } }],
    ['a state that does not exist', { investigation: { ...investigation, sourceState: 'gone' }, created: false, draft: { version: 1, notes: null, basedOnViewId: null } }],
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

const listed = { ...investigation, sourceAlias: 'Demo source', save: { state: 'unsaved', savedAt: null }, nodeCount: 10, edgeCount: 13 };
const matchingOf = (value: number) => ({ value, quality: 'exact', scope: 'investigations-matching' });
const countsOf = (investigations: number, sources: number) => ({ investigations: { value: investigations, quality: 'exact', scope: 'investigations' }, sources: { value: sources, quality: 'exact', scope: 'investigation-sources' }, savedViews: { count: { value: 0, quality: 'exact', scope: 'named-views' }, lastEditedAt: null } });

describe('the list of investigations', () => {
  it.each([
    ['an unsaved row', { items: [listed], nextCursor: null, matching: matchingOf(1), retention: { deletedInvestigationsDays: 30 }, counts: countsOf(1, 1) }],
    ['a row whose counts were made under another policy version', { items: [{ ...listed, nodeCount: null, edgeCount: null }], nextCursor: null, matching: matchingOf(1), retention: { deletedInvestigationsDays: 30 }, counts: countsOf(1, 1) }],
    ['a saved row with the time of its view', { items: [{ ...listed, save: { state: 'saved', savedAt: '2026-11-05T10:05:00.000Z' } }], nextCursor: 'next', matching: matchingOf(8), retention: { deletedInvestigationsDays: 30 }, counts: countsOf(7, 3) }],
    ['no rows', { items: [], nextCursor: null, matching: matchingOf(0), retention: { deletedInvestigationsDays: 30 }, counts: countsOf(0, 0) }],
    ['named views with the time of the newest', { items: [], nextCursor: null, matching: matchingOf(0), retention: { deletedInvestigationsDays: 30 }, counts: { ...countsOf(0, 0), savedViews: { count: { value: 3, quality: 'exact', scope: 'named-views' }, lastEditedAt: '2026-11-05T12:30:00.000Z' } } }],
    ['a row of a source taken out of the configuration', { items: [{ ...listed, sourceState: 'removed' }], nextCursor: null, matching: matchingOf(0), retention: { deletedInvestigationsDays: 30 }, counts: countsOf(1, 1) }],
  ])('accepts %s', (_name, answer) => {
    expect(investigationListResponseSchema.safeParse(answer).success).toBe(true);
  });

  it.each([
    ['a row without its source alias', { items: [{ ...investigation, save: listed.save }], nextCursor: null, matching: matchingOf(0), retention: { deletedInvestigationsDays: 30 }, counts: countsOf(1, 1) }],
    ['a saved row with no time', { items: [{ ...listed, save: { state: 'saved', savedAt: null } }], nextCursor: null, matching: matchingOf(0), retention: { deletedInvestigationsDays: 30 }, counts: countsOf(1, 1) }],
    ['an unsaved row with a time', { items: [{ ...listed, save: { state: 'unsaved', savedAt: '2026-11-05T10:05:00.000Z' } }], nextCursor: null, matching: matchingOf(0), retention: { deletedInvestigationsDays: 30 }, counts: countsOf(1, 1) }],
    ['an answer without nextCursor', { items: [], matching: matchingOf(0), retention: { deletedInvestigationsDays: 30 }, counts: countsOf(0, 0) }],
    ['an answer that still says hasMore', { items: [], hasMore: false, nextCursor: null, matching: matchingOf(0), retention: { deletedInvestigationsDays: 30 }, counts: countsOf(0, 0) }],
    ['an answer without the matching count', { items: [], nextCursor: null, counts: countsOf(0, 0) }],
    ['a matching count that is not exact', { items: [], nextCursor: null, matching: { value: 1, quality: 'lowerBound', scope: 'investigations-matching' }, counts: countsOf(0, 0) }],
    ['a row without its counts', { items: [{ investigation, sourceAlias: 'Demo source', save: listed.save }], nextCursor: null, matching: matchingOf(1), retention: { deletedInvestigationsDays: 30 }, counts: countsOf(1, 1) }],
    ['an answer without counts', { items: [], nextCursor: null, matching: matchingOf(0) }],
    ['counts without the sources', { items: [], nextCursor: null, matching: matchingOf(0), retention: { deletedInvestigationsDays: 30 }, counts: { investigations: countsOf(0, 0).investigations, savedViews: countsOf(0, 0).savedViews } }],
    ['counts without the saved views', { items: [], nextCursor: null, matching: matchingOf(0), retention: { deletedInvestigationsDays: 30 }, counts: { investigations: countsOf(0, 0).investigations, sources: countsOf(0, 0).sources } }],
    ['saved views with a time that is not a time', { items: [], nextCursor: null, matching: matchingOf(0), retention: { deletedInvestigationsDays: 30 }, counts: { ...countsOf(0, 0), savedViews: { ...countsOf(0, 0).savedViews, lastEditedAt: 'yesterday' } } }],
    ['saved views whose count is not exact', { items: [], nextCursor: null, matching: matchingOf(0), retention: { deletedInvestigationsDays: 30 }, counts: { ...countsOf(0, 0), savedViews: { count: { value: 2, quality: 'estimated', scope: 'named-views' }, lastEditedAt: null } } }],
    ['a count that is not exact', { items: [], nextCursor: null, matching: matchingOf(0), retention: { deletedInvestigationsDays: 30 }, counts: { ...countsOf(0, 0), investigations: { value: 3, quality: 'lowerBound', scope: 'investigations' } } }],
    ['a count with another scope', { items: [], nextCursor: null, matching: matchingOf(0), retention: { deletedInvestigationsDays: 30 }, counts: { ...countsOf(0, 0), sources: { value: 0, quality: 'exact', scope: 'investigations' } } }],
    ['a count with no value', { items: [], nextCursor: null, matching: matchingOf(0), retention: { deletedInvestigationsDays: 30 }, counts: { ...countsOf(0, 0), sources: { quality: 'unknown', scope: 'investigation-sources' } } }],
    ['a negative count', { items: [], nextCursor: null, matching: matchingOf(0), retention: { deletedInvestigationsDays: 30 }, counts: { ...countsOf(0, 0), investigations: { value: -1, quality: 'exact', scope: 'investigations' } } }],
    ['an extra count', { items: [], nextCursor: null, matching: matchingOf(0), retention: { deletedInvestigationsDays: 30 }, counts: { ...countsOf(0, 0), patterns: { value: 0, quality: 'exact', scope: 'patterns' } } }],
  ])('refuses %s', (_name, answer) => {
    expect(investigationListResponseSchema.safeParse(answer).success).toBe(false);
  });
});

describe('the query of the list of investigations', () => {
  it.each([[{}], [{ limit: '5' }], [{ limit: '100', sort: 'lastEdited' }], [{ sort: 'lastEdited' }], [{ limit: '1' }], [{ limit: '0' }], [{ limit: '101' }], [{ cursor: 'abc' }], [{ status: 'closed', source: 'north', q: 'ab' }]])('accepts %j', (query) => {
    expect(investigationListQuerySchema.safeParse(query).success).toBe(true);
  });

  it('reads the limit as a number', () => {
    expect(investigationListQuerySchema.parse({ limit: '7' })).toEqual({ limit: 7 });
  });

  it.each([[{ limit: '1.5' }], [{ limit: 'x' }], [{ limit: '' }], [{ limit: '-1' }], [{ sort: 'name' }], [{ sort: '' }], [{ other: '1' }], [{ limit: ['5', '6'] }], [{ cursor: '' }], [{ status: 'deleted' }], [{ status: '' }], [{ source: '' }], [{ q: 'a' }], [{ q: 'x'.repeat(201) }], [{ q: 'a\u0000b' }], [{ q: 'ab\ud800' }]])('refuses %j', (query) => {
    expect(investigationListQuerySchema.safeParse(query).success).toBe(false);
  });

  it('counts the length of the text in characters, not code units', () => {
    expect(investigationListQuerySchema.safeParse({ q: '\u{1F600}' }).success).toBe(false);
    expect(investigationListQuerySchema.safeParse({ q: '\u{1F600}\u{1F600}' }).success).toBe(true);
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

describe('the request to rename an investigation', () => {
  it.each([
    ['an empty title', { title: '', expectedVersion: 1 }],
    ['a title of only whitespace', { title: ' \t\n ', expectedVersion: 1 }],
    ['a title of 201 code points', { title: 'a'.repeat(201), expectedVersion: 1 }],
    ['a title of 101 emoji and one more', { title: '\u{1F600}'.repeat(201), expectedVersion: 1 }],
    ['a title with a NUL', { title: 'a\u0000b', expectedVersion: 1 }],
    ['a title with an unpaired high surrogate', { title: 'a\ud800b', expectedVersion: 1 }],
    ['a title with an unpaired low surrogate', { title: 'a\udc00b', expectedVersion: 1 }],
    ['no expectedVersion', { title: 'Mule ring' }],
    ['an expectedVersion of 0', { title: 'Mule ring', expectedVersion: 0 }],
    ['an expectedVersion that is text', { title: 'Mule ring', expectedVersion: '1' }],
    ['another field', { title: 'Mule ring', expectedVersion: 1, status: 'closed' }],
  ])('rejects %s', (_name, body) => {
    expect(renameRequestSchema.safeParse(body).success).toBe(false);
  });

  it('accepts a title as typed, with accents and emoji, up to 200 code points', () => {
    expect(renameRequestSchema.safeParse({ title: '  Café \u{1F600} ring  ', expectedVersion: 3 }).success).toBe(true);
    expect(renameRequestSchema.safeParse({ title: '\u{1F600}'.repeat(200), expectedVersion: 1 }).success).toBe(true);
  });
});

describe('the request to change the status of an investigation', () => {
  it.each([
    ['a status that is not known', { status: 'deleted', expectedVersion: 1 }],
    ['no status', { expectedVersion: 1 }],
    ['no expectedVersion', { status: 'closed' }],
    ['another field', { status: 'closed', expectedVersion: 1, title: 'x' }],
  ])('rejects %s', (_name, body) => {
    expect(statusChangeRequestSchema.safeParse(body).success).toBe(false);
  });

  it.each(['open', 'closed', 'archived'])('accepts %s', (status) => {
    expect(statusChangeRequestSchema.safeParse({ status, expectedVersion: 2 }).success).toBe(true);
  });
});

describe('the answer to a status change', () => {
  const investigation = { id: '0194f1d0-0000-7000-8000-000000000001', sourceId: 'src', title: 'T', caseRef: null, status: 'closed', startingEntity: null, sourceState: 'available', createdAt: '2026-11-05T12:00:00.000Z', lastEditedAt: '2026-11-05T12:00:00.000Z', version: 2 };

  it('carries closedAt and archivedAt, each a time or null', () => {
    expect(statusChangeResponseSchema.safeParse({ investigation: { ...investigation, closedAt: '2026-11-06T12:00:00.000Z', archivedAt: null } }).success).toBe(true);
    expect(statusChangeResponseSchema.safeParse({ investigation }).success).toBe(false);
    expect(statusChangeResponseSchema.safeParse({ investigation: { ...investigation, closedAt: 'yesterday', archivedAt: null } }).success).toBe(false);  });
});

describe('the answer to reading an investigation', () => {
  const layout = { schemaVersion: 1, layout: 'force', nodes: [], edges: [], groups: [] };
  const queryContext = { schemaVersion: 1, loaded: { nodes: [], edges: [] }, expansions: [], filters: { entityTypes: [], relTypes: [], time: null, properties: [] } };
  const draft = { version: 2, layout, queryContext, notes: null, basedOnViewId: null };

  it.each([
    ['unsaved', { state: 'unsaved', savedAt: null }],
    ['saved with the time of the view', { state: 'saved', savedAt: '2026-11-08T09:30:00.000Z' }],
  ])('accepts a draft that is %s', (_name, save) => {
    expect(investigationResponseSchema.safeParse({ investigation, draft, save }).success).toBe(true);
  });

  it.each([
    ['no save', { investigation, draft }],
    ['a saved state without its time', { investigation, draft, save: { state: 'saved', savedAt: null } }],
    ['an unsaved state with a time', { investigation, draft, save: { state: 'unsaved', savedAt: '2026-11-08T09:30:00.000Z' } }],
  ])('refuses %s', (_name, body) => {
    expect(investigationResponseSchema.safeParse(body).success).toBe(false);
  });
});

describe('the viewport of a layout document', () => {
  const layout = { schemaVersion: 1, layout: 'force', nodes: [], edges: [], groups: [] };

  it('takes a viewport with no canvas size, as a draft stored before the size was kept', () => {
    expect(layoutDocumentSchema.parse({ ...layout, viewport: { zoom: 1, x: 2, y: 3 } }).viewport).toEqual({ zoom: 1, x: 2, y: 3 });
  });

  it('takes a viewport with the size of the canvas it was taken at, and keeps it', () => {
    expect(layoutDocumentSchema.parse({ ...layout, viewport: { zoom: 1, x: 2, y: 3, canvas: { width: 968, height: 720 } } }).viewport?.canvas).toEqual({ width: 968, height: 720 });
  });

  it.each([
    ['a canvas with no height', { width: 968 }],
    ['a canvas of no width', { width: 0, height: 720 }],
    ['a negative height', { width: 968, height: -1 }],
    ['a canvas with a field of its own kind', { width: 968, height: 720, depth: 1 }],
  ])('refuses %s', (_name, canvas) => {
    expect(layoutDocumentSchema.safeParse({ ...layout, viewport: { zoom: 1, x: 2, y: 3, canvas } }).success).toBe(false);
  });
});

describe('the groups of a layout document', () => {
  const layout = { schemaVersion: 1, layout: 'force', nodes: [], edges: [] };
  const group = { id: 'g1', label: 'widget', by: 'entityType', members: [{ t: 'widget', id: 'W-1' }] };

  it('takes a group with a collapsed flag, and one without it as a document of before the flag', () => {
    expect(layoutDocumentSchema.parse({ ...layout, groups: [{ ...group, collapsed: true }] }).groups[0]?.collapsed).toBe(true);
    expect(layoutDocumentSchema.parse({ ...layout, groups: [group] }).groups[0]?.collapsed).toBeUndefined();
  });

  it('refuses a collapsed flag that is not a boolean, and any other field of a group', () => {
    expect(layoutDocumentSchema.safeParse({ ...layout, groups: [{ ...group, collapsed: 'yes' }] }).success).toBe(false);
    expect(layoutDocumentSchema.safeParse({ ...layout, groups: [{ ...group, value: 'USD' }] }).success).toBe(false);
  });
});

describe('a property filter of a stored document', () => {
  const context = (properties: unknown[]) => ({ schemaVersion: 1, loaded: { nodes: [], edges: [] }, expansions: [], filters: { entityTypes: [], relTypes: [], time: null, properties } });
  const accepted = (entry: unknown): boolean => queryContextDocumentSchema.safeParse(context([entry])).success;
  const choice = { on: 'entity', type: 'kind-a', key: 'score', kind: 'text', op: 'in', values: ['a', 'b'] };
  const range = { on: 'relationship', type: 'link-a', key: 'weight', kind: 'number', op: 'between', values: [], from: '1000', to: '5000' };

  it('is read back as it was written, for a choice and a range, with the older shape still accepted', () => {
    expect(accepted(choice)).toBe(true);
    expect(accepted(range)).toBe(true);
    expect(accepted({ key: 'score', op: 'eq', values: ['x'] })).toBe(true);
    expect(accepted({ ...range, from: '9007199254740993', to: '9007199254740994' })).toBe(true);
    expect(accepted({ ...choice, kind: 'number', values: ['1000000000000000000000', '0.0000001'] })).toBe(true);
    expect(queryContextDocumentSchema.parse(context([range])).filters.properties[0]).toEqual(range);
  });

  it.each([
    ['an on that is not entity or relationship', { ...choice, on: 'edge' }],
    ['a kind outside the filter kinds', { ...choice, kind: 'duration' }],
    ['a type without its kind', { key: 'score', op: 'in', values: ['a'], on: 'entity', type: 'kind-a' }],
    ['a bound on the older shape', { key: 'score', op: 'between', values: [], from: '1' }],
    ['an in with no value', { ...choice, values: [] }],
    ['an in with 21 values', { ...choice, values: Array.from({ length: 21 }, (_unused, at) => String(at)) }],
    ['an in with a bound', { ...choice, from: 'a' }],
    ['a value that does not read as its kind', { ...choice, kind: 'number', values: ['1,000'] }],
    ['a number in exponent form', { ...choice, kind: 'number', values: ['1e21'] }],
    ['a boolean that is not true or false', { ...choice, kind: 'boolean', values: ['yes'] }],
    ['a text over 256 characters', { ...choice, values: ['x'.repeat(257)] }],
    ['a between with values', { ...range, values: ['1'] }],
    ['a between with no bound', { ...range, from: undefined, to: undefined }],
    ['a between on a boolean', { ...range, kind: 'boolean', from: 'true', to: 'true' }],
    ['a between on a text', { ...range, kind: 'text', from: 'a', to: 'b' }],
    ['a bound that does not read as its kind', { ...range, kind: 'date', from: 'March 1', to: undefined }],
    ['a from after the to', { ...range, from: '5000', to: '1000' }],
    ['a date from after the to', { ...range, kind: 'date', from: '2026-03-02', to: '2026-03-01' }],
    ['an op that is not in or between', { ...choice, op: 'eq' }],
    ['the same value twice', { ...choice, values: ['a', 'a'] }],
    ['a value with a NUL', { ...choice, values: ['a\u0000b'] }],
    ['a value with a lone surrogate', { ...choice, values: ['a\ud800'] }],
    ['a key over 256 characters', { ...choice, key: 'k'.repeat(257) }],
    ['a type over 256 characters', { ...choice, type: 't'.repeat(257) }],
    ['a key with a NUL', { ...choice, key: 'k\u0000' }],
    ['a type with a lone surrogate', { ...choice, type: 't\ud800' }],
  ])('is refused with %s', (_name, entry) => {
    expect(accepted(entry)).toBe(false);
  });

  it('refuses two filters on the same property of the same type, and accepts the same property on two types', () => {
    expect(queryContextDocumentSchema.safeParse(context([choice, { ...choice, values: ['c'] }])).success).toBe(false);
    expect(queryContextDocumentSchema.safeParse(context([choice, { ...choice, type: 'kind-b' }])).success).toBe(true);
  });

  it('accepts a from equal to the to, a one-ended range, and a date and time range', () => {
    expect(accepted({ ...range, from: '5', to: '5' })).toBe(true);
    expect(accepted({ ...range, to: undefined })).toBe(true);
    expect(accepted({ ...range, kind: 'dateTime', from: '2026-03-01T10:00:00Z', to: '2026-03-01T10:00:00.000000001Z' })).toBe(true);
  });
});

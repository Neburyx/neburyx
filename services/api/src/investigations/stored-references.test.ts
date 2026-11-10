import { rmSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import type { InvestigationRow } from '../db/investigations-repository.js';
import { createLogger } from '../logger.js';
import { parseMapping } from '../mapping/load.js';
import { encodeStored } from '../reference/stored-text.js';
import { makeToken } from '../reference/token.js';
import { identityHashOf } from '../registry/identity-hash.js';
import { LOCAL_IDENTITY, memoryAppStore } from '../testing/app-store.js';
import { TEST_REFERENCE_KEYS } from '../testing/gate.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { testSourceGate } from '../testing/source-gate.js';
import { makeWebRoot } from '../testing/web-root.js';
import { entityRows, plainNode } from '../testing/entity-fixtures.js';
import { TestExecutor } from '../testing/gate.js';
import { withOnlineIndexes } from '../testing/search-fixtures.js';
import { initialDraftDocuments } from './draft.js';
import { createStoredReferences } from './stored-references.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

const VALUE = '+1-212-555-0100';
const entities = (keyed: boolean) => [
  { type: 'phone', label: 'Handle', stable_id: 'phoneNumber', ...(keyed ? { pii: [{ property: 'phoneNumber', class: 'phone' }] } : {}) },
  { type: 'person', label: 'Person', stable_id: 'personId' },
];
const mappingOf = (keyed: boolean) => parseMapping(fileOf(baseSource({ id: 'demo', entities: entities(keyed), relationships: [{ type: 'HAS_PHONE', from: 'person', to: 'phone' }] })), 'neburyx.yaml');
const keyedMapping = mappingOf(true);
const refs = createStoredReferences(keyedMapping, TEST_REFERENCE_KEYS);
const token = makeToken(TEST_REFERENCE_KEYS, { sourceId: 'demo', entityType: 'phone' }, VALUE);

describe('stored references of a type that is keyed now', () => {
  it('converts a raw ID to its token, leaves a token and an ordinary ID as they are', () => {
    expect(refs.entityId('demo', 'phone', VALUE)).toBe(token);
    expect(refs.entityId('demo', 'phone', token)).toBe(token);
    expect(refs.entityId('demo', 'person', 'P-1')).toBe('P-1');
    expect(refs.entityId('gone', 'phone', VALUE)).toBe(VALUE);
    expect(refs.rawValue('demo', 'phone', token)).toBe(VALUE);
    expect(refs.rawValue('demo', 'person', 'P-1')).toBeUndefined();
  });

  it('treats a raw value that only starts like a token as a raw value', () => {
    expect(refs.entityId('demo', 'phone', 'p1.not-a-token')).toMatch(/^p1\./);
    expect(refs.rawValue('demo', 'phone', 'p1.not-a-token')).toBe('p1.not-a-token');
  });

  it('converts every stored place of the draft and holds no raw value after', () => {
    const layout = refs.layout('demo', {
      schemaVersion: 1,
      layout: 'force',
      nodes: [
        { t: 'phone', id: VALUE, pinned: false, hidden: false, groupId: null },
        { t: 'person', id: 'P-1', pinned: false, hidden: false, groupId: null },
      ],
      edges: [{ t: 'HAS_PHONE', from: { t: 'person', id: 'P-1' }, to: { t: 'phone', id: VALUE }, hidden: false }],
      groups: [{ id: 'g', label: 'g', by: 'x', members: [{ t: 'phone', id: VALUE }] }],
    });
    const context = refs.queryContext('demo', {
      schemaVersion: 1,
      loaded: { nodes: [{ t: 'phone', id: VALUE }], edges: [{ t: 'HAS_PHONE', from: { t: 'person', id: 'P-1' }, to: { t: 'phone', id: VALUE } }] },
      expansions: [{ from: { t: 'phone', id: VALUE }, relTypes: [], neighborTypes: [], window: null, sort: 'a', pages: 1 }],
      filters: { entityTypes: [], relTypes: [], time: null, properties: [] },
    });
    expect(JSON.stringify([layout, context])).not.toContain(VALUE);
    expect(layout.edges[0]).toMatchObject({ from: { t: 'person', id: 'P-1' }, to: { t: 'phone', id: token } });
    expect(layout.nodes[1]?.id).toBe('P-1');
  });

  it('gives a generated title that held the value the type’s name, and keeps a title the person wrote', () => {
    const row = { sourceId: 'demo', title: `Handle ${VALUE}`, startingEntityType: 'phone', startingStableId: VALUE };
    expect(refs.title(row)).toBe('Handle');
    expect(refs.title({ ...row, startingStableId: token })).toBe('Handle');
    expect(refs.title({ ...row, title: 'My own title' })).toBe('My own title');
    expect(createStoredReferences(mappingOf(false), TEST_REFERENCE_KEYS).title(row)).toBe(row.title);
  });
});

describe('listing and reading an investigation stored before its type was keyed', () => {
  const [demo] = keyedMapping.sources;
  if (demo === undefined) throw new Error('the fixture has a source');
  const id = '0192f000-0000-7000-8000-0000000000c1';
  const row: InvestigationRow = {
    id,
    sourceId: 'demo',
    sourceIdentityHash: identityHashOf(demo),
    ownerId: LOCAL_IDENTITY.principal.id,
    title: `Handle ${VALUE}`,
    caseRef: null,
    startingEntityType: 'phone',
    startingStableId: VALUE,
    status: 'open',
    createdAt: '2026-11-05T10:00:00.000Z',
    lastEditedAt: '2026-11-05T10:00:00.000Z', closedAt: null, archivedAt: null,
    version: 1,
  };

  it('returns no raw value from the list or the read, and writes nothing back', async () => {
    const store = memoryAppStore();
    store.investigations.push(row);
    const initial = initialDraftDocuments({ entityType: 'phone', stableId: VALUE });
    store.drafts.push({ id: '0192f000-0000-7000-8000-0000000000d1', version: 1, notes: null, investigationId: id, layout: initial.layout, queryContext: initial.queryContext, mappingHash: demo.configHash });
    const before = JSON.stringify([store.investigations, store.drafts]);
    const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store, mapping: keyedMapping, gate: testSourceGate(keyedMapping).gate, referenceKeys: TEST_REFERENCE_KEYS });
    const list = await app.inject({ method: 'GET', url: '/v1/investigations' });
    const read = await app.inject({ method: 'GET', url: `/v1/investigations/${id}` });
    expect(list.statusCode).toBe(200);
    expect(read.statusCode).toBe(200);
    for (const response of [list, read]) {
      expect(response.body).not.toContain(VALUE);
      expect(response.body).toContain(token);
    }
    expect(read.json()).toMatchObject({ investigation: { title: 'Handle', startingEntity: { stableId: token } } });
    expect(JSON.stringify([store.investigations, store.drafts])).toBe(before);
    await app.close();
  });

  it('returns a stored raw ID of a type that is not keyed as it is', async () => {
    const plain = mappingOf(false);
    const [source] = plain.sources;
    const store = memoryAppStore();
    store.investigations.push({ ...row, sourceIdentityHash: identityHashOf(source ?? demo) });
    const initial = initialDraftDocuments({ entityType: 'phone', stableId: VALUE });
    store.drafts.push({ id: '0192f000-0000-7000-8000-0000000000d1', version: 1, notes: null, investigationId: id, layout: initial.layout, queryContext: initial.queryContext, mappingHash: (source ?? demo).configHash });
    const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store, mapping: plain, gate: testSourceGate(plain).gate, referenceKeys: TEST_REFERENCE_KEYS });
    const read = await app.inject({ method: 'GET', url: `/v1/investigations/${id}` });
    expect(read.json()).toMatchObject({ investigation: { title: `Handle ${VALUE}`, startingEntity: { stableId: VALUE } } });
    await app.close();
  });

  it('opens the stored investigation again by its case reference, with the masked display title, and creates nothing', async () => {
    const store = memoryAppStore();
    store.investigations.push({ ...row, caseRef: 'CASE-1' });
    store.drafts.push({ id: '0192f000-0000-7000-8000-0000000000d1', version: 1, notes: null, investigationId: id, layout: initialDraftDocuments({ entityType: 'phone', stableId: VALUE }).layout, queryContext: initialDraftDocuments({ entityType: 'phone', stableId: VALUE }).queryContext , mappingHash: demo.configHash });
    const executor = new TestExecutor(withOnlineIndexes(demo, () => Promise.resolve(entityRows(plainNode(['Handle'], { phoneNumber: VALUE })))));
    const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store, mapping: keyedMapping, gate: testSourceGate(keyedMapping, { executor, referenceKeys: TEST_REFERENCE_KEYS }).gate, referenceKeys: TEST_REFERENCE_KEYS });
    const response = await app.inject({ method: 'POST', url: '/v1/investigations', payload: { sourceId: 'demo', caseRef: 'CASE-1', entity: { sourceId: 'demo', entityType: 'phone', value: VALUE } } });
    expect(response.statusCode).toBe(200);
    expect(JSON.stringify(response.json().investigation)).not.toContain(VALUE);
    expect(JSON.stringify(response.json().entity.ref)).not.toContain(VALUE);
    expect(response.json()).toMatchObject({ created: false, investigation: { id, title: expect.stringMatching(/^Handle /) } });
    expect(store.investigations).toHaveLength(1);
    expect(store.investigations[0]?.startingStableId).toBe(VALUE);
    await app.close();
  });
});

describe('stored documents with typed edge ends', () => {
  const twoKeyed = parseMapping(
    fileOf(
      baseSource({
        id: 'demo',
        entities: [
          { type: 'handle_a', label: 'HandleA', stable_id: 'idA', pii: [{ property: 'idA', class: 'text' }] },
          { type: 'handle_b', label: 'HandleB', stable_id: 'idB', pii: [{ property: 'idB', class: 'text' }] },
          { type: 'person', label: 'Person', stable_id: 'personId' },
        ],
        relationships: [
          { type: 'HAS', from: 'person', to: 'handle_a' },
          { type: 'HAS', from: 'person', to: 'handle_b' },
        ],
      }),
    ),
    'neburyx.yaml',
  );
  const both = createStoredReferences(twoKeyed, TEST_REFERENCE_KEYS);
  const tokenOf = (type: string, value: string) => makeToken(TEST_REFERENCE_KEYS, { sourceId: 'demo', entityType: type }, value);
  const node = (t: string, id: string) => ({ t, id, pinned: false, hidden: false, groupId: null });
  const end = (t: string, id: string) => ({ t, id });

  it('gives each end of an edge the type it was stored with, so two keyed types that share an ID stay apart', () => {
    const layout = both.layout('demo', {
      schemaVersion: 1,
      layout: 'force',
      nodes: [node('person', 'P-1'), node('handle_a', 'X'), node('handle_b', 'X')],
      edges: [
        { t: 'HAS', from: end('person', 'P-1'), to: end('handle_a', 'X'), hidden: false },
        { t: 'HAS', from: end('person', 'P-1'), to: end('handle_b', 'X'), hidden: false },
      ],
      groups: [],
    });
    expect(layout.edges.map((edge) => edge.to)).toEqual([end('handle_a', tokenOf('handle_a', 'X')), end('handle_b', tokenOf('handle_b', 'X'))]);
    expect(JSON.stringify(layout)).not.toContain('"X"');
  });

  it('keeps the edge of a relationship type that is no longer mapped, with its ends as stored', () => {
    const layout = both.layout('demo', { schemaVersion: 1, layout: 'force', nodes: [node('person', 'P-1')], edges: [{ t: 'GONE', from: end('person', 'P-1'), to: end('handle_a', 'X'), hidden: false }], groups: [] });
    expect(layout.edges).toEqual([{ t: 'GONE', from: end('person', 'P-1'), to: end('handle_a', tokenOf('handle_a', 'X')), hidden: false }]);
  });

  it.each([['a NUL', 'A\u0000B'], ['an unpaired surrogate', 'A\ud800B'], ['text that starts with the marker', '~e1:AAA']])('returns the ID of an edge end with %s as it was sent', (_name, id) => {
    const stored = both.toStored('demo', 'person', id);
    const layout = both.layout('demo', { schemaVersion: 1, layout: 'force', nodes: [], edges: [{ t: 'HAS', from: end('person', stored), to: end('person', 'P-2'), hidden: false }], groups: [] });
    expect(layout.edges[0]?.from).toEqual(end('person', id));
  });

  it('returns the token of a keyed end whose stable ID is a name', () => {
    const layout = both.layout('demo', { schemaVersion: 1, layout: 'force', nodes: [], edges: [{ t: 'HAS', from: end('person', 'P-1'), to: end('handle_a', 'Jordan Lee'), hidden: false }], groups: [] });
    expect(layout.edges[0]?.to).toEqual(end('handle_a', tokenOf('handle_a', 'Jordan Lee')));
  });

  it('keeps the rule of a derived edge and the ID of a stored one', () => {
    const context = both.queryContext('demo', {
      schemaVersion: 1,
      loaded: { nodes: [], edges: [{ t: 'HAS', from: end('person', 'P-1'), to: end('handle_a', 'X'), id: 'REL-1' }, { t: 'SHARES', from: end('person', 'P-1'), to: end('person', 'P-2'), ruleId: 'shared-handle' }] },
      expansions: [],
      filters: { entityTypes: [], relTypes: [], time: null, properties: [] },
    });
    expect(context.loaded.edges[0]).toMatchObject({ id: 'REL-1' });
    expect(context.loaded.edges[1]).toMatchObject({ ruleId: 'shared-handle', to: end('person', 'P-2') });
  });

  it('drops a stored property filter that names a personal-data property, and keeps the others', () => {
    const context = both.queryContext('demo', {
      schemaVersion: 1,
      loaded: { nodes: [], edges: [] },
      expansions: [],
      filters: { entityTypes: [], relTypes: [], time: null, properties: [{ key: 'idA', op: 'eq', values: ['SECRET-A'] }, { key: 'personId', op: 'eq', values: ['P-1'] }] },
    });
    expect(context.filters.properties).toEqual([{ key: 'personId', op: 'eq', values: ['P-1'] }]);
    expect(JSON.stringify(context)).not.toContain('SECRET-A');
  });

  it('gives a generated title the type’s current name whatever the type was called when it was made, cut or whole', () => {
    const row = (title: string, id: string) => ({ sourceId: 'demo', title, startingEntityType: 'handle_a', startingStableId: id });
    expect(both.title(row('Old name RAW-SECRET', 'RAW-SECRET'))).toBe('HandleA');
    const long = 'V'.repeat(400);
    const cut = `${'Old name'} ${long}`.slice(0, 199) + '…';
    expect(both.title(row(cut, long))).toBe('HandleA');
    expect(both.title(row('My own title', 'RAW-SECRET'))).toBe('My own title');
    // a shorter title that ends in an ellipsis and starts like the value was written by a person
    expect(both.title(row('Review A…', 'Alpha-123'))).toBe('Review A…');
  });

  it('refuses a reference of a keyed type that is not its token, and accepts the token and any reference of another type', () => {
    expect(() => both.authenticate('demo', 'handle_a', 'RAW-SECRET')).toThrow();
    expect(() => both.authenticate('demo', 'handle_a', tokenOf('handle_b', 'RAW-SECRET'))).toThrow();
    expect(() => both.authenticate('demo', 'handle_a', tokenOf('handle_a', 'RAW-SECRET'))).not.toThrow();
    expect(() => both.authenticate('demo', 'person', 'P-1')).not.toThrow();
    expect(() => both.authenticate('gone', 'handle_a', 'anything')).not.toThrow();
  });
});

describe('opening with a reference the person supplied', () => {
  it('refuses a raw value in reference form for a keyed type even when the investigation found is one whose source points elsewhere', async () => {
    const [source] = keyedMapping.sources;
    const store = memoryAppStore();
    store.investigations.push({ id: '0192f000-0000-7000-8000-0000000000c9', sourceId: 'demo', sourceIdentityHash: 'another-database', ownerId: LOCAL_IDENTITY.principal.id, title: 'Handle', caseRef: 'CASE-9', startingEntityType: 'phone', startingStableId: VALUE, status: 'open', createdAt: '2026-11-05T10:00:00.000Z', lastEditedAt: '2026-11-05T10:00:00.000Z', closedAt: null, archivedAt: null, version: 1 });
    const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store, mapping: keyedMapping, gate: testSourceGate(keyedMapping, { referenceKeys: TEST_REFERENCE_KEYS }).gate, referenceKeys: TEST_REFERENCE_KEYS });
    const send = (stableId: string) => app.inject({ method: 'POST', url: '/v1/investigations', payload: { sourceId: 'demo', caseRef: 'CASE-9', mask: true, entity: { sourceId: 'demo', entityType: 'phone', stableId } } });
    expect((await send(VALUE)).statusCode).toBe(400);
    expect((await send(`${token}x`)).statusCode).toBe(400);
    expect(source).toBeDefined();
    await app.close();
  });

  it('opens a node of a type that is not keyed whose ID Postgres cannot hold, stores it encoded, and answers it exactly', async () => {
    const store = memoryAppStore();
    const executor = new TestExecutor(withOnlineIndexes(keyedMapping.sources[0] ?? (() => { throw new Error('no source'); })(), (call) => Promise.resolve(entityRows(plainNode(['Person'], { personId: call.parameters['stableId'] })))));
    const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store, mapping: keyedMapping, gate: testSourceGate(keyedMapping, { executor, referenceKeys: TEST_REFERENCE_KEYS }).gate, referenceKeys: TEST_REFERENCE_KEYS });
    for (const stableId of ['a\u0000b', 'a\ud800b', 'a\udc00b', '~e1:looks-like-the-marker']) {
      const opened = await app.inject({ method: 'POST', url: '/v1/investigations', payload: { sourceId: 'demo', caseRef: `C-${store.investigations.length}`, entity: { sourceId: 'demo', entityType: 'person', value: stableId } } });
      expect(opened.statusCode, JSON.stringify(stableId)).toBe(201);
      const stored = store.investigations.at(-1);
      expect(stored?.startingStableId).toMatch(/^~e1:/);
      expect(JSON.stringify(store.drafts.at(-1)?.layout)).not.toContain('\\u0000');
      expect(opened.json().investigation.startingEntity.stableId).toBe(stableId);
      const read = await app.inject({ method: 'GET', url: `/v1/investigations/${opened.json().investigation.id}` });
      expect(read.json().investigation.startingEntity.stableId).toBe(stableId);
      expect(read.json().draft.layout.nodes[0].id).toBe(stableId);
      expect(read.json().draft.queryContext.loaded.nodes[0].id).toBe(stableId);
    }
    await app.close();
  });
});

describe('a type that is no longer keyed', () => {
  const unkeyed = mappingOf(false);
  const plainRefs = createStoredReferences(unkeyed, TEST_REFERENCE_KEYS);

  it('shows the investigations stored under tokens with the IDs they stand for, and finds them again by the ID', () => {
    expect(plainRefs.entityId('demo', 'phone', token)).toBe(VALUE);
    expect(plainRefs.entityId('demo', 'phone', VALUE)).toBe(VALUE);
    expect(plainRefs.storedForms('demo', 'phone', VALUE)).toContain(token);
  });

  it('lists, reads and opens again an investigation stored while the type was keyed', async () => {
    const [source] = unkeyed.sources;
    if (source === undefined) throw new Error('no source');
    const store = memoryAppStore();
    store.investigations.push({ id: '0192f000-0000-7000-8000-0000000000f1', sourceId: 'demo', sourceIdentityHash: identityHashOf(source), ownerId: LOCAL_IDENTITY.principal.id, title: 'Handle', caseRef: 'CASE-K', startingEntityType: 'phone', startingStableId: token, status: 'open', createdAt: '2026-11-05T10:00:00.000Z', lastEditedAt: '2026-11-05T10:00:00.000Z', closedAt: null, archivedAt: null, version: 1 });
    const initial = initialDraftDocuments({ entityType: 'phone', stableId: token });
    store.drafts.push({ id: '0192f000-0000-7000-8000-0000000000f2', version: 1, notes: null, investigationId: '0192f000-0000-7000-8000-0000000000f1', layout: initial.layout, queryContext: initial.queryContext, mappingHash: source.configHash });
    const executor = new TestExecutor(withOnlineIndexes(source, (call) => Promise.resolve(entityRows(plainNode(['Handle'], { phoneNumber: call.parameters['stableId'] })))));
    const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store, mapping: unkeyed, gate: testSourceGate(unkeyed, { executor, referenceKeys: TEST_REFERENCE_KEYS }).gate, referenceKeys: TEST_REFERENCE_KEYS });
    const read = await app.inject({ method: 'GET', url: '/v1/investigations/0192f000-0000-7000-8000-0000000000f1' });
    expect(read.json().investigation.startingEntity.stableId).toBe(VALUE);
    expect(read.json().draft.layout.nodes[0].id).toBe(VALUE);
    const entity = await app.inject({ method: 'GET', url: `/v1/entities/demo/phone/${encodeURIComponent(VALUE)}` });
    expect(entity.statusCode).toBe(200);
    const again = await app.inject({ method: 'POST', url: '/v1/investigations', payload: { sourceId: 'demo', caseRef: 'CASE-K', entity: { sourceId: 'demo', entityType: 'phone', value: VALUE } } });
    expect(again.statusCode).toBe(200);
    expect(again.json().investigation.id).toBe('0192f000-0000-7000-8000-0000000000f1');
    expect(store.investigations).toHaveLength(1);
    await app.close();
  });
});

describe('an edge end of a type that is no longer keyed', () => {
  it('is the ID its node shows, not the token it was stored as', () => {
    const plainRefs = createStoredReferences(mappingOf(false), TEST_REFERENCE_KEYS);
    const tokenOfX = makeToken(TEST_REFERENCE_KEYS, { sourceId: 'demo', entityType: 'phone' }, VALUE);
    const node = (id: string) => ({ t: 'phone', id, pinned: false, hidden: false, groupId: null });
    const layout = plainRefs.layout('demo', { schemaVersion: 1, layout: 'force', nodes: [node(tokenOfX)], edges: [{ t: 'HAS_PHONE', from: { t: 'person', id: 'P-1' }, to: { t: 'phone', id: tokenOfX }, hidden: false }], groups: [] });
    expect(layout.nodes[0]?.id).toBe(VALUE);
    expect(layout.edges[0]?.to).toEqual({ t: 'phone', id: VALUE });
  });
});

describe('opening with text PostgreSQL cannot hold in another field', () => {
  it('refuses a NUL or an unpaired surrogate in the case reference, and a NUL in the entity type, before anything is looked up', async () => {
    const store = memoryAppStore();
    const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store, mapping: keyedMapping, gate: testSourceGate(keyedMapping, { referenceKeys: TEST_REFERENCE_KEYS }).gate, referenceKeys: TEST_REFERENCE_KEYS });
    const send = (caseRef: string, entityType: string) => app.inject({ method: 'POST', url: '/v1/investigations', payload: { sourceId: 'demo', caseRef, entity: { sourceId: 'demo', entityType, stableId: 'P-1' } } });
    for (const [caseRef, entityType] of [['C\u0000', 'person'], ['C\ud800', 'person'], ['C', 'per\u0000son']] as const) expect((await send(caseRef, entityType)).statusCode, JSON.stringify([caseRef, entityType])).toBe(400);
    await app.close();
  });
});

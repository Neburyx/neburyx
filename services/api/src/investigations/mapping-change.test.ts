import { rmSync } from 'node:fs';
import { investigationResponseSchema, type LayoutDocument, type QueryContextDocument } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import type { InvestigationRow } from '../db/investigations-repository.js';
import { createLogger } from '../logger.js';
import { parseMapping } from '../mapping/load.js';
import { identityHashOf } from '../registry/identity-hash.js';
import { LOCAL_IDENTITY, memoryAppStore, type MemoryAppStore } from '../testing/app-store.js';
import { TEST_REFERENCE_KEYS } from '../testing/gate.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { testSourceGate } from '../testing/source-gate.js';
import { makeWebRoot } from '../testing/web-root.js';
import { contentHashOf } from './draft.js';
import { droppedFiltersOf, unmappedItemsOf } from './mapping-change.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

const mapping = parseMapping(
  fileOf(
    baseSource({
      id: 'demo',
      entities: [
        { type: 'widget', label: 'Widget', stable_id: 'widgetId', filterable: ['color', 'size'] },
        { type: 'gadget', label: 'Gadget', stable_id: 'gadgetId', pii: ['secret', 'hush'], filterable: ['secret'] },
        { type: 'part', label: 'Part', stable_id: 'partId' },
      ],
      relationships: [{ type: 'LINKS', from: 'widget', to: 'gadget' }],
    }),
  ),
  'neburyx.yaml',
);
const [demo] = mapping.sources;
if (demo === undefined) throw new Error('the fixture has a source');

const ME = LOCAL_IDENTITY.principal.id;
const ID = '0192f000-0000-7000-8000-0000000000c1';
const OLD_HASH = 'the-hash-of-the-mapping-that-was';
const NO_FILTERS: QueryContextDocument['filters'] = { entityTypes: [], relTypes: [], time: null, properties: [] };

const node = (t: string, id: string) => ({ t, id, pinned: false, hidden: false, groupId: null });
const link = (from: [string, string], to: [string, string], t = 'LINKS', extra: { id?: string; ruleId?: string } = {}) => ({ t, from: { t: from[0], id: from[1] }, to: { t: to[0], id: to[1] }, ...extra });

function documents(nodes: LayoutDocument['nodes'], edges: ReturnType<typeof link>[] = [], filters = NO_FILTERS) {
  return {
    layout: { schemaVersion: 1 as const, layout: 'force', nodes, edges: edges.map((edge) => ({ ...edge, hidden: false })), groups: [] },
    queryContext: { schemaVersion: 1 as const, loaded: { nodes: nodes.map(({ t, id }) => ({ t, id })), edges }, expansions: [], filters },
  };
}

function seeded(docs: ReturnType<typeof documents>, mappingHash: string, overrides: Partial<InvestigationRow> = {}): MemoryAppStore {
  const store = memoryAppStore();
  store.investigations.push({ id: ID, sourceId: 'demo', sourceIdentityHash: identityHashOf(demo), ownerId: ME, title: 'Widget W-1', caseRef: null, startingEntityType: 'widget', startingStableId: 'W-1', status: 'open', createdAt: '2026-11-05T10:00:00.000Z', lastEditedAt: '2026-11-05T10:00:00.000Z', version: 3, ...overrides });
  store.drafts.push({ id: '0192f000-0000-7000-8000-0000000000d1', version: 1, notes: null, ...docs, mappingHash, investigationId: ID, contentHash: contentHashOf(docs) });
  return store;
}

async function started(store: MemoryAppStore) {
  const gate = testSourceGate(mapping, { referenceKeys: TEST_REFERENCE_KEYS });
  const recorded = gate.executor.calls;
  const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store, mapping, gate: gate.gate, referenceKeys: TEST_REFERENCE_KEYS });
  return { app, recorded };
}

const read = async (store: MemoryAppStore) => {
  const { app, recorded } = await started(store);
  const response = await app.inject({ method: 'GET', url: `/v1/investigations/${ID}` });
  await app.close();
  return { response, recorded };
};

describe('the unmapped items of a draft', () => {
  const doc = documents(
    [node('widget', 'W-1'), node('gone', 'GONE-1')],
    [link(['widget', 'W-1'], ['gadget', 'GAD-1']), link(['widget', 'W-1'], ['gone', 'GONE-1']), link(['widget', 'W-1'], ['widget', 'W-2'], 'MISSING'), link(['widget', 'W-1'], ['widget', 'W-2'], 'rule-type', { ruleId: 'no-such-rule' })],
  );

  it('lists a node of a type that is not mapped, a relationship of a type that is not, one with an end of a type that is not, and a derived one whose rule is gone', () => {
    const unmapped = unmappedItemsOf(demo, doc.layout, doc.queryContext);
    expect(unmapped.nodes).toEqual([{ t: 'gone', id: 'GONE-1' }]);
    expect(unmapped.edges.map((edge) => [edge.t, edge.ruleId ?? null])).toEqual([['LINKS', null], ['MISSING', null], ['rule-type', 'no-such-rule']]);
    expect(unmapped.edges[0]?.to).toEqual({ t: 'gone', id: 'GONE-1' });
  });

  it('lists nothing when every type, relationship and end is mapped', () => {
    const covered = documents([node('widget', 'W-1'), node('gadget', 'GAD-1')], [link(['widget', 'W-1'], ['gadget', 'GAD-1'])]);
    expect(unmappedItemsOf(demo, covered.layout, covered.queryContext)).toEqual({ nodes: [], edges: [] });
  });
});

describe('the filters a mapping change drops', () => {
  const filters = (properties: string[], entityTypes: string[] = [], relTypes: string[] = []): QueryContextDocument['filters'] => ({ entityTypes, relTypes, time: null, properties: properties.map((key) => ({ key, op: 'eq', values: ['x'] })) });

  it('gives each property filter one reason: property removed, now personal, or not filterable', () => {
    expect(droppedFiltersOf(demo, filters(['color', 'ghost', 'secret', 'partId']))).toEqual([
      { name: 'ghost', reason: 'property-removed' },
      { name: 'secret', reason: 'now-personal' },
      { name: 'partId', reason: 'not-filterable' },
    ]);
  });

  it('gives a key that is personal and listed as filterable in no type only the first reason in the order', () => {
    expect(droppedFiltersOf(demo, filters(['hush']))).toEqual([{ name: 'hush', reason: 'now-personal' }]);
  });

  it('never drops a type filter, so a type that is mapped again has the state it was saved with', () => {
    expect(droppedFiltersOf(demo, filters([], ['widget', 'gone'], ['LINKS', 'GONE-LINK']))).toEqual([]);
  });
});

describe('GET /v1/investigations/{id} after the mapping changed', () => {
  it('carries no mappingChange when the hashes are equal, and still lists the unmapped items', async () => {
    const { response } = await read(seeded(documents([node('widget', 'W-1'), node('gone', 'GONE-1')]), demo.configHash));
    expect(response.statusCode).toBe(200);
    const body = investigationResponseSchema.parse(response.json());
    expect(body.mappingChange).toBeUndefined();
    expect(body.unmapped?.nodes).toEqual([{ t: 'gone', id: 'GONE-1' }]);
  });

  it('answers 200 with the dropped property filters named and removed from the returned draft, and the type filters kept as saved, when the hashes differ', async () => {
    const filters: QueryContextDocument['filters'] = { entityTypes: ['widget', 'gone'], relTypes: [], time: null, properties: [{ key: 'color', op: 'eq', values: ['red'] }, { key: 'ghost', op: 'eq', values: ['x'] }, { key: 'secret', op: 'eq', values: ['x'] }] };
    const { response } = await read(seeded(documents([node('widget', 'W-1')], [], filters), OLD_HASH));
    expect(response.statusCode).toBe(200);
    const body = investigationResponseSchema.parse(response.json());
    expect(body.mappingChange?.droppedFilters).toEqual([
      { name: 'ghost', reason: 'property-removed' },
      { name: 'secret', reason: 'now-personal' },
    ]);
    expect(body.draft.queryContext.filters).toEqual({ entityTypes: ['widget', 'gone'], relTypes: [], time: null, properties: [{ key: 'color', op: 'eq', values: ['red'] }] });
  });

  it('answers an empty list of dropped filters when everything is still supported', async () => {
    const { response } = await read(seeded(documents([node('widget', 'W-1')]), OLD_HASH));
    expect(response.statusCode).toBe(200);
    expect(investigationResponseSchema.parse(response.json()).mappingChange).toEqual({ droppedFilters: [] });
  });

  it('computes neither for a source that was removed or re-pointed', async () => {
    const { response } = await read(seeded(documents([node('widget', 'W-1'), node('gone', 'GONE-1')]), OLD_HASH, { sourceIdentityHash: 'another-database' }));
    expect(response.statusCode).toBe(200);
    const body = investigationResponseSchema.parse(response.json());
    expect(body.unmapped).toBeUndefined();
    expect(body.mappingChange).toBeUndefined();
  });

  it('reads nothing from the source and shows no stored ID or filter value in a name or a reason', async () => {
    const filters: QueryContextDocument['filters'] = { entityTypes: [], relTypes: [], time: null, properties: [{ key: 'ghost', op: 'eq', values: ['SECRET-VALUE'] }] };
    const { response, recorded } = await read(seeded(documents([node('widget', 'W-1'), node('gone', 'GONE-1')], [], filters), OLD_HASH));
    expect(recorded).toHaveLength(0);
    const { mappingChange } = investigationResponseSchema.parse(response.json());
    expect(JSON.stringify(mappingChange)).not.toContain('SECRET-VALUE');
    expect(JSON.stringify(mappingChange)).not.toContain('GONE-1');
  });
});

describe('PUT /v1/investigations/{id}/draft after the mapping changed', () => {
  const put = async (store: MemoryAppStore, docs: ReturnType<typeof documents>, version = '"1"') => {
    const { app } = await started(store);
    const response = await app.inject({ method: 'PUT', url: `/v1/investigations/${ID}/draft`, headers: { 'if-match': version }, payload: { ...docs, notes: null } });
    await app.close();
    return response;
  };

  it('writes the current mapping hash when the content is the one stored: the version moves and the last edit does not', async () => {
    const docs = documents([node('widget', 'W-1')]);
    const store = seeded(docs, OLD_HASH);
    const response = await put(store, docs);
    expect(response.statusCode).toBe(200);
    expect(response.headers['etag']).toBe('"2"');
    expect(store.drafts[0]?.mappingHash).toBe(demo.configHash);
    expect(store.investigations[0]?.lastEditedAt).toBe('2026-11-05T10:00:00.000Z');
  });

  it('writes the current mapping hash with changed content, and moves the last edit', async () => {
    const store = seeded(documents([node('widget', 'W-1')]), OLD_HASH);
    const response = await put(store, documents([node('widget', 'W-1'), node('widget', 'W-2')]));
    expect(response.statusCode).toBe(200);
    expect(store.drafts[0]?.mappingHash).toBe(demo.configHash);
    expect(store.investigations[0]?.lastEditedAt).not.toBe('2026-11-05T10:00:00.000Z');
  });

  it('moves nothing when the hash and the content are equal', async () => {
    const docs = documents([node('widget', 'W-1')]);
    const store = seeded(docs, demo.configHash);
    const response = await put(store, docs);
    expect(response.statusCode).toBe(200);
    expect(response.headers['etag']).toBe('"1"');
  });

  it('refuses a stale version and leaves the stored hash as it was', async () => {
    const docs = documents([node('widget', 'W-1')]);
    const store = seeded(docs, OLD_HASH);
    const response = await put(store, docs, '"9"');
    expect(response.statusCode).toBe(409);
    expect(store.drafts[0]?.mappingHash).toBe(OLD_HASH);
  });

  it('answers a read after the write with no mappingChange and the unmapped items still listed', async () => {
    const docs = documents([node('widget', 'W-1'), node('gone', 'GONE-1')]);
    const store = seeded(docs, OLD_HASH);
    expect((await put(store, docs)).statusCode).toBe(200);
    const body = investigationResponseSchema.parse((await read(store)).response.json());
    expect(body.mappingChange).toBeUndefined();
    expect(body.unmapped?.nodes).toEqual([{ t: 'gone', id: 'GONE-1' }]);
  });
});

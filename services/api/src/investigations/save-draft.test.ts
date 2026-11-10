import { rmSync } from 'node:fs';
import { draftWriteResponseSchema, MAX_DRAFT_DOCUMENT_BYTES, type LayoutDocument, type QueryContextDocument } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import type { InvestigationRow } from '../db/investigations-repository.js';
import { createLogger } from '../logger.js';
import { parseMapping } from '../mapping/load.js';
import { decodeStored } from '../reference/stored-text.js';
import { makeToken } from '../reference/token.js';
import { identityHashOf } from '../registry/identity-hash.js';
import { LOCAL_IDENTITY, memoryAppStore, type MemoryAppStore } from '../testing/app-store.js';
import { TEST_REFERENCE_KEYS } from '../testing/gate.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { testSourceGate } from '../testing/source-gate.js';
import { makeWebRoot } from '../testing/web-root.js';
import { contentHashOf, initialDraftDocuments } from './draft.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

const mapping = parseMapping(
  fileOf(
    baseSource({
      id: 'demo',
      entities: [
        { type: 'widget', label: 'Widget', stable_id: 'widgetId', pii: ['secret'] },
        { type: 'phone', label: 'Handle', stable_id: 'phoneNumber', pii: [{ property: 'phoneNumber', class: 'phone' }] },
      ],
      relationships: [{ type: 'LINKS', from: 'widget', to: 'phone' }],
    }),
  ),
  'neburyx.yaml',
);
const [demo] = mapping.sources;
if (demo === undefined) throw new Error('the fixture has a source');

const ME = LOCAL_IDENTITY.principal.id;
const OTHER = '0192f000-0000-7000-8000-0000000000aa';
const ID = '0192f000-0000-7000-8000-0000000000c1';
const VALUE = '+1-212-555-0100';
const phoneToken = makeToken(TEST_REFERENCE_KEYS, { sourceId: 'demo', entityType: 'phone' }, VALUE);

function row(overrides: Partial<InvestigationRow> = {}): InvestigationRow {
  return { id: ID, sourceId: 'demo', sourceIdentityHash: identityHashOf(demo), ownerId: ME, title: 'Widget W-1', caseRef: null, startingEntityType: 'widget', startingStableId: 'W-1', status: 'open', createdAt: '2026-11-05T10:00:00.000Z', lastEditedAt: '2026-11-05T10:00:00.000Z', closedAt: null, archivedAt: null, version: 3, ...overrides };
}

function seeded(overrides: Partial<InvestigationRow> = {}): MemoryAppStore {
  const store = memoryAppStore();
  const documents = initialDraftDocuments({ entityType: 'widget', stableId: 'W-1' });
  store.investigations.push(row(overrides));
  store.drafts.push({ id: '0192f000-0000-7000-8000-0000000000d1', version: 1, notes: null, layout: documents.layout, queryContext: documents.queryContext, investigationId: ID, contentHash: contentHashOf(documents) });
  return store;
}

async function started(store: MemoryAppStore) {
  return buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store, mapping, gate: testSourceGate(mapping, { referenceKeys: TEST_REFERENCE_KEYS }).gate, referenceKeys: TEST_REFERENCE_KEYS });
}

const node = (t: string, id: string) => ({ t, id, pinned: false, hidden: false, groupId: null });
const documents = (nodes: LayoutDocument['nodes'], edges: LayoutDocument['edges'] = [], filters: QueryContextDocument['filters'] = { entityTypes: [], relTypes: [], time: null, properties: [] }, notes: string | null = null) => ({
  notes,
  layout: { schemaVersion: 1 as const, layout: 'force', nodes, edges, groups: [] },
  queryContext: { schemaVersion: 1 as const, loaded: { nodes: nodes.map(({ t, id }) => ({ t, id })), edges: edges.map(({ hidden: _hidden, ...edge }) => edge) }, expansions: [], filters },
});

type App = Awaited<ReturnType<typeof started>>;
const put = (app: App, payload: unknown, headers: Record<string, string> = { 'if-match': '"1"' }, id = ID) => app.inject({ method: 'PUT', url: `/v1/investigations/${id}/draft`, headers, payload: payload as object });

describe('PUT /v1/investigations/{id}/draft', () => {
  it('stores the draft, raises its version, answers the new ETag and version, and stores an ID PostgreSQL cannot hold in its encoded form', async () => {
    const store = seeded();
    const app = await started(store);
    const response = await put(app, documents([node('widget', 'W-1'), node('widget', 'A\u0000B')]));
    expect(response.statusCode).toBe(200);
    expect(response.headers['etag']).toBe('"2"');
    expect(draftWriteResponseSchema.parse(response.json())).toEqual({ version: 2, save: { state: 'unsaved', savedAt: null }, notes: null });
    const stored = store.drafts[0];
    expect(stored?.version).toBe(2);
    const ids = (stored?.layout as LayoutDocument).nodes.map((entry) => entry.id);
    expect(ids[1]).not.toContain('\u0000');
    expect(decodeStored(ids[1] ?? '')).toBe('A\u0000B');
    await app.close();
  });

  it('refuses a stale version with CONFLICTED_VIEW_VERSION and leaves the stored draft as it was', async () => {
    const store = seeded();
    const app = await started(store);
    const before = JSON.stringify(store.drafts);
    const response = await put(app, documents([node('widget', 'W-2')]), { 'if-match': '"7"' });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'CONFLICTED_VIEW_VERSION' } });
    expect(JSON.stringify(store.drafts)).toBe(before);
    await app.close();
  });

  it.each([
    ['no If-Match', {}],
    ['an unquoted version', { 'if-match': '1' }],
    ['a weak tag', { 'if-match': 'W/"1"' }],
    ['a version of zero', { 'if-match': '"0"' }],
    ['several tags', { 'if-match': '"1", "2"' }],
  ])('refuses %s with INVALID_REQUEST and stores nothing', async (_name, headers) => {
    const store = seeded();
    const app = await started(store);
    const before = JSON.stringify(store.drafts);
    const response = await put(app, documents([node('widget', 'W-2')]), headers);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
    expect(JSON.stringify(store.drafts)).toBe(before);
    await app.close();
  });

  it('refuses a document over the limit, and a body that is not a draft, and stores nothing', async () => {
    const store = seeded();
    const app = await started(store);
    const before = JSON.stringify(store.drafts);
    const big = documents([node('widget', 'x'.repeat(MAX_DRAFT_DOCUMENT_BYTES))]);
    expect((await put(app, big)).statusCode).toBe(400);
    expect((await put(app, { layout: 1 })).statusCode).toBe(400);
    expect((await put(app, { ...documents([node('widget', 'W-2')]), extra: 1 })).statusCode).toBe(400);
    expect(JSON.stringify(store.drafts)).toBe(before);
    await app.close();
  });

  it('refuses a reference of a keyed type that is not a token of this deployment, and accepts the token', async () => {
    const store = seeded();
    const app = await started(store);
    const before = JSON.stringify(store.drafts);
    const raw = await put(app, documents([node('phone', VALUE)]));
    expect(raw.statusCode).toBe(400);
    expect(raw.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
    expect(JSON.stringify(store.drafts)).toBe(before);
    const edge = { t: 'LINKS', from: { t: 'widget', id: 'W-1' }, to: { t: 'phone', id: phoneToken }, hidden: false };
    const accepted = await put(app, documents([node('widget', 'W-1'), node('phone', phoneToken)], [edge]));
    expect(accepted.statusCode).toBe(200);
    expect(JSON.stringify(store.drafts)).not.toContain(VALUE);
    await app.close();
  });

  it('answers 200 with the same version and moves nothing when the content is the one stored, and moves last_edited_at when it is not', async () => {
    const store = seeded();
    const app = await started(store);
    const same = { ...initialDraftDocuments({ entityType: 'widget', stableId: 'W-1' }), notes: null };
    const unchanged = await put(app, same);
    expect(unchanged.statusCode).toBe(200);
    expect(unchanged.json()).toMatchObject({ version: 1 });
    expect(store.drafts[0]?.version).toBe(1);
    expect(store.investigations[0]?.lastEditedAt).toBe('2026-11-05T10:00:00.000Z');
    const changed = await put(app, documents([node('widget', 'W-1'), node('widget', 'W-2')]));
    expect(changed.json()).toMatchObject({ version: 2 });
    expect(store.investigations[0]?.lastEditedAt).not.toBe('2026-11-05T10:00:00.000Z');
    await app.close();
  });

  it('drops a filter on a personal-data property before it is stored, and keeps the others', async () => {
    const store = seeded();
    const app = await started(store);
    const filters = { entityTypes: [], relTypes: [], time: null, properties: [{ key: 'secret', op: 'eq', values: ['SECRET-1'] }, { key: 'widgetId', op: 'eq', values: ['W-1'] }] };
    const response = await put(app, documents([node('widget', 'W-1')], [], filters));
    expect(response.statusCode).toBe(200);
    const stored = store.drafts[0]?.queryContext as QueryContextDocument;
    expect(stored.filters.properties).toEqual([{ key: 'widgetId', op: 'eq', values: ['W-1'] }]);
    expect(JSON.stringify(store.drafts)).not.toContain('SECRET-1');
    await app.close();
  });

  it.each([
    ['another user’s investigation', seeded({ ownerId: OTHER }), ID],
    ['an unknown investigation', seeded(), '0192f000-0000-7000-8000-0000000000ff'],
    ['an ID that is not a UUID', seeded(), 'not-a-uuid'],
  ])('answers NOT_FOUND for %s and stores nothing', async (_name, store, id) => {
    const app = await started(store);
    const before = JSON.stringify(store.drafts);
    const response = await put(app, documents([node('widget', 'W-2')]), { 'if-match': '"1"' }, id);
    expect(response.statusCode).toBe(404);
    expect(JSON.stringify(store.drafts)).toBe(before);
    await app.close();
  });

  it('refuses a write while the source of the investigation is not the one it was opened on', async () => {
    const store = seeded({ sourceIdentityHash: 'another' });
    const app = await started(store);
    const response = await put(app, documents([node('widget', 'W-2')]));
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'CONFLICT' } });
    await app.close();
  });

  it('stores the note, answers it, and treats a changed note as changed content', async () => {
    const store = seeded();
    const app = await started(store);
    const base = documents([node('widget', 'W-1')]);
    const noted = await put(app, { ...initialDraftDocuments({ entityType: 'widget', stableId: 'W-1' }), notes: 'looks like a mule' });
    expect(noted.statusCode).toBe(200);
    expect(noted.json()).toMatchObject({ version: 2, notes: 'looks like a mule' });
    expect(store.drafts[0]?.notes).toBe('looks like a mule');
    const same = await put(app, { ...initialDraftDocuments({ entityType: 'widget', stableId: 'W-1' }), notes: 'looks like a mule' }, { 'if-match': '"2"' });
    expect(same.json()).toMatchObject({ version: 2, notes: 'looks like a mule' });
    expect(base.notes).toBeNull();
    await app.close();
  });

  it.each([
    ['no notes field', (payload: Record<string, unknown>) => ({ layout: payload['layout'], queryContext: payload['queryContext'] })],
    ['a NUL', (payload: Record<string, unknown>) => ({ ...payload, notes: 'a\u0000b' })],
    ['an unpaired surrogate', (payload: Record<string, unknown>) => ({ ...payload, notes: 'a\ud800b' })],
    ['more than 10,000 characters', (payload: Record<string, unknown>) => ({ ...payload, notes: 'n'.repeat(10_001) })],
    ['a note that is not text', (payload: Record<string, unknown>) => ({ ...payload, notes: 7 })],
  ])('refuses %s with INVALID_REQUEST and changes nothing stored', async (_name, shape) => {
    const store = seeded();
    const app = await started(store);
    const before = JSON.stringify(store.drafts);
    const response = await put(app, shape(documents([node('widget', 'W-2')])));
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
    expect(JSON.stringify(store.drafts)).toBe(before);
    await app.close();
  });

  it('accepts a note of exactly 10,000 characters', async () => {
    const app = await started(seeded());
    expect((await put(app, documents([node('widget', 'W-2')], [], undefined, 'n'.repeat(10_000)))).statusCode).toBe(200);
    await app.close();
  });
});

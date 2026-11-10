import { rmSync } from 'node:fs';
import { renameResponseSchema, statusChangeResponseSchema, type LayoutDocument } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import type { InvestigationRow } from '../db/investigations-repository.js';
import { createLogger } from '../logger.js';
import { parseMapping } from '../mapping/load.js';
import { makeToken } from '../reference/token.js';
import { identityHashOf } from '../registry/identity-hash.js';
import type { AuditEvent, AuditSink } from '../seams/seams.js';
import { communitySeams } from '../seams/community-seams.js';
import { LOCAL_IDENTITY, memoryAppStore, type MemoryAppStore } from '../testing/app-store.js';
import { TEST_REFERENCE_KEYS } from '../testing/gate.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { testSourceGate } from '../testing/source-gate.js';
import { makeWebRoot } from '../testing/web-root.js';
import { contentHashOf, initialDraftDocuments } from './draft.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

const mapping = parseMapping(fileOf(baseSource({ id: 'demo', entities: [{ type: 'widget', label: 'Widget', stable_id: 'widgetId' }], relationships: [] })), 'neburyx.yaml');
const [demo] = mapping.sources;
if (demo === undefined) throw new Error('the fixture has a source');

const ME = LOCAL_IDENTITY.principal.id;
const OTHER = '0192f000-0000-7000-8000-0000000000aa';
const ID = '0192f000-0000-7000-8000-0000000000c1';
const READ_ONLY_MESSAGE = 'This investigation is closed or archived. Reopen it to make changes.';

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

interface Rig {
  readonly app: Awaited<ReturnType<typeof buildApp>>;
  readonly store: MemoryAppStore;
  readonly audited: AuditEvent[];
}

async function started(store: MemoryAppStore, audit?: AuditSink): Promise<Rig> {
  const audited: AuditEvent[] = [];
  const sink: AuditSink = audit ?? { record: (event) => { audited.push(event); return Promise.resolve(); } };
  const seams = { ...communitySeams(), audit: sink };
  const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store, mapping, gate: testSourceGate(mapping, { referenceKeys: TEST_REFERENCE_KEYS }).gate, referenceKeys: TEST_REFERENCE_KEYS, seams });
  return { app, store, audited };
}

const changeStatus = (rig: Rig, payload: unknown, id = ID) => rig.app.inject({ method: 'POST', url: `/v1/investigations/${id}/status`, payload: payload as object });
const rename = (rig: Rig, payload: unknown, id = ID) => rig.app.inject({ method: 'PUT', url: `/v1/investigations/${id}`, payload: payload as object });
const writeDraft = (rig: Rig, headers: Record<string, string> = { 'if-match': '"1"' }, id = ID) =>
  rig.app.inject({ method: 'PUT', url: `/v1/investigations/${id}/draft`, headers, payload: { notes: null, layout: { schemaVersion: 1, layout: 'force', nodes: [{ t: 'widget', id: 'W-2', pinned: false, hidden: false, groupId: null }], edges: [], groups: [] } satisfies LayoutDocument, queryContext: { schemaVersion: 1, loaded: { nodes: [{ t: 'widget', id: 'W-2' }], edges: [] }, expansions: [], filters: { entityTypes: [], relTypes: [], time: null, properties: [] } } } });
const stored = (store: MemoryAppStore) => store.investigations[0];

describe('POST /v1/investigations/{id}/status', () => {
  it.each([
    ['a status that is not known', { status: 'deleted', expectedVersion: 3 }],
    ['no expectedVersion', { status: 'closed' }],
    ['another field', { status: 'closed', expectedVersion: 3, title: 'x' }],
    ['an expectedVersion of zero', { status: 'closed', expectedVersion: 0 }],
  ])('refuses %s with INVALID_REQUEST and writes nothing', async (_name, payload) => {
    const rig = await started(seeded());
    const before = JSON.stringify(rig.store.investigations);
    const response = await changeStatus(rig, payload);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
    expect(JSON.stringify(rig.store.investigations)).toBe(before);
    expect(rig.audited).toEqual([]);
    await rig.app.close();
  });

  it('refuses a stale expectedVersion with CONFLICT and no reason, and writes nothing', async () => {
    const rig = await started(seeded());
    const before = JSON.stringify(rig.store.investigations);
    const response = await changeStatus(rig, { status: 'closed', expectedVersion: 2 });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: expect.objectContaining({ code: 'CONFLICT', message: 'This item was changed elsewhere. Reload to continue.' }) });
    expect(response.json().error.details).toBeUndefined();
    expect(JSON.stringify(rig.store.investigations)).toBe(before);
    expect(rig.audited).toEqual([]);
    await rig.app.close();
  });

  it('refuses archived to closed with the reason status-change-not-allowed and writes nothing', async () => {
    const rig = await started(seeded({ status: 'archived', archivedAt: '2026-11-06T10:00:00.000Z' }));
    const before = JSON.stringify(rig.store.investigations);
    const response = await changeStatus(rig, { status: 'closed', expectedVersion: 3 });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'CONFLICT', message: 'An archived investigation must be reopened before it can be closed.', details: { reason: 'status-change-not-allowed' } } });
    expect(JSON.stringify(rig.store.investigations)).toBe(before);
    expect(rig.audited).toEqual([]);
    await rig.app.close();
  });

  it.each([
    ['another user', { ownerId: OTHER }, ID],
    ['an unknown ID', {}, '0192f000-0000-7000-8000-0000000000ff'],
    ['an ID that is not a UUID', {}, 'not-a-uuid'],
  ])('answers NOT_FOUND for %s and writes nothing', async (_name, overrides, id) => {
    const rig = await started(seeded(overrides));
    const before = JSON.stringify(rig.store.investigations);
    const response = await changeStatus(rig, { status: 'closed', expectedVersion: 3 }, id);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    expect(JSON.stringify(rig.store.investigations)).toBe(before);
    expect(rig.audited).toEqual([]);
    await rig.app.close();
  });

  it('closes an open investigation: the status, closedAt, the version and the ETag move, last_edited_at does not, and the close is audited once', async () => {
    const rig = await started(seeded());
    const response = await changeStatus(rig, { status: 'closed', expectedVersion: 3 });
    expect(response.statusCode).toBe(200);
    expect(response.headers['etag']).toBe('"4"');
    const { investigation } = statusChangeResponseSchema.parse(response.json());
    expect(investigation).toMatchObject({ status: 'closed', version: 4, archivedAt: null, lastEditedAt: '2026-11-05T10:00:00.000Z' });
    expect(investigation.closedAt).not.toBeNull();
    expect(stored(rig.store)).toMatchObject({ status: 'closed', version: 4, lastEditedAt: '2026-11-05T10:00:00.000Z' });
    expect(rig.audited).toMatchObject([{ action: 'investigation.close', result: 'success', actorId: ME, sourceId: 'demo' }]);
    await rig.app.close();
  });

  it('reopens a closed investigation and clears both times', async () => {
    const rig = await started(seeded({ status: 'closed', closedAt: '2026-11-06T10:00:00.000Z' }));
    const response = await changeStatus(rig, { status: 'open', expectedVersion: 3 });
    expect(response.statusCode).toBe(200);
    expect(statusChangeResponseSchema.parse(response.json()).investigation).toMatchObject({ status: 'open', closedAt: null, archivedAt: null, version: 4 });
    expect(rig.audited).toMatchObject([{ action: 'investigation.reopen' }]);
    await rig.app.close();
  });

  it('archives an open investigation, and a closed one while keeping its closedAt', async () => {
    const fromOpen = await started(seeded());
    const opened = statusChangeResponseSchema.parse((await changeStatus(fromOpen, { status: 'archived', expectedVersion: 3 })).json());
    expect(opened.investigation).toMatchObject({ status: 'archived', closedAt: null, version: 4 });
    expect(opened.investigation.archivedAt).not.toBeNull();
    expect(fromOpen.audited).toMatchObject([{ action: 'investigation.archive' }]);
    await fromOpen.app.close();

    const fromClosed = await started(seeded({ status: 'closed', closedAt: '2026-11-06T10:00:00.000Z' }));
    const closed = statusChangeResponseSchema.parse((await changeStatus(fromClosed, { status: 'archived', expectedVersion: 3 })).json());
    expect(closed.investigation).toMatchObject({ status: 'archived', closedAt: '2026-11-06T10:00:00.000Z', version: 4 });
    expect(closed.investigation.archivedAt).not.toBeNull();
    await fromClosed.app.close();
  });

  it('reopens an archived investigation and clears both times', async () => {
    const rig = await started(seeded({ status: 'archived', closedAt: '2026-11-06T10:00:00.000Z', archivedAt: '2026-11-07T10:00:00.000Z' }));
    const response = await changeStatus(rig, { status: 'open', expectedVersion: 3 });
    expect(statusChangeResponseSchema.parse(response.json()).investigation).toMatchObject({ status: 'open', closedAt: null, archivedAt: null, version: 4 });
    expect(rig.audited).toMatchObject([{ action: 'investigation.reopen' }]);
    await rig.app.close();
  });

  it('answers 200 with the same version, writes nothing and does not audit when the status is the one it has', async () => {
    const rig = await started(seeded({ status: 'closed', closedAt: '2026-11-06T10:00:00.000Z' }));
    const before = JSON.stringify(rig.store.investigations);
    const response = await changeStatus(rig, { status: 'closed', expectedVersion: 3 });
    expect(response.statusCode).toBe(200);
    expect(response.headers['etag']).toBe('"3"');
    expect(statusChangeResponseSchema.parse(response.json()).investigation).toMatchObject({ status: 'closed', version: 3, closedAt: '2026-11-06T10:00:00.000Z' });
    expect(JSON.stringify(rig.store.investigations)).toBe(before);
    expect(rig.audited).toEqual([]);
    await rig.app.close();
  });

  it('answers INTERNAL_ERROR and writes nothing when the audit sink rejects', async () => {
    const rig = await started(seeded(), { record: () => Promise.reject(new Error('sink down')) });
    const before = JSON.stringify(rig.store.investigations);
    const response = await changeStatus(rig, { status: 'closed', expectedVersion: 3 });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
    expect(JSON.stringify(response.json())).not.toContain('sink down');
    expect(JSON.stringify(rig.store.investigations)).toBe(before);
    await rig.app.close();
  });
});

describe('PUT /v1/investigations/{id}', () => {
  it.each([
    ['an empty title', { title: '', expectedVersion: 3 }],
    ['a title of only whitespace', { title: '   ', expectedVersion: 3 }],
    ['a title of 201 code points', { title: 'a'.repeat(201), expectedVersion: 3 }],
    ['a title with a NUL', { title: 'a\u0000b', expectedVersion: 3 }],
    ['a title with an unpaired surrogate', { title: 'a\ud800b', expectedVersion: 3 }],
    ['no expectedVersion', { title: 'Mule ring' }],
    ['another field', { title: 'Mule ring', expectedVersion: 3, status: 'closed' }],
  ])('refuses %s with INVALID_REQUEST and stores nothing', async (_name, payload) => {
    const rig = await started(seeded());
    const before = JSON.stringify(rig.store.investigations);
    const response = await rename(rig, payload);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
    expect(JSON.stringify(rig.store.investigations)).toBe(before);
    await rig.app.close();
  });

  it('refuses a stale expectedVersion with CONFLICT and stores nothing', async () => {
    const rig = await started(seeded());
    const before = JSON.stringify(rig.store.investigations);
    const response = await rename(rig, { title: 'Mule ring', expectedVersion: 2 });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.details).toBeUndefined();
    expect(response.json()).toMatchObject({ error: { code: 'CONFLICT' } });
    expect(JSON.stringify(rig.store.investigations)).toBe(before);
    await rig.app.close();
  });

  it.each([
    ['another user', { ownerId: OTHER }, ID],
    ['an unknown ID', {}, '0192f000-0000-7000-8000-0000000000ff'],
  ])('answers NOT_FOUND for %s', async (_name, overrides, id) => {
    const rig = await started(seeded(overrides));
    const response = await rename(rig, { title: 'Mule ring', expectedVersion: 3 }, id);
    expect(response.statusCode).toBe(404);
    expect(stored(rig.store)?.title).toBe('Widget W-1');
    await rig.app.close();
  });

  it('stores the title as typed, raises the version, answers the ETag and leaves last_edited_at', async () => {
    const rig = await started(seeded());
    const typed = '  Café \u{1F600} ring  ';
    const response = await rename(rig, { title: typed, expectedVersion: 3 });
    expect(response.statusCode).toBe(200);
    expect(response.headers['etag']).toBe('"4"');
    expect(renameResponseSchema.parse(response.json()).investigation).toMatchObject({ title: typed, version: 4, lastEditedAt: '2026-11-05T10:00:00.000Z' });
    expect(stored(rig.store)).toMatchObject({ title: typed, version: 4, lastEditedAt: '2026-11-05T10:00:00.000Z' });
    await rig.app.close();
  });

  it('answers 200 with the same version and writes nothing for the title it already has', async () => {
    const rig = await started(seeded());
    const before = JSON.stringify(rig.store.investigations);
    const response = await rename(rig, { title: 'Widget W-1', expectedVersion: 3 });
    expect(response.statusCode).toBe(200);
    expect(response.headers['etag']).toBe('"3"');
    expect(JSON.stringify(rig.store.investigations)).toBe(before);
    await rig.app.close();
  });

  it('stores 200 code points of accents and emoji and reads them back equal', async () => {
    const rig = await started(seeded());
    const typed = `é\u{1F600}`.repeat(100);
    expect((await rename(rig, { title: typed, expectedVersion: 3 })).statusCode).toBe(200);
    const read = await rig.app.inject({ method: 'GET', url: `/v1/investigations/${ID}` });
    expect(read.json().investigation.title).toBe(typed);
    await rig.app.close();
  });
});

describe('a closed or archived investigation', () => {
  const states = [
    ['closed', { status: 'closed' as const, closedAt: '2026-11-06T10:00:00.000Z' }],
    ['archived', { status: 'archived' as const, archivedAt: '2026-11-06T10:00:00.000Z' }],
  ] as const;

  it.each(states)('refuses a draft write when %s with the read-only CONFLICT, and keeps the draft, its version and last_edited_at', async (status, overrides) => {
    const rig = await started(seeded(overrides));
    const before = JSON.stringify([rig.store.drafts, rig.store.investigations]);
    const response = await writeDraft(rig);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: { code: 'CONFLICT', message: READ_ONLY_MESSAGE, retryable: false, traceId: expect.any(String), details: { reason: 'investigation-read-only', status } } });
    expect(JSON.stringify([rig.store.drafts, rig.store.investigations])).toBe(before);
    await rig.app.close();
  });

  it.each(states)('refuses a rename when %s with the same CONFLICT and keeps the title', async (status, overrides) => {
    const rig = await started(seeded(overrides));
    const response = await rename(rig, { title: 'Mule ring', expectedVersion: 3 });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'CONFLICT', message: READ_ONLY_MESSAGE, details: { reason: 'investigation-read-only', status } } });
    expect(stored(rig.store)?.title).toBe('Widget W-1');
    await rig.app.close();
  });

  it('answers the read-only CONFLICT before the version guard of a draft write and of a rename', async () => {
    const rig = await started(seeded({ status: 'closed', closedAt: '2026-11-06T10:00:00.000Z' }));
    const draft = await writeDraft(rig, { 'if-match': '"9"' });
    expect(draft.json()).toMatchObject({ error: { code: 'CONFLICT', details: { reason: 'investigation-read-only', status: 'closed' } } });
    const renamed = await rename(rig, { title: 'Mule ring', expectedVersion: 99 });
    expect(renamed.json()).toMatchObject({ error: { code: 'CONFLICT', details: { reason: 'investigation-read-only', status: 'closed' } } });
    await rig.app.close();
  });

  it('answers NOT_FOUND, not the read-only CONFLICT, for another user\'s closed investigation', async () => {
    const rig = await started(seeded({ ownerId: OTHER, status: 'closed' }));
    expect((await writeDraft(rig)).statusCode).toBe(404);
    expect((await rename(rig, { title: 'Mule ring', expectedVersion: 3 })).statusCode).toBe(404);
    await rig.app.close();
  });

  it('is still read by GET, can be reopened, and then takes a draft write with the draft\'s current If-Match', async () => {
    const rig = await started(seeded({ status: 'closed', closedAt: '2026-11-06T10:00:00.000Z' }));
    const read = await rig.app.inject({ method: 'GET', url: `/v1/investigations/${ID}` });
    expect(read.statusCode).toBe(200);
    expect(read.json().investigation.status).toBe('closed');
    expect((await changeStatus(rig, { status: 'open', expectedVersion: 3 })).statusCode).toBe(200);
    const written = await writeDraft(rig, { 'if-match': `"${rig.store.drafts[0]?.version}"` });
    expect(written.statusCode).toBe(200);
    expect(rig.store.drafts[0]?.version).toBe(2);
    await rig.app.close();
  });
});

describe('a title typed in the form of a generated title', () => {
  const VALUE = '+1-212-555-0100';
  const keyed = parseMapping(fileOf(baseSource({ id: 'demo', entities: [{ type: 'phone', label: 'Handle', stable_id: 'phoneNumber', pii: [{ property: 'phoneNumber', class: 'phone' }] }, { type: 'person', label: 'Person', stable_id: 'personId' }], relationships: [{ type: 'HAS_PHONE', from: 'person', to: 'phone' }] })), 'neburyx.yaml');

  it('is shown as the existing stored-title rule shows it, and a title the person wrote stays', async () => {
    const [source] = keyed.sources;
    if (source === undefined) throw new Error('the fixture has a source');
    const store = memoryAppStore();
    const token = makeToken(TEST_REFERENCE_KEYS, { sourceId: 'demo', entityType: 'phone' }, VALUE);
    store.investigations.push(row({ sourceIdentityHash: identityHashOf(source), startingEntityType: 'phone', startingStableId: token, title: 'Handle' }));
    const initial = initialDraftDocuments({ entityType: 'phone', stableId: token });
    store.drafts.push({ id: '0192f000-0000-7000-8000-0000000000d1', version: 1, notes: null, layout: initial.layout, queryContext: initial.queryContext, investigationId: ID, contentHash: contentHashOf(initial) });
    const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store, mapping: keyed, gate: testSourceGate(keyed, { referenceKeys: TEST_REFERENCE_KEYS }).gate, referenceKeys: TEST_REFERENCE_KEYS });
    const generated = await app.inject({ method: 'PUT', url: `/v1/investigations/${ID}`, payload: { title: `Handle ${VALUE}`, expectedVersion: 3 } });
    expect(generated.statusCode).toBe(200);
    expect(generated.json().investigation.title).toBe('Handle');
    const written = await app.inject({ method: 'PUT', url: `/v1/investigations/${ID}`, payload: { title: 'My own title', expectedVersion: 4 } });
    expect(written.json().investigation.title).toBe('My own title');
    await app.close();
  });
});

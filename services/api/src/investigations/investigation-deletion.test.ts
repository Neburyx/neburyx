import { rmSync } from 'node:fs';
import { deleteInvestigationResponseSchema } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import type { InvestigationRow } from '../db/investigations-repository.js';
import { createLogger } from '../logger.js';
import { parseMapping } from '../mapping/load.js';
import { identityHashOf } from '../registry/identity-hash.js';
import type { AuditEvent, AuditSink } from '../seams/seams.js';
import { communitySeams } from '../seams/community-seams.js';
import { LOCAL_IDENTITY, memoryAppStore, memoryStoreWith, type MemoryAppStore } from '../testing/app-store.js';
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
  store.drafts.push({ id: '0192f000-0000-7000-8000-0000000000d1', version: 1, notes: null, basedOnViewId: null, layout: documents.layout, queryContext: documents.queryContext, mappingHash: 'the-mapping-that-was', investigationId: ID, contentHash: contentHashOf(documents) });
  return store;
}

interface Rig {
  readonly app: Awaited<ReturnType<typeof buildApp>>;
  readonly store: MemoryAppStore;
  readonly audited: AuditEvent[];
}

async function started(store: MemoryAppStore, audit?: AuditSink, appMapping = mapping): Promise<Rig> {
  const audited: AuditEvent[] = [];
  const sink: AuditSink = audit ?? { record: (event) => { audited.push(event); return Promise.resolve(); } };
  const seams = { ...communitySeams(), audit: sink };
  const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store, mapping: appMapping, gate: testSourceGate(appMapping, { referenceKeys: TEST_REFERENCE_KEYS }).gate, referenceKeys: TEST_REFERENCE_KEYS, seams });
  return { app, store, audited };
}


const remove = (rig: Rig, headers: Record<string, string> = { 'if-match': '"3"' }, id = ID, extra: Record<string, unknown> = {}) => rig.app.inject({ method: 'DELETE', url: `/v1/investigations/${id}`, headers, ...extra });
const restore = (rig: Rig, payload: unknown, id = ID) => rig.app.inject({ method: 'POST', url: `/v1/investigations/${id}/restore`, payload: payload as object });
const list = (rig: Rig, query = '') => rig.app.inject({ method: 'GET', url: `/v1/investigations${query}` });
const first = (store: MemoryAppStore): InvestigationRow => {
  const [held] = store.investigations;
  if (held === undefined) throw new Error('the fixture has an investigation');
  return held;
};

describe('DELETE /v1/investigations/{id}', () => {
  it.each([
    ['no If-Match', {}],
    ['an If-Match of *', { 'if-match': '*' }],
    ['a weak tag', { 'if-match': 'W/"3"' }],
    ['a tag that is not a number', { 'if-match': '"three"' }],
    ['a tag of zero', { 'if-match': '"0"' }],
    ['a number without quotes', { 'if-match': '3' }],
  ])('refuses %s with INVALID_REQUEST and deletes nothing', async (_name, headers) => {
    const rig = await started(seeded());
    const before = JSON.stringify(rig.store.investigations);
    const response = await remove(rig, headers);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
    expect(JSON.stringify(rig.store.investigations)).toBe(before);
    expect((await list(rig)).json().items).toHaveLength(1);
    await rig.app.close();
  });

  it('refuses a body with INVALID_REQUEST', async () => {
    const rig = await started(seeded());
    const response = await remove(rig, { 'if-match': '"3"', 'content-type': 'application/json' }, ID, { payload: { note: 'x' } });
    expect(response.statusCode).toBe(400);
    expect((await list(rig)).json().items).toHaveLength(1);
    await rig.app.close();
  });

  it('refuses a stale If-Match with CONFLICT and deletes nothing', async () => {
    const rig = await started(seeded());
    const response = await remove(rig, { 'if-match': '"2"' });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'CONFLICT' } });
    expect((await list(rig)).json().items).toHaveLength(1);
    expect(rig.audited).toEqual([]);
    await rig.app.close();
  });

  it.each([
    ['another user', { ownerId: OTHER }, ID],
    ['an unknown ID', {}, '0192f000-0000-7000-8000-0000000000ff'],
    ['an ID that is not a UUID', {}, 'not-a-uuid'],
  ])('answers NOT_FOUND for %s', async (_name, overrides, id) => {
    const rig = await started(seeded(overrides));
    const response = await remove(rig, { 'if-match': '"3"' }, id);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    expect(rig.audited).toEqual([]);
    await rig.app.close();
  });

  it('deletes an open investigation: the answer carries the new version, the dates and an ETag, and the list no longer has it', async () => {
    const rig = await started(seeded());
    const response = await remove(rig);
    expect(response.statusCode).toBe(200);
    expect(response.headers['etag']).toBe('"4"');
    const answer = deleteInvestigationResponseSchema.parse(response.json());
    expect(answer).toMatchObject({ id: ID, version: 4 });
    expect(Date.parse(answer.purgeAfter) - Date.parse(answer.deletedAt)).toBe(30 * 86_400_000);
    expect((await list(rig)).json().items).toEqual([]);
    expect((await rig.app.inject({ method: 'GET', url: `/v1/investigations/${ID}` })).statusCode).toBe(404);
    await rig.app.close();
  });

  it.each(['closed', 'archived'] as const)('deletes a %s investigation and leaves its status', async (status) => {
    const rig = await started(seeded({ status }));
    expect((await remove(rig)).statusCode).toBe(200);
    expect(first(rig.store).status).toBe(status);
    await rig.app.close();
  });

  it('answers NOT_FOUND for an investigation that is already deleted', async () => {
    const rig = await started(seeded());
    expect((await remove(rig)).statusCode).toBe(200);
    const again = await remove(rig, { 'if-match': '"4"' });
    expect(again.statusCode).toBe(404);
    await rig.app.close();
  });

  it('sets the purge date from the retention setting of the mapping', async () => {
    const retained = parseMapping(`${fileOf(baseSource({ id: 'demo', entities: [{ type: 'widget', label: 'Widget', stable_id: 'widgetId' }], relationships: [] }))}retention:\n  deleted_investigations_days: 14\n`, 'neburyx.yaml');
    const rig = await started(seeded(), undefined, retained);
    const answer = deleteInvestigationResponseSchema.parse((await remove(rig)).json());
    expect(Date.parse(answer.purgeAfter) - Date.parse(answer.deletedAt)).toBe(14 * 86_400_000);
    expect((await list(rig, '?deleted=true')).json().retention).toEqual({ deletedInvestigationsDays: 14 });
    await rig.app.close();
  });

  it('records one audit event, inside the write', async () => {
    const rig = await started(seeded());
    await remove(rig);
    expect(rig.audited).toEqual([expect.objectContaining({ action: 'investigation.delete', result: 'success', sourceId: 'demo', actorId: ME })]);
    await rig.app.close();
  });

  it('answers INTERNAL_ERROR and writes nothing when the audit sink rejects the event', async () => {
    const rig = await started(seeded(), { record: () => Promise.reject(new Error('the sink is down')) });
    const before = JSON.stringify(rig.store.investigations);
    const response = await remove(rig);
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
    expect(JSON.stringify(rig.store.investigations)).toBe(before);
    expect((await list(rig)).json().items).toHaveLength(1);
    await rig.app.close();
  });
});

describe('POST /v1/investigations/{id}/restore', () => {
  const deleted = async (overrides: Partial<InvestigationRow> = {}): Promise<Rig> => {
    const rig = await started(seeded(overrides));
    expect((await remove(rig)).statusCode).toBe(200);
    rig.audited.length = 0;
    return rig;
  };

  it.each([
    ['no expectedVersion', {}],
    ['an expectedVersion of zero', { expectedVersion: 0 }],
    ['another field', { expectedVersion: 4, status: 'open' }],
  ])('refuses %s with INVALID_REQUEST and restores nothing', async (_name, payload) => {
    const rig = await deleted();
    const response = await restore(rig, payload);
    expect(response.statusCode).toBe(400);
    expect((await list(rig)).json().items).toEqual([]);
    await rig.app.close();
  });

  it('refuses a stale expectedVersion with CONFLICT and restores nothing', async () => {
    const rig = await deleted();
    const response = await restore(rig, { expectedVersion: 3 });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'CONFLICT' } });
    expect((await list(rig)).json().items).toEqual([]);
    await rig.app.close();
  });

  it.each([
    ['another user', { ownerId: OTHER }, ID],
    ['an unknown ID', {}, '0192f000-0000-7000-8000-0000000000ff'],
    ['an ID that is not a UUID', {}, 'not-a-uuid'],
  ])('answers NOT_FOUND for %s', async (_name, overrides, id) => {
    const rig = await started(seeded(overrides));
    expect((await restore(rig, { expectedVersion: 3 }, id)).statusCode).toBe(404);
    await rig.app.close();
  });

  it('answers NOT_FOUND for an investigation that is not deleted', async () => {
    const rig = await started(seeded());
    const response = await restore(rig, { expectedVersion: 3 });
    expect(response.statusCode).toBe(404);
    expect(first(rig.store).version).toBe(3);
    await rig.app.close();
  });

  it('restores it: the answer is the investigation, one version higher, with its status as before', async () => {
    const rig = await deleted({ status: 'closed', closedAt: '2026-11-06T10:00:00.000Z' });
    const response = await restore(rig, { expectedVersion: 4 });
    expect(response.statusCode).toBe(200);
    expect(response.headers['etag']).toBe('"5"');
    expect(response.json()).toMatchObject({ investigation: { id: ID, status: 'closed', version: 5 }, save: { state: 'unsaved' } });
    expect((await list(rig, '?status=closed')).json().items).toHaveLength(1);
    expect(rig.audited).toEqual([expect.objectContaining({ action: 'investigation.restore', result: 'success' })]);
    await rig.app.close();
  });

  it('answers INTERNAL_ERROR and restores nothing when the audit sink rejects the event', async () => {
    let calls = 0;
    const rig = await started(seeded(), { record: () => (++calls === 1 ? Promise.resolve() : Promise.reject(new Error('the sink is down'))) });
    expect((await remove(rig)).statusCode).toBe(200);
    const response = await restore(rig, { expectedVersion: 4 });
    expect(response.statusCode).toBe(500);
    expect((await list(rig)).json().items).toEqual([]);
    await rig.app.close();
  });
});

describe('GET /v1/investigations?deleted=true', () => {
  it('lists the deleted ones with their dates, and refuses a status with it', async () => {
    const rig = await started(seeded());
    await remove(rig);
    const response = await list(rig, '?deleted=true');
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.items).toEqual([expect.objectContaining({ id: ID, status: 'open', version: 4, deletedAt: expect.any(String), purgeAfter: expect.any(String), startingEntity: { entityType: 'widget' } })]);
    expect(body.retention).toEqual({ deletedInvestigationsDays: 30 });
    expect(body.matching).toEqual({ value: 1, quality: 'exact', scope: 'investigations-matching' });
    expect((await list(rig, '?deleted=true&status=open')).statusCode).toBe(400);
    expect((await list(rig, '?deleted=maybe')).statusCode).toBe(400);
    await rig.app.close();
  });

  it('does not list a live investigation, and an ordinary list carries the retention', async () => {
    const rig = await started(seeded());
    expect((await list(rig, '?deleted=true')).json().items).toEqual([]);
    expect((await list(rig)).json().retention).toEqual({ deletedInvestigationsDays: 30 });
    await rig.app.close();
  });

  it('refuses a cursor from the ordinary list, and the reverse', async () => {
    const store = seeded();
    const documents = initialDraftDocuments({ entityType: 'widget', stableId: 'W-1' });
    for (const [index, id] of ['0192f000-0000-7000-8000-0000000000c2', '0192f000-0000-7000-8000-0000000000c3'].entries()) {
      store.investigations.push(row({ id, lastEditedAt: `2026-11-05T10:00:0${index + 1}.000Z` }));
      store.drafts.push({ id: `0192f000-0000-7000-8000-0000000000e${index}`, version: 1, notes: null, basedOnViewId: null, layout: documents.layout, queryContext: documents.queryContext, mappingHash: 'h', investigationId: id, contentHash: contentHashOf(documents) });
    }
    const rig = await started(store);
    for (const id of [ID, '0192f000-0000-7000-8000-0000000000c2', '0192f000-0000-7000-8000-0000000000c3']) await remove(rig, { 'if-match': '"3"' }, id);
    const ordinary = await started(seeded());
    const cursorOf = async (target: Rig, query: string) => {
      const page = (await list(target, query)).json();
      return page.nextCursor as string | null;
    };
    const deletedCursor = await cursorOf(rig, '?deleted=true&limit=1');
    expect(deletedCursor).not.toBeNull();
    expect((await list(rig, `?deleted=true&limit=1&cursor=${deletedCursor}`)).statusCode).toBe(200);
    expect((await list(rig, `?limit=1&cursor=${deletedCursor}`)).json()).toMatchObject({ error: { code: 'CURSOR_INVALIDATED' } });
    expect((await list(ordinary, '')).statusCode).toBe(200);
    await rig.app.close();
    await ordinary.app.close();
  });
});

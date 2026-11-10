import { rmSync } from 'node:fs';
import { investigationResponseSchema, openInvestigationResponseSchema } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import type { InvestigationRow } from '../db/investigations-repository.js';
import type { ExecuteOutcome } from '../gate/executor.js';
import { createLogger } from '../logger.js';
import { parseMapping } from '../mapping/load.js';
import { identityHashOf } from '../registry/identity-hash.js';
import { LOCAL_IDENTITY, memoryAppStore, type MemoryAppStore } from '../testing/app-store.js';
import { entityCalls, entityRows, plainNode } from '../testing/entity-fixtures.js';
import { TestExecutor } from '../testing/gate.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { testSourceGate } from '../testing/source-gate.js';
import { makeWebRoot } from '../testing/web-root.js';
import { initialDraftDocuments } from './draft.js';
import { withOnlineIndexes } from '../testing/search-fixtures.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

const mapping = parseMapping(
  fileOf(baseSource({ id: 'demo', entities: [{ type: 'widget', label: 'Widget', stable_id: 'widgetId' }, { type: 'gizmo', label: 'Gizmo', stable_id: 'gizmoId' }], relationships: [{ type: 'LINKS', from: 'widget', to: 'gizmo' }] })),
  'neburyx.yaml',
);
const [demo] = mapping.sources;
if (demo === undefined) throw new Error('the fixture has a source');

const WIDGET = plainNode(['Widget'], { widgetId: 'W-1' });
const ME = LOCAL_IDENTITY.principal.id;
const OTHER = '0192f000-0000-7000-8000-0000000000aa';
const body = (overrides: Record<string, unknown> = {}) => ({ sourceId: 'demo', entity: { sourceId: 'demo', entityType: 'widget', stableId: 'W-1' }, caseRef: 'CASE-1', ...overrides });

function row(overrides: Partial<InvestigationRow> = {}): InvestigationRow {
  return {
    id: '0192f000-0000-7000-8000-0000000000c1',
    sourceId: 'demo',
    sourceIdentityHash: identityHashOf(demo),
    ownerId: ME,
    title: 'Widget W-1',
    caseRef: 'CASE-1',
    startingEntityType: 'widget',
    startingStableId: 'W-1',
    status: 'open',
    createdAt: '2026-11-05T10:00:00.000Z',
    lastEditedAt: '2026-11-05T10:00:00.000Z',
    version: 3,
    ...overrides,
  };
}

async function started(answer: ExecuteOutcome = entityRows(WIDGET), store: MemoryAppStore = memoryAppStore(), appMapping = mapping) {
  const executor = new TestExecutor(withOnlineIndexes(mapping.sources[0] ?? (() => { throw new Error('the mapping has no source'); })(), () => Promise.resolve(answer)));
  const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store, mapping: appMapping, gate: testSourceGate(appMapping, { executor }).gate });
  return { app, store, executor };
}

const asOther = (store: MemoryAppStore): MemoryAppStore => ({ ...store, current: () => Promise.resolve({ ...LOCAL_IDENTITY, principal: { ...LOCAL_IDENTITY.principal, id: OTHER } }) });

const draftFor = (investigationId: string, id: string) => {
  const documents = initialDraftDocuments({ entityType: 'widget', stableId: 'W-1' });
  return { id, version: 1, notes: null, investigationId, layout: documents.layout, queryContext: documents.queryContext };
};

const post = (app: Awaited<ReturnType<typeof started>>['app'], payload: object) => app.inject({ method: 'POST', url: '/v1/investigations', payload });

describe('POST /v1/investigations with a case reference', () => {
  it('creates an investigation with the reference stored when none matches, and returns the same one on the next open', async () => {
    const { app, store } = await started();
    const first = await post(app, body());
    expect(first.statusCode).toBe(201);
    expect(store.investigations[0]).toMatchObject({ caseRef: 'CASE-1' });
    const second = await post(app, body());
    expect(second.statusCode).toBe(200);
    const resumed = openInvestigationResponseSchema.parse(second.json());
    expect(resumed.created).toBe(false);
    expect(resumed.investigation.id).toBe(openInvestigationResponseSchema.parse(first.json()).investigation.id);
    expect(resumed).toMatchObject({ entity: { ref: { stableId: 'W-1' } } });
    expect(store.investigations).toHaveLength(1);
    expect(store.drafts).toHaveLength(1);
    await app.close();
  });

  it.each([
    ['another user’s', { ownerId: OTHER }],
    ['a closed', { status: 'closed' as const }],
    ['an archived', { status: 'archived' as const }],
    ['one with another starting entity', { startingStableId: 'W-2' }],
    ['one with another entity type', { startingEntityType: 'gizmo' }],
    ['one with another case reference', { caseRef: 'CASE-2' }],
  ])('creates a new investigation when the match is %s', async (_name, overrides) => {
    const store = memoryAppStore();
    store.investigations.push(row(overrides));
    const { app } = await started(entityRows(WIDGET), store);
    const response = await post(app, body());
    expect(response.statusCode).toBe(201);
    expect(store.investigations).toHaveLength(2);
    expect(store.investigations[1]).toMatchObject({ caseRef: 'CASE-1', ownerId: ME });
    await app.close();
  });

  it('gives each of two users their own investigation back when each calls, and a user who has none a new one, without touching the others', async () => {
    const mine = row({ id: '0192f000-0000-7000-8000-0000000000c1' });
    const theirs = row({ id: '0192f000-0000-7000-8000-0000000000c2', ownerId: OTHER });
    const store = memoryAppStore();
    store.investigations.push(mine, theirs);
    store.drafts.push(draftFor(mine.id, '0192f000-0000-7000-8000-0000000000d1'), draftFor(theirs.id, '0192f000-0000-7000-8000-0000000000d2'));
    const me = await started(entityRows(WIDGET), store);
    const other = await started(entityRows(WIDGET), asOther(store));
    const first = openInvestigationResponseSchema.parse((await post(me.app, body())).json());
    const second = openInvestigationResponseSchema.parse((await post(other.app, body())).json());
    expect([first.investigation.id, second.investigation.id]).toEqual([mine.id, theirs.id]);
    expect(store.investigations).toHaveLength(2);
    expect(store.drafts).toHaveLength(2);
    const third = await post(other.app, body({ caseRef: 'CASE-3' }));
    expect(third.statusCode).toBe(201);
    expect(store.investigations.map((investigation) => investigation.ownerId)).toEqual([ME, OTHER, OTHER]);
    expect(store.investigations.slice(0, 2)).toEqual([mine, theirs]);
    await me.app.close();
    await other.app.close();
  });

  it('makes no source read, creates nothing and answers with the investigation as it is when its source now points elsewhere', async () => {
    const store = memoryAppStore();
    store.investigations.push(row({ sourceIdentityHash: 'a-hash-of-another-database' }));
    store.drafts.push(draftFor(row().id, '0192f000-0000-7000-8000-0000000000d1'));
    const { app, executor } = await started(entityRows(WIDGET), store);
    const response = await post(app, body());
    expect(response.statusCode).toBe(200);
    const answer = openInvestigationResponseSchema.parse(response.json());
    expect(answer).toMatchObject({ created: false, investigation: { sourceState: 'repointed', id: '0192f000-0000-7000-8000-0000000000c1' } });
    expect(answer).not.toHaveProperty('entity');
    expect(entityCalls(executor.calls)).toEqual([]);
    expect(store.investigations).toHaveLength(1);
    await app.close();
  });

  it('answers the investigation as it is, without a read, when the mapping that replaced its source no longer has the entity type it started with', async () => {
    const replaced = parseMapping(fileOf(baseSource({ id: 'demo', entities: [{ type: 'gadget', label: 'Gadget', stable_id: 'gadgetId' }, { type: 'gizmo', label: 'Gizmo', stable_id: 'gizmoId' }], relationships: [{ type: 'LINKS', from: 'gadget', to: 'gizmo' }] })), 'neburyx.yaml');
    const store = memoryAppStore();
    store.investigations.push(row({ sourceIdentityHash: 'a-hash-of-another-database' }));
    store.drafts.push(draftFor(row().id, '0192f000-0000-7000-8000-0000000000d1'));
    const { app, executor } = await started(entityRows(WIDGET), store, replaced);
    const response = await post(app, body());
    expect(response.statusCode).toBe(200);
    expect(openInvestigationResponseSchema.parse(response.json())).toMatchObject({ created: false, investigation: { sourceState: 'repointed' } });
    expect(entityCalls(executor.calls)).toEqual([]);
    expect((await post(app, body({ caseRef: 'CASE-2' }))).statusCode).toBe(400);
    expect(store.investigations).toHaveLength(1);
    await app.close();
  });

  const failures: readonly (readonly [string, ExecuteOutcome, number, string])[] = [
    ['the entity is gone', entityRows(), 404, 'NOT_FOUND'],
    ['the source is down', { status: 'unavailable', reason: 'unreachable' }, 503, 'SOURCE_UNAVAILABLE'],
  ];

  it.each(failures)('answers the failure and leaves the existing investigation and its draft unchanged when %s', async (_name, answer, status, code) => {
    const store = memoryAppStore();
    store.investigations.push(row());
    const { app } = await started(answer, store);
    const before = JSON.stringify([store.investigations, store.drafts]);
    const response = await post(app, body());
    expect(response.statusCode).toBe(status);
    expect(response.json().error.code).toBe(code);
    expect(JSON.stringify([store.investigations, store.drafts])).toBe(before);
    await app.close();
  });
});

describe('GET /v1/investigations/{id}', () => {
  async function opened() {
    const parts = await started();
    const created = openInvestigationResponseSchema.parse((await post(parts.app, body())).json());
    return { ...parts, id: created.investigation.id };
  }

  it('answers the investigation and the caller’s draft, with the version as the ETag, and reads no source', async () => {
    const { app, id, executor } = await opened();
    const before = executor.calls.length;
    const response = await app.inject({ method: 'GET', url: `/v1/investigations/${id}` });
    expect(response.statusCode).toBe(200);
    expect(response.headers['etag']).toBe('"1"');
    const answer = investigationResponseSchema.parse(response.json());
    expect(answer.investigation).toMatchObject({ id, sourceId: 'demo', caseRef: 'CASE-1', status: 'open', sourceState: 'available', startingEntity: { entityType: 'widget', stableId: 'W-1' } });
    expect(answer.draft.layout.nodes).toHaveLength(1);
    expect(answer.draft.version).toBe(1);
    expect(executor.calls.length).toBe(before);
    await app.close();
  });

  it.each([
    ['an identifier that does not exist', '0192f000-0000-7000-8000-0000000000ee'],
    ['an identifier that is not a UUID', 'not-a-uuid'],
    ['a UUID with the wrong shape', '0192f000-0000-7000-8000-00000000ee'],
  ])('answers the same NOT_FOUND for %s', async (_name, id) => {
    const { app } = await opened();
    const response = await app.inject({ method: 'GET', url: `/v1/investigations/${id}` });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
    await app.close();
  });

  it('answers the same NOT_FOUND for another user’s investigation', async () => {
    const store = memoryAppStore();
    const { app, id } = await (async () => {
      const parts = await started(entityRows(WIDGET), store);
      const created = openInvestigationResponseSchema.parse((await post(parts.app, body())).json());
      return { app: parts.app, id: created.investigation.id };
    })();
    const [mine] = store.investigations;
    if (mine === undefined) throw new Error('the investigation was not stored');
    store.investigations[0] = { ...mine, ownerId: OTHER };
    const missing = await app.inject({ method: 'GET', url: '/v1/investigations/0192f000-0000-7000-8000-0000000000ee' });
    const foreign = await app.inject({ method: 'GET', url: `/v1/investigations/${id}` });
    expect(foreign.statusCode).toBe(404);
    expect({ ...foreign.json().error, traceId: undefined }).toEqual({ ...missing.json().error, traceId: undefined });
    await app.close();
  });

  it('reports a source that is no longer configured as removed and one that points elsewhere as repointed, without reading either', async () => {
    const store = memoryAppStore();
    store.investigations.push(row({ id: '0192f000-0000-7000-8000-0000000000d1', sourceId: 'gone' }), row({ id: '0192f000-0000-7000-8000-0000000000d2', sourceIdentityHash: 'other-database' }));
    const initial = initialDraftDocuments({ entityType: 'widget', stableId: 'W-1' });
    for (const [id, investigationId] of [['0192f000-0000-7000-8000-0000000000e1', '0192f000-0000-7000-8000-0000000000d1'], ['0192f000-0000-7000-8000-0000000000e2', '0192f000-0000-7000-8000-0000000000d2']] as const) {
      store.drafts.push({ id, version: 1, notes: null, investigationId, layout: initial.layout, queryContext: initial.queryContext });
    }
    const { app, executor } = await started(entityRows(WIDGET), store);
    const removed = investigationResponseSchema.parse((await app.inject({ method: 'GET', url: '/v1/investigations/0192f000-0000-7000-8000-0000000000d1' })).json());
    const repointed = investigationResponseSchema.parse((await app.inject({ method: 'GET', url: '/v1/investigations/0192f000-0000-7000-8000-0000000000d2' })).json());
    expect(removed.investigation.sourceState).toBe('removed');
    expect(repointed.investigation.sourceState).toBe('repointed');
    expect(executor.calls).toEqual([]);
    await app.close();
  });

  it('answers INVALID_REQUEST for a query parameter', async () => {
    const { app, id } = await opened();
    const response = await app.inject({ method: 'GET', url: `/v1/investigations/${id}?x=1` });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_REQUEST');
    await app.close();
  });
});

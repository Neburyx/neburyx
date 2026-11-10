import { rmSync } from 'node:fs';
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
import { contentHashOf, initialDraftDocuments } from './draft.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

const mapping = parseMapping(fileOf(baseSource({ id: 'demo', entities: [{ type: 'widget', label: 'Widget', stable_id: 'widgetId' }], relationships: [{ type: 'LINKS', from: 'widget', to: 'widget' }] })), 'neburyx.yaml');
const [demo] = mapping.sources;
if (demo === undefined) throw new Error('the fixture has a source');

const ME = LOCAL_IDENTITY.principal.id;
const ID = '0192f000-0000-7000-8000-0000000000c1';
const VIEW = '0192f000-0000-7000-8000-0000000000b1';
const documents = initialDraftDocuments({ entityType: 'widget', stableId: 'W-1' });

function seeded(status: InvestigationRow['status']): MemoryAppStore {
  const store = memoryAppStore();
  store.investigations.push({ id: ID, sourceId: 'demo', sourceIdentityHash: identityHashOf(demo), ownerId: ME, title: 'Widget W-1', caseRef: null, startingEntityType: 'widget', startingStableId: 'W-1', status, closedAt: null, archivedAt: null, createdAt: '2026-11-05T10:00:00.000Z', lastEditedAt: '2026-11-05T10:00:00.000Z', version: 1 });
  store.drafts.push({ id: '0192f000-0000-7000-8000-0000000000d1', version: 3, notes: null, basedOnViewId: null, mappingHash: demo.configHash, layout: documents.layout, queryContext: documents.queryContext, investigationId: ID, contentHash: contentHashOf(documents) });
  store.namedViews.push({ id: VIEW, investigationId: ID, name: 'A view', notes: null, layout: documents.layout, queryContext: documents.queryContext, contentHash: contentHashOf(documents), createdAt: '2026-11-08T09:30:00.000Z', version: 1 });
  return store;
}

async function started(store: MemoryAppStore) {
  return buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store, mapping, gate: testSourceGate(mapping, { referenceKeys: TEST_REFERENCE_KEYS }).gate, referenceKeys: TEST_REFERENCE_KEYS });
}

type App = Awaited<ReturnType<typeof started>>;
const path = `/v1/investigations/${ID}/views`;
const calls = {
  save: (app: App) => app.inject({ method: 'POST', url: path, headers: { 'if-match': '"3"' }, payload: { name: 'New', notes: null } }),
  rename: (app: App) => app.inject({ method: 'PUT', url: `${path}/${VIEW}`, headers: { 'if-match': '"1"' }, payload: { name: 'Renamed' } }),
  restore: (app: App) => app.inject({ method: 'POST', url: `${path}/${VIEW}/restore`, headers: { 'if-match': '"3"' } }),
};

describe('a closed or archived investigation and its named views', () => {
  it.each(['closed', 'archived'] as const)('refuses a view save, a rename and a restore of an investigation that is %s, and stores nothing', async (status) => {
    const store = seeded(status);
    const app = await started(store);
    const before = JSON.stringify([store.investigations, store.drafts, store.namedViews]);
    for (const call of Object.values(calls)) {
      const response = await call(app);
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: 'CONFLICT', details: { reason: 'investigation-read-only', status } } });
    }
    expect(JSON.stringify([store.investigations, store.drafts, store.namedViews])).toBe(before);
    await app.close();
  });

  it('checks the read-only rule before the version: a stale version on a closed investigation is still the read-only refusal', async () => {
    const app = await started(seeded('closed'));
    const stale = await app.inject({ method: 'POST', url: path, headers: { 'if-match': '"99"' }, payload: { name: 'New', notes: null } });
    expect(stale.json().error.details.reason).toBe('investigation-read-only');
    await app.close();
  });

  it('still lists the views of a closed investigation', async () => {
    const app = await started(seeded('closed'));
    const response = await app.inject({ method: 'GET', url: path });
    expect(response.statusCode).toBe(200);
    expect(response.json().items).toHaveLength(1);
    await app.close();
  });

  it('works again once the investigation is reopened', async () => {
    const store = seeded('closed');
    const app = await started(store);
    expect((await calls.save(app)).statusCode).toBe(409);
    const [held] = store.investigations;
    if (held === undefined) throw new Error('seeded an investigation');
    store.investigations[0] = { ...held, status: 'open' };
    expect((await calls.rename(app)).statusCode).toBe(200);
    expect((await calls.restore(app)).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: path, headers: { 'if-match': '"4"' }, payload: { name: 'New', notes: null } })).statusCode).toBe(201);
    await app.close();
  });
});

import { rmSync } from 'node:fs';
import { type ExtensionRequest, type ExtensionRoute, type ProfileExtension } from '@neburyx/contracts';
import { z } from 'zod';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import type { InvestigationRow } from '../db/investigations-repository.js';
import { contentHashOf, initialDraftDocuments } from '../investigations/draft.js';
import { createLogger } from '../logger.js';
import { parseMapping } from '../mapping/load.js';
import { identityHashOf } from '../registry/identity-hash.js';
import { LOCAL_IDENTITY, memoryAppStore, type MemoryAppStore } from '../testing/app-store.js';
import { TEST_REFERENCE_KEYS } from '../testing/gate.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { testSourceGate } from '../testing/source-gate.js';
import { makeWebRoot } from '../testing/web-root.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

const mapping = parseMapping(fileOf(baseSource({ id: 'demo', entities: [{ type: 'widget', label: 'Widget', stable_id: 'widgetId' }], relationships: [] })), 'neburyx.yaml');
const [demo] = mapping.sources;
if (demo === undefined) throw new Error('the fixture has a source');

const ME = LOCAL_IDENTITY.principal.id;
const OTHER = '0192f000-0000-7000-8000-0000000000aa';
const ID = '0192f000-0000-7000-8000-0000000000c1';

function row(overrides: Partial<InvestigationRow> = {}): InvestigationRow {
  return { id: ID, sourceId: 'demo', sourceIdentityHash: identityHashOf(demo), ownerId: ME, title: 'Widget W-1', caseRef: null, startingEntityType: 'widget', startingStableId: 'W-1', status: 'open', createdAt: '2026-11-05T10:00:00.000Z', lastEditedAt: '2026-11-05T10:00:00.000Z', closedAt: null, archivedAt: null, version: 3, ...overrides };
}

function seeded(overrides: Partial<InvestigationRow> = {}): MemoryAppStore {
  const store = memoryAppStore();
  const documents = initialDraftDocuments({ entityType: 'widget', stableId: 'W-1' });
  store.investigations.push(row(overrides));
  store.drafts.push({ id: '0192f000-0000-7000-8000-0000000000d1', version: 1, notes: null, basedOnViewId: null, layout: documents.layout, queryContext: documents.queryContext, mappingHash: demo.configHash, investigationId: ID, contentHash: contentHashOf(documents) });
  return store;
}

const OTHER_ID = '0192f000-0000-7000-8000-0000000000c2';

async function mounted(store: MemoryAppStore, route: Partial<ExtensionRoute>, seen: (request: ExtensionRequest) => void = () => undefined) {
  const handler = async (request: ExtensionRequest): Promise<unknown> => {
    seen(request);
    return { ok: true };
  };
  const extension: ProfileExtension = { name: 'probe', routeGroups: [{ routes: [{ method: 'GET', url: '/v1/probe/:id', permission: 'principal', responseSchema: z.unknown(), handler, ...route }] }] };
  return buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store, mapping, gate: testSourceGate(mapping, { referenceKeys: TEST_REFERENCE_KEYS }).gate, referenceKeys: TEST_REFERENCE_KEYS, extension, previewOn: true });
}

const PARAMS = z.strictObject({ id: z.string() });
const QUERY = z.strictObject({ mask: z.enum(['true', 'false']).transform((value) => value === 'true') });

describe('the inputs of an extension route', () => {
  it('gives the handler its validated path parameters and query, and the source of the investigation from its record', async () => {
    let seen: ExtensionRequest | undefined;
    const app = await mounted(seeded(), { params: PARAMS, query: QUERY, investigation: { param: 'id', missing: 'NOT_FOUND' } }, (request) => (seen = request));
    const answer = await app.inject({ url: `/v1/probe/${ID}?mask=true` });
    expect(answer.statusCode).toBe(200);
    expect(seen).toMatchObject({ params: { id: ID }, query: { mask: true }, investigation: { id: ID, sourceId: 'demo' } });
    await app.close();
  });

  it('refuses a parameter or a query that does not fit, and does not run the handler', async () => {
    let ran = false;
    const app = await mounted(seeded(), { params: PARAMS, query: QUERY, investigation: { param: 'id', missing: 'NOT_FOUND' } }, () => (ran = true));
    expect((await app.inject({ url: `/v1/probe/${ID}?mask=maybe` })).statusCode).toBe(400);
    expect((await app.inject({ url: `/v1/probe/${ID}` })).statusCode).toBe(400);
    expect((await app.inject({ url: `/v1/probe/${ID}?mask=true&extra=1` })).statusCode).toBe(400);
    expect(ran).toBe(false);
    await app.close();
  });

  it('answers an investigation that is not the caller\'s, is deleted or is not an id with the code the route declares, before the handler', async () => {
    let ran = false;
    for (const [missing, status] of [['NOT_FOUND', 404], ['ACCESS_DENIED', 403]] as const) {
      const app = await mounted(seeded({ ownerId: OTHER }), { params: PARAMS, investigation: { param: 'id', missing } }, () => (ran = true));
      expect((await app.inject({ url: `/v1/probe/${ID}` })).statusCode).toBe(status);
      expect((await app.inject({ url: `/v1/probe/${OTHER_ID}` })).statusCode).toBe(status);
      expect((await app.inject({ url: '/v1/probe/not-an-id' })).statusCode).toBe(status);
      await app.close();
    }
    expect(ran).toBe(false);
  });

  it('lets the handler see the path and the body, so it can refuse a body that names another investigation', async () => {
    let seen: ExtensionRequest | undefined;
    const store = seeded();
    const handler = async (request: ExtensionRequest): Promise<unknown> => ((seen = request), { ok: true });
    const extension: ProfileExtension = { name: 'probe', routeGroups: [{ routes: [{ method: 'POST', url: '/v1/probe/:id', permission: 'principal', requestSchema: z.strictObject({ investigationId: z.string() }), responseSchema: z.unknown(), params: PARAMS, investigation: { param: 'id', missing: 'ACCESS_DENIED' }, handler }] }] };
    const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store, mapping, gate: testSourceGate(mapping, { referenceKeys: TEST_REFERENCE_KEYS }).gate, referenceKeys: TEST_REFERENCE_KEYS, extension, previewOn: true });
    await app.inject({ method: 'POST', url: `/v1/probe/${ID}`, payload: { investigationId: OTHER_ID } });
    expect(seen?.body).toEqual({ investigationId: OTHER_ID });
    expect(seen?.investigation?.id).toBe(ID);
    await app.close();
  });

  it('leaves a route that declares nothing as it was, with no params, query or investigation on its request', async () => {
    let seen: ExtensionRequest | undefined;
    const app = await mounted(seeded(), {}, (request) => (seen = request));
    expect((await app.inject({ url: `/v1/probe/${ID}` })).statusCode).toBe(200);
    expect(seen).not.toHaveProperty('params');
    expect(seen).not.toHaveProperty('investigation');
    await app.close();
  });
});

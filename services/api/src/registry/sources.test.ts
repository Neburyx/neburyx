import { readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { meResponseSchema, sourcesResponseSchema } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp, registeredRoutesOf } from '../app.js';
import type { SourceRow } from '../db/sources-repository.js';
import { createLogger } from '../logger.js';
import { parseMapping } from '../mapping/load.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { memoryStoreWith } from '../testing/app-store.js';
import { makeWebRoot } from '../testing/web-root.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

const row = (id: string, overrides: Partial<SourceRow> = {}): SourceRow => ({ id, alias: id, state: 'unknown', stateReason: null, synthetic: false, lastTestAt: null, ...overrides });

function mappingOf(...ids: string[]): ReturnType<typeof parseMapping> {
  return parseMapping(fileOf(...ids.map((id) => baseSource({ id }))), 'neburyx.yaml');
}

async function appWith(ids: readonly string[], store = memoryStoreWith({ sources: ids.map((id) => row(id)) })): ReturnType<typeof buildApp> {
  return buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store, mapping: mappingOf(...ids) });
}

describe('GET /v1/sources', () => {
  it('lists the configured sources ordered by id with state, read-only flag, no last test and exact definition counts', async () => {
    const app = await appWith(['alpha', 'beta']);
    const response = await app.inject({ method: 'GET', url: '/v1/sources' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      items: ['alpha', 'beta'].map((id) => ({
        id,
        alias: id,
        state: 'unknown',
        stateReason: null,
        readOnly: true,
        synthetic: false,
        lastTestAt: null,
        lastTest: null,
        mappingSummary: { entityTypes: 2, relationshipTypes: 1, derivedRules: 0 },
        demoCase: null,
        timeoutMs: 5000,
      })),
      nextCursor: null,
    });
    expect(sourcesResponseSchema.safeParse(response.json()).success).toBe(true);
    await app.close();
  });

  it('counts configured definitions: 3 entity types, 2 relationship types and 1 derived rule', async () => {
    const source = baseSource({
      entities: [
        { type: 'node_a', label: 'A', stable_id: 'id' },
        { type: 'node_b', label: 'B', stable_id: 'id' },
        { type: 'node_c', label: 'C', stable_id: 'id' },
      ],
      relationships: [
        { type: 'LINKS', from: 'node_a', to: 'node_b' },
        { type: 'TIES', from: 'node_b', to: 'node_c' },
      ],
      derived: [{ id: 'r', from: 'node_a', to: 'node_a', via: ['LINKS', 'node_b', 'LINKS'], rule_version: 1 }],
    });
    const mapping = parseMapping(fileOf(source), 'neburyx.yaml');
    const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store: memoryStoreWith({ sources: [row('demo')] }), mapping });
    const response = await app.inject({ method: 'GET', url: '/v1/sources' });
    expect(response.json().items[0].mappingSummary).toEqual({ entityTypes: 3, relationshipTypes: 2, derivedRules: 1 });
    await app.close();
  });

  it('shows the state and reason a row holds', async () => {
    const app = await appWith(['alpha'], memoryStoreWith({ sources: [row('alpha', { state: 'unavailable', stateReason: 'TLS handshake failed', synthetic: true })] }));
    const item = (await app.inject({ method: 'GET', url: '/v1/sources' })).json().items[0];
    expect(item).toMatchObject({ state: 'unavailable', stateReason: 'TLS handshake failed', synthetic: true });
    await app.close();
  });

  it('carries the demo case of a synthetic source that names one, and null for every other source', async () => {
    const demoCase = { entity: { type: 'node_a', id: 'A-1' }, case_ref: 'REF-1' };
    const mapping = parseMapping(fileOf(baseSource({ id: 'alpha', synthetic: true, demo_case: demoCase }), baseSource({ id: 'beta', synthetic: true }), baseSource({ id: 'gamma' })), 'neburyx.yaml');
    const store = memoryStoreWith({ sources: [row('alpha', { synthetic: true }), row('beta', { synthetic: true }), row('gamma')] });
    const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store, mapping });
    const response = await app.inject({ method: 'GET', url: '/v1/sources' });
    const body = sourcesResponseSchema.parse(response.json());
    expect(body.items.map((item) => [item.id, item.state, item.demoCase])).toEqual([
      ['alpha', 'unknown', { entityType: 'node_a', stableId: 'A-1', caseRef: 'REF-1' }],
      ['beta', 'unknown', null],
      ['gamma', 'unknown', null],
    ]);
    await app.close();
  });

  it('answers an empty list when no source is configured', async () => {
    const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store: memoryStoreWith({}) });
    const response = await app.inject({ method: 'GET', url: '/v1/sources' });
    expect(response.json()).toEqual({ items: [], nextCursor: null });
    await app.close();
  });

  it('leaves out a row the mapping does not define', async () => {
    const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store: memoryStoreWith({ sources: [row('ghost')] }), mapping: mappingOf('alpha') });
    expect((await app.inject({ method: 'GET', url: '/v1/sources' })).json().items).toEqual([]);
    await app.close();
  });

  it('never carries an address, a database, a credential name or a hash', async () => {
    const app = await appWith(['alpha']);
    const text = (await app.inject({ method: 'GET', url: '/v1/sources' })).body;
    for (const secret of ['graph.example.test', 'neo4j+s', 'DEMO_USER', 'DEMO_PASSWORD', 'secret_ref', 'configHash', 'config_hash']) {
      expect(text).not.toContain(secret);
    }
    await app.close();
  });

  it.each(['?limit=1', '?cursor=abc', '?anything=1'])('answers 400 INVALID_REQUEST for the query %s', async (query) => {
    const app = await appWith(['alpha']);
    const response = await app.inject({ method: 'GET', url: `/v1/sources${query}` });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_REQUEST');
    await app.close();
  });

  it('answers 500 INTERNAL_ERROR with the trace id and no detail when the store fails', async () => {
    const app = await appWith(['alpha'], memoryStoreWith({ failSources: true }));
    const response = await app.inject({ method: 'GET', url: '/v1/sources' });
    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe('INTERNAL_ERROR');
    expect(response.json().error.traceId).toBe(response.headers['x-trace-id']);
    expect(response.body).not.toContain('could not be read');
    await app.close();
  });
});

describe('GET /v1/me sources', () => {
  it('lists each configured source as permitted, ordered by id, with the synthetic flag', async () => {
    const store = memoryStoreWith({ sources: [row('alpha'), row('beta', { synthetic: true })] });
    const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store, mapping: mappingOf('alpha', 'beta') });
    const body = (await app.inject({ method: 'GET', url: '/v1/me' })).json();
    expect(body.sources).toEqual([
      { sourceId: 'alpha', viewSensitive: true, synthetic: false },
      { sourceId: 'beta', viewSensitive: true, synthetic: true },
    ]);
    expect(meResponseSchema.safeParse(body).success).toBe(true);
    await app.close();
  });

  it('lists nothing when no source is configured', async () => {
    const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store: memoryStoreWith({}) });
    expect((await app.inject({ method: 'GET', url: '/v1/me' })).json().sources).toEqual([]);
    await app.close();
  });

  it('answers 500 INTERNAL_ERROR with the trace id when the store fails', async () => {
    const app = await appWith(['alpha'], memoryStoreWith({ failSources: true }));
    const response = await app.inject({ method: 'GET', url: '/v1/me' });
    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe('INTERNAL_ERROR');
    await app.close();
  });
});

describe('order and permission', () => {
  it('returns both endpoints in ascending id order whatever order the store returns', async () => {
    const store = memoryStoreWith({ sources: [row('charlie'), row('alpha'), row('bravo')] });
    const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store, mapping: mappingOf('charlie', 'alpha', 'bravo') });
    const list = (await app.inject({ method: 'GET', url: '/v1/sources' })).json();
    expect(list.items.map((item: { id: string }) => item.id)).toEqual(['alpha', 'bravo', 'charlie']);
    const me = (await app.inject({ method: 'GET', url: '/v1/me' })).json();
    expect(me.sources.map((item: { sourceId: string }) => item.sourceId)).toEqual(['alpha', 'bravo', 'charlie']);
    await app.close();
  });

  it('declares the principal permission on the source list', async () => {
    const app = await appWith(['alpha']);
    const route = registeredRoutesOf(app).find((candidate) => candidate.url === '/v1/sources' && candidate.method === 'GET');
    expect(route?.permission).toBe('principal');
    await app.close();
  });
});

describe('the pagination exception', () => {
  it('is written in the API conventions', () => {
    const text = readFileSync(fileURLToPath(new URL('../../../../docs/api-conventions.md', import.meta.url)), 'utf8');
    expect(text).toContain('`GET /v1/sources` is the one exception');
    expect(text).toContain('not paged');
  });
});

import { rmSync } from 'node:fs';
import { sourcesResponseSchema, type SourceTestReport } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createLogger } from '../logger.js';
import { uuidv7 } from '../identity/uuid.js';
import { reportFromFailure, reportFromServer } from '../source-test/report.js';
import { memoryStoreWith, type MemoryAppStore } from '../testing/app-store.js';
import { mappingOf, sourceWith } from '../testing/gate-fixtures.js';
import { makeWebRoot } from '../testing/web-root.js';
import { identityHashOf } from './identity-hash.js';
import type { CapabilitiesItem } from '../gate/templates/capabilities.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

const mapping = mappingOf(sourceWith('alpha'), sourceWith('beta'));
const [alpha, beta] = mapping.sources;
if (alpha === undefined || beta === undefined) throw new Error('the fixture mapping has two sources');

const SERVER: CapabilitiesItem = { product: 'Neo4j Kernel', version: '5.26.32', edition: 'community', versionSupported: true, operations: [] };
const at = (minute: number): string => new Date(Date.UTC(2026, 10, 2, 10, minute, 0)).toISOString();

const checkOf = (report: SourceTestReport, hashes: { readonly identityHash?: string; readonly configHash?: string } = {}) => {
  const source = report.sourceId === 'beta' ? beta : alpha;
  return { id: uuidv7(), report, triggeredBy: null, identityHash: hashes.identityHash ?? identityHashOf(source), configHash: hashes.configHash ?? source.configHash };
};

async function freshStore(options: Parameters<typeof memoryStoreWith>[0] = {}): Promise<MemoryAppStore> {
  const store = memoryStoreWith(options);
  await store.syncSources(mapping.sources);
  return store;
}

async function listWith(store: MemoryAppStore) {
  const logs: string[] = [];
  const app = await buildApp({ webRoot, logger: createLogger({ write: (line: string) => logs.push(line) }), store, mapping });
  const response = await app.inject({ method: 'GET', url: '/v1/sources' });
  await app.close();
  return { response, logs };
}

const itemsOf = (response: Awaited<ReturnType<typeof listWith>>['response']) => sourcesResponseSchema.parse(response.json()).items;

describe('GET /v1/sources, the last test of each source', () => {
  it('answers null for a source that has never been tested', async () => {
    const { response } = await listWith(await freshStore());
    expect(response.statusCode).toBe(200);
    expect(itemsOf(response).map((item) => [item.id, item.lastTest, item.lastTestAt])).toEqual([
      ['alpha', null, null],
      ['beta', null, null],
    ]);
  });

  it('answers the newest stored test made for the current connection and mapping, with the fields of the summary only', async () => {
    const store = await freshStore();
    await store.recordSourceCheck(checkOf(reportFromServer(alpha, SERVER, false, at(1))));
    await store.recordSourceCheck(
      checkOf(reportFromServer(alpha, SERVER, false, at(2), { degrees: { status: 'warn', foundOn: 'neo4j', types: [{ entityType: 'person', result: 'not-cheap', basis: 'expand', relationshipTypes: ['KNOWS'] }], warnings: ['Degree counts are estimated for person: no cheap per-type degree index'] } })),
    );
    const { response } = await listWith(store);
    expect(itemsOf(response)[0]?.lastTest).toEqual({
      checkedAt: at(2),
      outcome: 'pass',
      server: { product: 'Neo4j Kernel', version: '5.26.32' },
      versionSupported: true,
      readOnlyCheck: 'privileges-inspected',
      loginCanWrite: false,
      degreeStatus: 'warn',
      degreeWarnings: ['Degree counts are estimated for person: no cheap per-type degree index'],
    });
    expect(itemsOf(response)[1]?.lastTest).toBeNull();
  });

  it('answers a test of a source that did not answer, with no server', async () => {
    const store = await freshStore();
    await store.recordSourceCheck(checkOf(reportFromFailure(alpha, 'unreachable', at(1))));
    const { response } = await listWith(store);
    expect(itemsOf(response)[0]?.lastTest).toEqual({
      checkedAt: at(1),
      outcome: 'fail',
      server: null,
      versionSupported: null,
      readOnlyCheck: 'not-verified',
      loginCanWrite: null,
      degreeStatus: 'not-run',
      degreeWarnings: [],
    });
  });

  it.each([
    ['another connection', { identityHash: 'other' }],
    ['another mapping', { configHash: 'other' }],
  ])('answers null when the only stored test was made for %s, and keeps the time of that test in lastTestAt', async (_name, hashes) => {
    const store = await freshStore();
    await store.recordSourceCheck(checkOf(reportFromServer(alpha, SERVER, false, at(1)), hashes));
    const { response } = await listWith(store);
    expect(itemsOf(response)[0]).toMatchObject({ lastTest: null, lastTestAt: at(1) });
  });

  it('answers the older test that matches when a newer one does not, and the time of the newer one in lastTestAt', async () => {
    const store = await freshStore();
    await store.recordSourceCheck(checkOf(reportFromServer(alpha, SERVER, false, at(1))));
    await store.recordSourceCheck(checkOf(reportFromServer(alpha, SERVER, false, at(5)), { configHash: 'other' }));
    const { response } = await listWith(store);
    expect(itemsOf(response)[0]).toMatchObject({ lastTest: { checkedAt: at(1) }, lastTestAt: at(5) });
  });

  it('carries no address, credential, hash, finding or query text', async () => {
    const store = await freshStore();
    await store.recordSourceCheck(checkOf(reportFromServer(alpha, SERVER, false, at(1), { mapping: { status: 'fail', findings: [{ severity: 'fail', check: 'label', entityType: 'person', message: 'The label Person is missing' }] } })));
    const { response } = await listWith(store);
    const item = itemsOf(response)[0];
    expect(Object.keys(item?.lastTest ?? {}).sort()).toEqual(['checkedAt', 'degreeStatus', 'degreeWarnings', 'loginCanWrite', 'outcome', 'readOnlyCheck', 'server', 'versionSupported']);
    expect(Object.keys(item?.lastTest?.server ?? {}).sort()).toEqual(['product', 'version']);
    const summary = JSON.stringify(item?.lastTest);
    for (const text of ['graph.example.test', 'The label Person is missing', 'findings', 'edition', 'identity', 'config', 'MATCH']) expect(summary).not.toContain(text);
    for (const text of ['graph.example.test', 'neo4j+s', 'DEMO_USER', 'config_hash', 'identityHash']) expect(response.body).not.toContain(text);
  });

  it('answers 500 INTERNAL_ERROR with the trace ID and no detail when the stored checks cannot be read', async () => {
    const { response } = await listWith(await freshStore({ failChecks: true }));
    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe('INTERNAL_ERROR');
    expect(response.body).not.toContain('could not be read');
    expect(response.headers['x-trace-id']).toBe(response.json().error.traceId);
  });
});

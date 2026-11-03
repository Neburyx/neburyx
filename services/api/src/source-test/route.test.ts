import { rmSync } from 'node:fs';
import pino from 'pino';
import { afterAll, describe, expect, it } from 'vitest';
import { buildOpenApiDocument, sourceTestReportSchema } from '@neburyx/contracts';
import { buildApp } from '../app.js';
import { mappingOf, sourceWith } from '../testing/gate-fixtures.js';
import { memoryAppStore } from '../testing/app-store.js';
import { TestExecutor } from '../testing/gate.js';
import { fakeSourceTester, SERVER_ROW, serverExecutor } from '../testing/source-tester.js';
import { makeWebRoot } from '../testing/web-root.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

const mapping = mappingOf(sourceWith('alpha'));

async function appWith(mappingModel = mapping) {
  const parts = fakeSourceTester(mappingModel);
  const app = await buildApp({ webRoot, logger: pino({ level: 'silent' }), store: memoryAppStore(), mapping: mappingModel, sourceTester: parts.tester });
  return { app, executor: parts.executor };
}

describe('POST /v1/sources/{id}/test', () => {
  it('answers 200 with a report that the schema accepts', async () => {
    const { app, executor } = await appWith();
    const response = await app.inject({ method: 'POST', url: '/v1/sources/alpha/test' });
    expect(response.statusCode).toBe(200);
    expect(sourceTestReportSchema.parse(response.json())).toMatchObject({ sourceId: 'alpha', outcome: 'pass', state: 'connected' });
    expect(executor.calls.map((call) => call.templateId)).toEqual(['capabilities', 'privileges', 'schema-tokens', 'schema-indexes', 'degree-probe', 'degree-probe', 'degree-probe']);
    await app.close();
  });

  it('answers 200 with the privileges facts: a login that can write is a warn with the fixed sentence, a read-only login is inspected', async () => {
    const write = fakeSourceTester(mapping, serverExecutor(undefined, { status: 'rows', rows: [{ access: 'GRANTED', action: 'write', resource: 'graph', graph: '*', segment: 'NODE(*)' }] }));
    const readOnly = fakeSourceTester(mapping, serverExecutor(undefined, { status: 'rows', rows: [] }));
    for (const [parts, expected] of [
      [write, { outcome: 'warn', state: 'degraded', stateReason: 'The login can write to the source; give Neburyx a login that can only read.', readOnlyCheck: 'privileges-inspected', loginCanWrite: true }],
      [readOnly, { outcome: 'pass', state: 'connected', stateReason: null, readOnlyCheck: 'privileges-inspected', loginCanWrite: false }],
    ] as const) {
      const app = await buildApp({ webRoot, logger: pino({ level: 'silent' }), store: parts.store, mapping, sourceTester: parts.tester });
      const response = await app.inject({ method: 'POST', url: '/v1/sources/alpha/test' });
      expect(response.statusCode).toBe(200);
      expect(sourceTestReportSchema.parse(response.json())).toMatchObject(expected);
      await app.close();
    }
  });

  it('answers 200 with a warn report for a server that reports an empty version', async () => {
    const parts = fakeSourceTester(mapping, serverExecutor({ status: 'rows', rows: [{ ...SERVER_ROW, version: '' }] }));
    const app = await buildApp({ webRoot, logger: pino({ level: 'silent' }), store: parts.store, mapping, sourceTester: parts.tester });
    const response = await app.inject({ method: 'POST', url: '/v1/sources/alpha/test' });
    expect(response.statusCode).toBe(200);
    expect(sourceTestReportSchema.parse(response.json())).toMatchObject({ outcome: 'warn', state: 'degraded', versionSupported: false, server: { version: '' } });
    expect(parts.store.checks).toHaveLength(1);
    await app.close();
  });

  it('answers NOT_FOUND for an id the mapping does not hold, with no read', async () => {
    const { app, executor } = await appWith();
    const response = await app.inject({ method: 'POST', url: '/v1/sources/absent/test' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    expect(executor.calls).toEqual([]);
    await app.close();
  });

  it('answers NOT_FOUND for any id when the mapping has no source', async () => {
    const { app, executor } = await appWith({ sources: [] });
    expect((await app.inject({ method: 'POST', url: '/v1/sources/alpha/test' })).statusCode).toBe(404);
    expect(executor.calls).toEqual([]);
    await app.close();
  });

  it.each([
    ['a JSON body', { payload: '{}', headers: { 'content-type': 'application/json' } }],
    ['a query string', { query: { limit: '1' } }],
    ['a body that names a write probe', { payload: '{"writeProbe":true}', headers: { 'content-type': 'application/json' } }],
    ['a body that names a write probe with a dash', { payload: '{"write-probe":true}', headers: { 'content-type': 'application/json' } }],
    ['a query string that names a write probe', { query: { writeProbe: 'true' } }],
    ['a query string that names a write probe with a dash', { query: { 'write-probe': '1' } }],
  ])('answers INVALID_REQUEST for %s, with no read', async (_name, extra) => {
    const { app, executor } = await appWith();
    const response = await app.inject({ method: 'POST', url: '/v1/sources/alpha/test', ...extra });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
    expect(executor.calls).toEqual([]);
    await app.close();
  });

  it('shows no body and no query parameter, and none that names a probe, in the OpenAPI document', () => {
    const operation: unknown = buildOpenApiDocument().paths['/v1/sources/{id}/test'];
    const text = JSON.stringify(operation);
    expect(operation).toMatchObject({ post: { parameters: [{ name: 'id', in: 'path' }] } });
    // the description may say the probe is out of reach; no parameter or body may name it
    expect(text).not.toMatch(/"name":"[^"]*probe/i);
    expect(text).not.toContain('requestBody');
    expect(text.match(/"in":/g)).toHaveLength(1);
  });

  it('answers INTERNAL_ERROR when the app was built without a tester', async () => {
    const app = await buildApp({ webRoot, logger: pino({ level: 'silent' }), store: memoryAppStore(), mapping });
    const response = await app.inject({ method: 'POST', url: '/v1/sources/alpha/test' });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
    await app.close();
  });
});

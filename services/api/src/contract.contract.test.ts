import { rmSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { createLogger } from './logger.js';
import { checkContract, checkErrorResponses, checkOperations, type ErrorCase } from './testing/contract-check.js';
import { loadCommittedDocument, parseDocument } from './testing/document.js';
import { registerErrorRoutes } from './testing/error-routes.js';
import { makeWebRoot } from './testing/web-root.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

async function app(): ReturnType<typeof buildApp> {
  return buildApp({ webRoot, logger: createLogger({ write: () => undefined }) });
}

function fixtureDocument(extraPaths: Record<string, unknown>): ReturnType<typeof parseDocument> {
  return parseDocument({
    paths: {
      '/v1/test/thing': {
        get: {
          responses: {
            '200': {
              content: {
                'application/json': {
                  schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } }, additionalProperties: false },
                },
              },
            },
          },
        },
      },
      ...extraPaths,
    },
    components: {
      schemas: {
        ErrorResponse: loadCommittedDocument().components.schemas['ErrorResponse'],
        Thing: { type: 'object', required: ['name'], properties: { name: { type: 'string' } }, additionalProperties: false },
      },
    },
  });
}

function referencing(schema: unknown): Record<string, unknown> {
  return {
    '/v1/test/ref': { get: { responses: { '200': { content: { 'application/json': { schema } } } } } },
  };
}

describe('a route that disagrees with its document', () => {
  it('is reported by name when the body does not match the schema', async () => {
    const server = await app();
    server.get('/v1/test/thing', async () => ({ name: 5 }));
    expect(await checkOperations(server, fixtureDocument({}))).toEqual([
      { route: 'GET /v1/test/thing', problem: 'the response does not match the document' },
    ]);
  });

  it('is reported by name when the status is not documented', async () => {
    const server = await app();
    server.get('/v1/test/thing', async (_request, reply) => reply.code(201).send({ name: 'x' }));
    expect(await checkOperations(server, fixtureDocument({}))).toEqual([
      { route: 'GET /v1/test/thing', problem: 'status 201 is not documented' },
    ]);
  });

  it('is reported by name when the route is not in the document at all', async () => {
    const server = await app();
    server.get('/v1/test/thing', async () => ({ name: 'x' }));
    server.get('/v1/test/extra', async () => ({ name: 'x' }));
    expect(await checkOperations(server, fixtureDocument({}))).toEqual([
      { route: 'GET /v1/test/extra', problem: 'the route is not in the document' },
    ]);
  });

  it('is reported when a documented operation with a path parameter has no example', async () => {
    const server = await app();
    server.get('/v1/test/thing', async () => ({ name: 'x' }));
    server.get('/v1/test/item/:id', async () => ({ name: 'x' }));
    const document = fixtureDocument({ '/v1/test/item/{id}': { get: { responses: { '200': {} } } } });
    expect(await checkOperations(server, document)).toEqual([
      { route: 'GET /v1/test/item/{id}', problem: 'the operation has no example request' },
    ]);
  });

  it('passes when the route matches its document', async () => {
    const server = await app();
    server.get('/v1/test/thing', async () => ({ name: 'x' }));
    expect(await checkOperations(server, fixtureDocument({}))).toEqual([]);
  });

  it('reports an error response that does not match ErrorResponse', async () => {
    const server = await app();
    server.get('/v1/test/bad-error', async (_request, reply) => reply.code(400).send({ statusCode: 400, error: 'Bad Request' }));
    expect(await checkErrorResponses(server, fixtureDocument({}), [{ method: 'GET', url: '/v1/test/bad-error' }])).toEqual([
      { route: 'GET /v1/test/bad-error', problem: 'the error response does not match ErrorResponse' },
    ]);
  });
});

describe('a document the check cannot trust', () => {
  it('follows a reference to a component schema, and reports a body that does not match it', async () => {
    const document = fixtureDocument(referencing({ $ref: '#/components/schemas/Thing' }));
    const good = await app();
    good.get('/v1/test/thing', async () => ({ name: 'x' }));
    good.get('/v1/test/ref', async () => ({ name: 'x' }));
    expect(await checkOperations(good, document)).toEqual([]);
    const bad = await app();
    bad.get('/v1/test/thing', async () => ({ name: 'x' }));
    bad.get('/v1/test/ref', async () => ({ name: 5 }));
    expect(await checkOperations(bad, document)).toEqual([
      { route: 'GET /v1/test/ref', problem: 'the response does not match the document' },
    ]);
  });

  it('reports a reference that cannot be resolved instead of passing', async () => {
    const server = await app();
    server.get('/v1/test/thing', async () => ({ name: 'x' }));
    server.get('/v1/test/ref', async () => ({ name: 'x' }));
    const failures = await checkOperations(server, fixtureDocument(referencing({ $ref: '#/components/schemas/Missing' })));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ route: 'GET /v1/test/ref' });
    expect(failures[0]?.problem).toContain('cannot be compiled');
  });

  it('reports a schema that uses a format it cannot check', async () => {
    const server = await app();
    server.get('/v1/test/thing', async () => ({ name: 'x' }));
    server.get('/v1/test/ref', async () => ({ name: 'x' }));
    const document = fixtureDocument(referencing({ $ref: '#/components/schemas/Email' }));
    document.components.schemas['Email'] = { type: 'object', properties: { name: { type: 'string', format: 'email' } } };
    expect(await checkOperations(server, document)).toEqual([
      { route: 'document', problem: 'the document uses a format the contract check cannot validate' },
    ]);
  });

  it('reports a response that is not JSON and a body the document does not describe', async () => {
    const server = await app();
    server.get('/v1/test/thing', async (_request, reply) => reply.type('text/plain').send('{"name":"x"}'));
    server.get('/v1/test/empty', async () => ({ unexpected: true }));
    const document = fixtureDocument({ '/v1/test/empty': { get: { responses: { '200': {} } } } });
    expect(await checkOperations(server, document)).toEqual([
      { route: 'GET /v1/test/thing', problem: 'the response is not JSON' },
      { route: 'GET /v1/test/empty', problem: 'the response has a body the document does not describe' },
    ]);
  });

  it('reports invalid JSON and a media type that only starts like JSON', async () => {
    const server = await app();
    server.get('/v1/test/thing', async (_request, reply) => reply.type('application/json').send('{not json'));
    server.get('/v1/test/ref', async (_request, reply) => reply.type('application/json-not-really').send('{"name":"x"}'));
    const document = fixtureDocument(referencing({}));
    expect(await checkOperations(server, document)).toEqual([
      { route: 'GET /v1/test/thing', problem: 'the response body is not valid JSON' },
      { route: 'GET /v1/test/ref', problem: 'the response is not JSON' },
    ]);
  });

  it('reports an undocumented explicit HEAD route, a GET documented only through HEAD, and a TRACE operation it cannot satisfy', async () => {
    const server = await app();
    server.get('/v1/test/thing', async () => ({ name: 'x' }));
    server.route({ method: 'HEAD', url: '/v1/test/head-only', handler: async () => '' });
    server.get('/v1/test/get-with-head-documented', async () => ({ name: 'x' }));
    server.route({ method: 'TRACE', url: '/v1/test/traced', handler: async () => ({ unexpected: true }) });
    const document = fixtureDocument({
      '/v1/test/get-with-head-documented': { head: { responses: { '200': {} } } },
      '/v1/test/traced': { trace: { responses: { '200': {} } } },
    });
    expect(await checkOperations(server, document)).toEqual([
      { route: 'TRACE /v1/test/traced', problem: 'the response has a body the document does not describe' },
      { route: 'HEAD /v1/test/head-only', problem: 'the route is not in the document' },
      { route: 'GET /v1/test/get-with-head-documented', problem: 'the route is not in the document' },
    ]);
  });

  it('reports an explicit HEAD declared in the same call as a GET', async () => {
    const server = await app();
    server.get('/v1/test/thing', async () => ({ name: 'x' }));
    server.route({ method: ['GET', 'HEAD'], url: '/v1/test/both', handler: async () => '' });
    const document = fixtureDocument({ '/v1/test/both': { get: { responses: { '200': {} } } } });
    expect(await checkOperations(server, document)).toEqual([
      { route: 'HEAD /v1/test/both', problem: 'the route is not in the document' },
    ]);
  });

  it('reports a path item reference instead of skipping it', async () => {
    const server = await app();
    server.get('/v1/test/thing', async () => ({ name: 'x' }));
    const document = fixtureDocument({ '/v1/test/shared': { $ref: '#/paths/~1v1~1test~1thing' } });
    expect(await checkOperations(server, document)).toEqual([
      { route: '/v1/test/shared', problem: 'a path item $ref is not supported by the contract check' },
    ]);
  });

  it('reports an unknown member of a path item', async () => {
    const server = await app();
    server.get('/v1/test/thing', async () => ({ name: 'x' }));
    const document = fixtureDocument({ '/v1/test/odd': { connect: { responses: {} }, 'x-note': 'fine' } });
    expect(await checkOperations(server, document)).toEqual([
      { route: '/v1/test/odd', problem: 'the path item has an unknown member connect' },
    ]);
  });

  it('reports a malformed operation', async () => {
    const server = await app();
    server.get('/v1/test/thing', async () => ({ name: 'x' }));
    const document = fixtureDocument({ '/v1/test/broken': { post: { responses: 'none' } } });
    expect(await checkOperations(server, document)).toEqual([
      { route: 'POST /v1/test/broken', problem: 'the operation is malformed in the document' },
    ]);
  });

  it('finds a route that a plugin registers', async () => {
    const server = await app();
    server.get('/v1/test/thing', async () => ({ name: 'x' }));
    await server.register(async (instance) => {
      instance.get('/v1/test/from-plugin', async () => ({ name: 'x' }));
    });
    expect(await checkOperations(server, fixtureDocument({}))).toEqual([
      { route: 'GET /v1/test/from-plugin', problem: 'the route is not in the document' },
    ]);
  });

  it('finds a plugin route even when the document has no operations at all', async () => {
    const server = await app();
    void server.register(async (instance) => {
      instance.get('/v1/test/from-plugin', async () => ({ name: 'x' }));
    });
    const empty = parseDocument({ paths: {}, components: { schemas: {} } });
    expect(await checkOperations(server, empty)).toEqual([
      { route: 'GET /v1/test/from-plugin', problem: 'the route is not in the document' },
    ]);
  });

  it('checks an explicitly documented HEAD or OPTIONS operation', async () => {
    const server = await app();
    server.get('/v1/test/thing', async () => ({ name: 'x' }));
    server.options('/v1/test/preflight', async () => ({ unexpected: true }));
    const document = fixtureDocument({ '/v1/test/preflight': { options: { responses: { '200': {} } } } });
    expect(await checkOperations(server, document)).toEqual([
      { route: 'OPTIONS /v1/test/preflight', problem: 'the response has a body the document does not describe' },
    ]);
  });

  it('reports an error body that is valid in shape but has the wrong status or the wrong trace ID', async () => {
    const server = await app();
    server.get('/v1/test/wrong-status', async (_request, reply) =>
      reply.code(500).header('x-trace-id', 'tr-1').send({ error: { code: 'NOT_FOUND', message: 'Not found.', retryable: false, traceId: 'tr-1' } }),
    );
    server.get('/v1/test/wrong-trace', async (_request, reply) =>
      reply.code(404).header('x-trace-id', 'tr-2').send({ error: { code: 'NOT_FOUND', message: 'Not found.', retryable: false, traceId: 'tr-1' } }),
    );
    expect(
      await checkErrorResponses(server, fixtureDocument({}), [
        { method: 'GET', url: '/v1/test/wrong-status' },
        { method: 'GET', url: '/v1/test/wrong-trace' },
      ]),
    ).toEqual([
      { route: 'GET /v1/test/wrong-status', problem: 'the status does not match the code' },
      { route: 'GET /v1/test/wrong-trace', problem: 'the traceId is not the X-Trace-Id header' },
    ]);
  });

  it('reports an error response that is not served as JSON', async () => {
    const server = await app();
    server.get('/v1/test/text-error', async (_request, reply) =>
      reply.code(404).type('text/plain').header('x-trace-id', 'tr-1').send(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not found.', retryable: false, traceId: 'tr-1' } })),
    );
    expect(await checkErrorResponses(server, fixtureDocument({}), [{ method: 'GET', url: '/v1/test/text-error' }])).toEqual([
      { route: 'GET /v1/test/text-error', problem: 'the error response does not match ErrorResponse' },
    ]);
  });

  it('reports an error body with a message or details that the code does not allow', async () => {
    const server = await app();
    server.get('/v1/test/leaky', async (_request, reply) =>
      reply.code(403).header('x-trace-id', 'tr-1').send({ error: { code: 'ACCESS_DENIED', message: 'MATCH (n) RETURN n', retryable: false, traceId: 'tr-1' } }),
    );
    server.get('/v1/test/foreign-details', async (_request, reply) =>
      reply.code(403).header('x-trace-id', 'tr-1').send({
        error: { code: 'ACCESS_DENIED', message: 'You do not have access to this.', retryable: false, traceId: 'tr-1', details: { maxPage: 50 } },
      }),
    );
    const failures = await checkErrorResponses(server, fixtureDocument({}), [
      { method: 'GET', url: '/v1/test/leaky' },
      { method: 'GET', url: '/v1/test/foreign-details' },
    ]);
    expect(failures.map((failure) => failure.route)).toEqual(['GET /v1/test/leaky', 'GET /v1/test/foreign-details']);
  });
});

describe('the running API against the committed openapi.json', () => {
  const productionCases: readonly ErrorCase[] = [
    { method: 'GET', url: '/v1/anything' },
    { method: 'GET', url: '/v1/entities/ACC-12345/%zz' },
    { method: 'POST', url: '/v1/anything', payload: '{}', headers: { 'content-type': 'application/json' } },
    { raw: 'GARBAGE\r\n\r\n' },
    { raw: 'POST /v1/anything HTTP/1.1\r\nhost: x\r\ncontent-type: application/json\r\ntransfer-encoding: chunked\r\n\r\nZZ\r\n' },
  ];

  it('matches for the operations it documents and for the errors it produces', async () => {
    expect(await checkContract(await app(), loadCommittedDocument(), productionCases)).toEqual([]);
  });

  it('matches for every error case of the error model, including thrown errors and framework failures', async () => {
    const server = await app();
    registerErrorRoutes(server);
    const cases: readonly ErrorCase[] = [
      { method: 'GET', url: '/v1/test/denied' },
      { method: 'GET', url: '/v1/test/leaky-app-error' },
      { method: 'GET', url: '/v1/test/leaky-error' },
      { method: 'GET', url: `/v1/test/details?code=RATE_LIMITED&details=${encodeURIComponent('{"retryAfterMs":2000}')}` },
      { method: 'GET', url: `/v1/test/details?code=QUERY_BUDGET_EXCEEDED&details=${encodeURIComponent('{"maxPage":50}')}` },
      { method: 'GET', url: `/v1/test/details?code=QUERY_BUDGET_EXCEEDED&details=${encodeURIComponent('{"maxPage":"50","query":"MATCH (n)"}')}` },
      { method: 'GET', url: `/v1/test/details?code=RATE_LIMITED&details=${encodeURIComponent('{"unknown":1}')}` },
      { method: 'POST', url: '/v1/test/echo', payload: '{"a":', headers: { 'content-type': 'application/json' } },
      { method: 'POST', url: '/v1/test/echo', payload: 'x', headers: { 'content-type': 'application/x-unsupported' } },
      { method: 'GET', url: '/v1/test/%zz' },
      ...productionCases,
    ];
    expect(await checkErrorResponses(server, loadCommittedDocument(), cases)).toEqual([]);
  });
});

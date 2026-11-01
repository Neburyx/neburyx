import { rmSync } from 'node:fs';
import pino from 'pino';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { APP_JS, INDEX_HTML, makeWebRoot, V1_FILE } from './testing/web-root.js';
import { LOCAL_IDENTITY, memoryAppStore } from './testing/app-store.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

async function app(): ReturnType<typeof buildApp> {
  return buildApp({ webRoot, logger: pino({ level: 'silent' }), store: memoryAppStore() });
}

describe('paths under /v1', () => {
  it.each(['/v1', '/v1/', '/v1/anything', '/v1/anything?x=1'])('answers %s with 404 JSON, not the page', async (url) => {
    const server = await app();
    const response = await server.inject({ method: 'GET', url });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.body).not.toContain('<!doctype');
    expect(JSON.parse(response.body)).toMatchObject({ error: { code: 'NOT_FOUND', retryable: false } });
  });

  it.each([
    ['GET', '/v1/secret.txt'],
    ['HEAD', '/v1/secret.txt'],
    ['GET', '/v1/'],
    ['GET', '/v1/index.html'],
    ['HEAD', '/v1/'],
    ['GET', '/v1//anything'],
    ['HEAD', '/v1//anything'],
  ])('does not serve a file from a v1 folder of the web build (%s %s)', async (method, url) => {
    const server = await app();
    const response = await server.inject({ method: method === 'HEAD' ? 'HEAD' : 'GET', url });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.body).not.toContain(V1_FILE);
  });

  it('answers a POST outside any route with 404 JSON', async () => {
    const server = await app();
    const response = await server.inject({ method: 'POST', url: '/investigations/abc' });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/json');
  });
});

describe('the web build', () => {
  it('serves index.html at /', async () => {
    const response = await (await app()).inject({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toBe(INDEX_HTML);
  });

  it('serves an existing asset with a JavaScript type', async () => {
    const response = await (await app()).inject({ method: 'GET', url: '/assets/app.js' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/javascript/);
    expect(response.body).toBe(APP_JS);
  });

  it('returns index.html for a client route that matches no file', async () => {
    const response = await (await app()).inject({ method: 'GET', url: '/investigations/abc' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(INDEX_HTML);
  });
});

describe('GET /v1/me', () => {
  it('answers with the identity the store holds', async () => {
    const response = await (await app()).inject({ method: 'GET', url: '/v1/me' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ...LOCAL_IDENTITY, sources: [] });
  });

  it.each(['HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const)('answers %s like any other unmatched /v1 route', async (method) => {
    const response = await (await app()).inject({ method, url: '/v1/me' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });
});

describe('GET /healthz', () => {
  it('answers 200 with exactly the ok status', async () => {
    const response = await (await app()).inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('answers 200 while every database call fails', async () => {
    const failing = { ...memoryAppStore(), current: () => Promise.reject(new Error('database down')) };
    const server = await buildApp({ webRoot, logger: pino({ level: 'silent' }), store: failing });
    const response = await server.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'] as const)('answers %s like any other unmatched path', async (method) => {
    const response = await (await app()).inject({ method, url: '/healthz' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });
});

describe('GET /readyz', () => {
  it('answers 200 ready when every check is ok', async () => {
    const response = await (await app()).inject({ method: 'GET', url: '/readyz' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ready', checks: { database: 'ok', migrations: 'ok' } });
  });

  it('answers 503 not_ready when the database check is not ok', async () => {
    const down = { ...memoryAppStore(), readiness: () => Promise.resolve({ database: 'unreachable' as const, migrations: 'unknown' as const }) };
    const server = await buildApp({ webRoot, logger: pino({ level: 'silent' }), store: down });
    const response = await server.inject({ method: 'GET', url: '/readyz' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'not_ready', checks: { database: 'unreachable', migrations: 'unknown' } });
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'] as const)('answers %s like any other unmatched path', async (method) => {
    const response = await (await app()).inject({ method, url: '/readyz' });
    expect(response.statusCode).toBe(404);
  });
});

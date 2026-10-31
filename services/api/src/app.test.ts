import { rmSync } from 'node:fs';
import pino from 'pino';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { APP_JS, INDEX_HTML, makeWebRoot, V1_FILE } from './test-support.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

async function app(): ReturnType<typeof buildApp> {
  return buildApp({ webRoot, logger: pino({ level: 'silent' }) });
}

describe('paths under /v1', () => {
  it.each(['/v1', '/v1/', '/v1/anything', '/v1/anything?x=1'])('answers %s with 404 JSON, not the page', async (url) => {
    const server = await app();
    const response = await server.inject({ method: 'GET', url });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.body).not.toContain('<!doctype');
    expect(JSON.parse(response.body)).toEqual({ statusCode: 404, error: 'Not Found' });
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


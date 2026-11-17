import { rmSync } from 'node:fs';
import pino from 'pino';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { LOCAL_IDENTITY, memoryAppStore } from './testing/app-store.js';
import { makeWebRoot } from './testing/web-root.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

const start = async () => {
  const store = memoryAppStore();
  const app = await buildApp({ webRoot, logger: pino({ level: 'silent' }), store });
  return { app, store };
};
type App = Awaited<ReturnType<typeof start>>['app'];
const put = (app: App, payload: unknown, url = '/v1/me/preferences', headers: Record<string, string> = { 'content-type': 'application/json' }) =>
  app.inject({ method: 'PUT', url, payload: typeof payload === 'string' ? payload : JSON.stringify(payload), headers });

describe('GET /v1/me/preferences', () => {
  it('answers an empty map for a user who has stored nothing', async () => {
    const { app } = await start();
    const response = await app.inject({ method: 'GET', url: '/v1/me/preferences' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ preferences: {} });
    await app.close();
  });

  it('refuses a query string with INVALID_REQUEST', async () => {
    const { app } = await start();
    const response = await app.inject({ method: 'GET', url: '/v1/me/preferences?user=other' });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_REQUEST');
    await app.close();
  });
});

describe('PUT /v1/me/preferences', () => {
  it('stores the tour and answers the whole map, which a later GET returns', async () => {
    const { app } = await start();
    const written = await put(app, { preferences: { tour: 'completed' } });
    expect(written.statusCode).toBe(200);
    expect(written.json()).toEqual({ preferences: { tour: 'completed' } });
    expect((await app.inject({ method: 'GET', url: '/v1/me/preferences' })).json()).toEqual({ preferences: { tour: 'completed' } });
    await app.close();
  });

  it('replaces a stored value and leaves it alone when the body names no key', async () => {
    const { app } = await start();
    await put(app, { preferences: { tour: 'skipped' } });
    expect((await put(app, { preferences: {} })).json()).toEqual({ preferences: { tour: 'skipped' } });
    expect((await put(app, { preferences: { tour: 'completed' } })).json()).toEqual({ preferences: { tour: 'completed' } });
    await app.close();
  });

  it.each([
    ['a key that is not in the closed list', { preferences: { density: 'compact' } }, '/v1/me/preferences'],
    ['a value that is not allowed for the tour', { preferences: { tour: 'seen' } }, '/v1/me/preferences'],
    ['an extra field beside preferences', { preferences: { tour: 'completed' }, other: 1 }, '/v1/me/preferences'],
    ['no preferences', {}, '/v1/me/preferences'],
    ['a null value', { preferences: { tour: null } }, '/v1/me/preferences'],
    ['a query string', { preferences: { tour: 'completed' } }, '/v1/me/preferences?x=1'],
  ])('refuses %s with 400 INVALID_REQUEST and stores nothing', async (_name, body, url) => {
    const { app } = await start();
    const response = await put(app, body, url);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_REQUEST');
    expect((await app.inject({ method: 'GET', url: '/v1/me/preferences' })).json()).toEqual({ preferences: {} });
    await app.close();
  });

  it.each([
    ['no body', undefined],
    ['a body that is not JSON', '{"preferences":'],
  ])('refuses %s with 400 INVALID_REQUEST and stores nothing', async (_name, payload) => {
    const { app } = await start();
    const response = await app.inject({ method: 'PUT', url: '/v1/me/preferences', ...(payload === undefined ? {} : { payload, headers: { 'content-type': 'application/json' } }) });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_REQUEST');
    expect((await app.inject({ method: 'GET', url: '/v1/me/preferences' })).json()).toEqual({ preferences: {} });
    await app.close();
  });
});

describe('the preferences of two users', () => {
  it('are kept apart: what one user stores another does not read', async () => {
    const { store } = await start();
    await store.writePreferences(LOCAL_IDENTITY.principal.id, { tour: 'completed' });
    expect(await store.readPreferences('0192f000-0000-7000-8000-0000000000ff')).toEqual({});
    expect(await store.readPreferences(LOCAL_IDENTITY.principal.id)).toEqual({ tour: 'completed' });
  });
});

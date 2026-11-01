import { rmSync } from 'node:fs';
import pino from 'pino';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp, registeredRoutesOf } from './app.js';
import { isRoutePermission, routesWithoutPermission } from './permissions.js';
import { memoryAppStore } from './testing/app-store.js';
import { makeWebRoot } from './testing/web-root.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

function app(): ReturnType<typeof buildApp> {
  return buildApp({ webRoot, logger: pino({ level: 'silent' }), store: memoryAppStore() });
}

describe('routesWithoutPermission', () => {
  it('names a route with no declaration and a route with an unknown one, and none with a known one', () => {
    const routes = [
      { method: 'GET', url: '/a', permission: undefined },
      { method: 'GET', url: '/b', permission: 'admin' },
      { method: 'GET', url: '/c', permission: true },
      { method: 'GET', url: '/d', permission: 'public' },
      { method: 'POST', url: '/e', permission: 'principal' },
    ];
    expect(routesWithoutPermission(routes).map((route) => route.url)).toEqual(['/a', '/b', '/c']);
  });

  it.each(['public', 'principal'])('accepts %s', (value) => {
    expect(isRoutePermission(value)).toBe(true);
  });

  it.each(['', 'Public', 'admin', 1, null, undefined])('does not accept %j', (value) => {
    expect(isRoutePermission(value)).toBe(false);
  });
});

describe('a route added without a permission declaration', () => {
  it.each([
    ['under /v1', '/v1/extra'],
    ['beside a probe path', '/healthz/deep'],
    ['at any other path', '/debug'],
  ])('%s is named by the check, and passes once it declares one', async (_where, url) => {
    const bare = await app();
    bare.get(url, async () => ({}));
    const missing = routesWithoutPermission(registeredRoutesOf(bare));
    expect(missing.map((route) => route.url)).toEqual(expect.arrayContaining([url]));
    expect(missing.every((route) => route.url === url)).toBe(true);
    expect(missing.map((route) => route.method)).toContain('GET');

    const declared = await app();
    declared.get(url, { config: { permission: 'public' } }, async () => ({}));
    expect(routesWithoutPermission(registeredRoutesOf(declared))).toEqual([]);
  });

  it('is named when a plugin with a prefix adds it, and passes once it declares one', async () => {
    const bare = await app();
    await bare.register(async (instance) => {
      instance.get('/inner', async () => ({}));
    }, { prefix: '/nested' });
    expect(routesWithoutPermission(registeredRoutesOf(bare)).map((route) => route.url)).toEqual(expect.arrayContaining(['/nested/inner']));

    const declared = await app();
    await declared.register(async (instance) => {
      instance.get('/inner', { config: { permission: 'principal' } }, async () => ({}));
    }, { prefix: '/nested' });
    expect(routesWithoutPermission(registeredRoutesOf(declared))).toEqual([]);
  });

  it('is named once per method when one definition has several methods', async () => {
    const bare = await app();
    bare.route({ method: ['GET', 'POST'], url: '/multi', handler: async () => ({}) });
    const named = routesWithoutPermission(registeredRoutesOf(bare)).filter((route) => route.url === '/multi');
    expect(named.map((route) => route.method)).toEqual(expect.arrayContaining(['GET', 'POST']));

    const declared = await app();
    declared.route({ method: ['GET', 'POST'], url: '/multi', config: { permission: 'public' }, handler: async () => ({}) });
    expect(routesWithoutPermission(registeredRoutesOf(declared))).toEqual([]);
  });

  it('is named when it declares a value the type does not know', async () => {
    const server = await app();
    // @ts-expect-error the type forbids an unknown permission; the check must catch one that gets past it
    server.get('/debug', { config: { permission: 'admin' } }, async () => ({}));
    expect(routesWithoutPermission(registeredRoutesOf(server)).map((route) => route.url)).toEqual(expect.arrayContaining(['/debug']));
  });
});

describe('the routes of the app', () => {
  it('each declare a known permission', async () => {
    expect(routesWithoutPermission(registeredRoutesOf(await app()))).toEqual([]);
  });

  it('declare public for the probes and principal for /v1/me', async () => {
    const declared = new Map(registeredRoutesOf(await app()).map((route) => [`${route.method} ${route.url}`, route.permission]));
    expect(declared.get('GET /healthz')).toBe('public');
    expect(declared.get('GET /readyz')).toBe('public');
    expect(declared.get('GET /v1/me')).toBe('principal');
  });

  it('leave out the web build file routes, which are public by construction', async () => {
    expect(registeredRoutesOf(await app()).some((route) => route.url.includes('*'))).toBe(false);
  });
});

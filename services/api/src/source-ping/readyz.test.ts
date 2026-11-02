import { rmSync } from 'node:fs';
import pino from 'pino';
import { afterAll, describe, expect, it } from 'vitest';
import { readyResponseSchema } from '@neburyx/contracts';
import { buildApp } from '../app.js';
import { memoryAppStore } from '../testing/app-store.js';
import { mappingOf, sourceWith } from '../testing/gate-fixtures.js';
import { TestExecutor } from '../testing/gate.js';
import { testSourceGate } from '../testing/source-gate.js';
import { makeWebRoot } from '../testing/web-root.js';
import { READINESS_LIMIT_MS } from '../health/readiness.js';
import { createReachabilityCache } from './cache.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

const mapping = mappingOf(sourceWith('alpha'), sourceWith('beta'), sourceWith('gamma'));
const ids = mapping.sources.map((source) => source.id);

async function appWith(cache = createReachabilityCache(ids), store = memoryAppStore()) {
  return buildApp({ webRoot, logger: pino({ level: 'silent' }), store, mapping, reachability: cache });
}

describe('GET /readyz', () => {
  it('shows one reachable, one unreachable and one unknown source beside the checks, with status 200', async () => {
    const cache = createReachabilityCache(ids);
    cache.set('alpha', 'reachable');
    cache.set('beta', 'unreachable');
    const app = await appWith(cache);
    const response = await app.inject({ method: 'GET', url: '/readyz' });
    expect(response.statusCode).toBe(200);
    expect(readyResponseSchema.parse(response.json())).toEqual({
      status: 'ready',
      checks: { database: 'ok', migrations: 'ok' },
      sources: { reachable: 1, unreachable: 1, unknown: 1 },
    });
    await app.close();
  });

  it('shows no source when the mapping has none', async () => {
    const app = await buildApp({ webRoot, logger: pino({ level: 'silent' }), store: memoryAppStore(), mapping: { sources: [] } });
    expect((await app.inject({ method: 'GET', url: '/readyz' })).json().sources).toEqual({ reachable: 0, unreachable: 0, unknown: 0 });
    await app.close();
  });

  it('counts every configured source as unknown when the app was built with no cache', async () => {
    const app = await buildApp({ webRoot, logger: pino({ level: 'silent' }), store: memoryAppStore(), mapping });
    expect((await app.inject({ method: 'GET', url: '/readyz' })).json().sources).toEqual({ reachable: 0, unreachable: 0, unknown: 3 });
    await app.close();
  });

  it('stays 200 and ready when every source is unreachable', async () => {
    const cache = createReachabilityCache(ids);
    for (const id of ids) cache.set(id, 'unreachable');
    const app = await appWith(cache);
    const response = await app.inject({ method: 'GET', url: '/readyz' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ready', sources: { reachable: 0, unreachable: 3, unknown: 0 } });
    await app.close();
  });

  it('is 503 for the database or the migrations only, with the same sources member', async () => {
    const cache = createReachabilityCache(ids);
    cache.set('alpha', 'reachable');
    const down = { ...memoryAppStore(), readiness: () => Promise.resolve({ database: 'unreachable' as const, migrations: 'unknown' as const }) };
    const pending = { ...memoryAppStore(), readiness: () => Promise.resolve({ database: 'ok' as const, migrations: 'pending' as const }) };
    for (const store of [down, pending]) {
      const app = await appWith(cache, store);
      const response = await app.inject({ method: 'GET', url: '/readyz' });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ status: 'not_ready', sources: { reachable: 1, unreachable: 0, unknown: 2 } });
      await app.close();
    }
  });

  it('names no source, address, reason or credential in the body', async () => {
    const cache = createReachabilityCache(ids);
    cache.set('beta', 'unreachable');
    const app = await appWith(cache);
    const text = (await app.inject({ method: 'GET', url: '/readyz' })).body;
    for (const word of ['alpha', 'beta', 'gamma', 'reached', 'graph.example.test', 'DEMO_']) expect(text).not.toContain(word);
    await app.close();
  });

  it('answers within the readiness limit and never calls the executor, while the gate is made to wait for a read slot that never comes', async () => {
    const executor = new TestExecutor();
    const parts = testSourceGate(mapping, { executor, seams: { ...testSourceGateSeams(), coordinator: { acquireRead: () => new Promise(() => undefined) } } });
    const held = parts.gate.run({ traceId: 'tr-held', principal: (await memoryAppStore().current()).principal, sourceId: 'alpha', templateId: 'capabilities', params: {}, limit: 1 });
    held.catch(() => undefined);
    const app = await appWith();
    const started = Date.now();
    const response = await app.inject({ method: 'GET', url: '/readyz' });
    expect(response.statusCode).toBe(200);
    expect(Date.now() - started).toBeLessThan(READINESS_LIMIT_MS);
    expect(executor.calls).toEqual([]);
    await app.close();
  });
});

function testSourceGateSeams() {
  return { policy: { authorizeSource: () => Promise.resolve({ allowed: true as const }) }, audit: { record: () => Promise.resolve() } };
}

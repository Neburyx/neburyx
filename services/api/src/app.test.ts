import { rmSync } from 'node:fs';
import Fastify from 'fastify';
import pino from 'pino';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp, seamsOf } from './app.js';
import {
  communityAudit,
  communityPolicy,
  communitySeams,
} from './seams/community-seams.js';
import type { AuditEvent, AuditSink, Coordinator, PolicyProvider, Seams } from './seams/seams.js';
import { APP_JS, INDEX_HTML, makeWebRoot, V1_FILE } from './testing/web-root.js';
import { connect } from 'node:net';
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
    expect(response.json()).toEqual({ status: 'ready', checks: { database: 'ok', migrations: 'ok' }, sources: { reachable: 0, unreachable: 0, unknown: 0 } });
  });

  it('answers 503 not_ready when the database check is not ok', async () => {
    const down = { ...memoryAppStore(), readiness: () => Promise.resolve({ database: 'unreachable' as const, migrations: 'unknown' as const }) };
    const server = await buildApp({ webRoot, logger: pino({ level: 'silent' }), store: down });
    const response = await server.inject({ method: 'GET', url: '/readyz' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'not_ready', checks: { database: 'unreachable', migrations: 'unknown' }, sources: { reachable: 0, unreachable: 0, unknown: 0 } });
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'] as const)('answers %s like any other unmatched path', async (method) => {
    const response = await (await app()).inject({ method, url: '/readyz' });
    expect(response.statusCode).toBe(404);
  });
});

describe('closing the app', () => {
  it('stops the job runner as soon as closing begins, while a request is still being answered, and before the store closes', async () => {
    const order: string[] = [];
    let requestEntered: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => (requestEntered = resolve));
    let runnerStopping: () => void = () => undefined;
    const stopping = new Promise<void>((resolve) => (runnerStopping = resolve));
    const store = {
      ...memoryAppStore(),
      current: () => {
        requestEntered();
        return new Promise<never>(() => undefined);
      },
      close: () => Promise.resolve(void order.push('store closed')),
    };
    const jobs = {
      stop: () => {
        order.push('jobs stopped');
        runnerStopping();
        return Promise.resolve();
      },
    };
    const server = await buildApp({ webRoot, logger: pino({ level: 'silent' }), store, jobs });
    await server.listen({ host: '127.0.0.1', port: 0 });
    const address = server.server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    const socket = connect(address.port, '127.0.0.1');
    socket.on('error', () => undefined);
    await new Promise<void>((resolve) => socket.once('connect', resolve));
    socket.write('GET /v1/me HTTP/1.1\r\nHost: localhost\r\n\r\n');
    await entered;

    const closing = server.close();
    await stopping;
    expect(order).toEqual(['jobs stopped']);
    server.server.closeAllConnections();
    await closing;
    expect(order).toEqual(['jobs stopped', 'store closed']);
    socket.destroy();
  });
});

describe('the seams', () => {
  const denyingPolicy: PolicyProvider = {
    authorizeSource: () => Promise.resolve({ allowed: false, reason: 'no grant for this source' }),
  };
  const event: AuditEvent = { actorId: 'actor-1', actorRole: null, action: 'graph.expand', result: 'success', traceId: 'tr-1' };
  const busyCoordinator: Coordinator = { acquireRead: () => Promise.resolve({ status: 'busy' }) };

  async function appWith(seams?: Seams): ReturnType<typeof buildApp> {
    return buildApp({ webRoot, logger: pino({ level: 'silent' }), store: memoryAppStore(), seams });
  }

  it('uses the three Community defaults when no seams are given, and still answers /v1/me', async () => {
    const server = await app();
    expect(seamsOf(server)).toMatchObject({ policy: communityPolicy, audit: communityAudit });
    expect(seamsOf(server).coordinator).toHaveProperty('inspect');
    const response = await server.inject({ method: 'GET', url: '/v1/me' });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ principal: { id: LOCAL_IDENTITY.principal.id }, edition: 'community' });
  });

  it('refuses to hand out seams for an app that buildApp did not build', () => {
    expect(() => seamsOf(Fastify())).toThrow('seamsOf was given an app that buildApp did not build');
  });

  it('hands out a stub policy provider, which gives its denial', async () => {
    const server = await appWith({ ...communitySeams(), policy: denyingPolicy });
    expect(seamsOf(server).policy).toBe(denyingPolicy);
    expect(await seamsOf(server).policy.authorizeSource({ principal: LOCAL_IDENTITY.principal, sourceId: 'source-a' })).toEqual({
      allowed: false,
      reason: 'no grant for this source',
    });
  });

  it('hands out a stub audit sink, which receives the event', async () => {
    const kept: AuditEvent[] = [];
    const recording: AuditSink = { record: (given) => Promise.resolve(void kept.push(given)) };
    const server = await appWith({ ...communitySeams(), audit: recording });
    expect(seamsOf(server).audit).toBe(recording);
    await seamsOf(server).audit.record(event);
    expect(kept).toEqual([event]);
  });

  it('lets the rejection of a stub audit sink reach the caller', async () => {
    const rejecting: AuditSink = { record: () => Promise.reject(new Error('audit store down')) };
    const server = await appWith({ ...communitySeams(), audit: rejecting });
    await expect(seamsOf(server).audit.record(event)).rejects.toThrow('audit store down');
  });

  it('hands out a stub coordinator, which answers busy', async () => {
    const server = await appWith({ ...communitySeams(), coordinator: busyCoordinator });
    expect(seamsOf(server).coordinator).toBe(busyCoordinator);
    expect(await seamsOf(server).coordinator.acquireRead({ principal: LOCAL_IDENTITY.principal, sourceId: 'source-a', limits: { userConcurrency: 2, sourceConcurrency: 32, queueWaitMs: 2000 }, role: 'data', leaseTtlMs: 15_000 })).toEqual({ status: 'busy' });
  });
});

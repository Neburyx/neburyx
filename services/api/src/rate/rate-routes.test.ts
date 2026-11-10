import { edgeRefSegmentOf } from '@neburyx/contracts';
import { rmSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp, registeredRoutesOf } from '../app.js';
import { createEntityReader } from '../entities/entity-reader.js';
import { ENTITY_LOAD_ID } from '../gate/templates/entity-load.js';
import { createSourceAccess } from '../investigations/source-access.js';
import { entityRows } from '../testing/entity-fixtures.js';
import { plainNode } from '../testing/normalize-fixtures.js';
import { createLogger } from '../logger.js';
import { parseMapping } from '../mapping/load.js';
import { communitySeams } from '../seams/community-seams.js';
import type { PolicyProvider } from '../seams/seams.js';
import { memoryAppStore } from '../testing/app-store.js';
import { TestExecutor } from '../testing/gate.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { onlineIndexesOf, schemaAnswer, withSchema } from '../testing/search-fixtures.js';
import { testSourceGate } from '../testing/source-gate.js';
import { makeWebRoot } from '../testing/web-root.js';
import { createSourceTester } from '../source-test/tester.js';
import { serverExecutor } from '../testing/source-tester.js';
import { createRequestLimiter } from './request-limiter.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

const LIMIT = 2;

const mapping = parseMapping(
  fileOf(baseSource({ id: 'demo', budgets: { requests_per_minute: LIMIT } }), baseSource({ id: 'secret', budgets: { requests_per_minute: LIMIT } }), baseSource({ id: 'plain' })),
  'neburyx.yaml',
);

const ref = { entityType: 'node_a', stableId: 'H-1' };
const element = (sourceId: string) => ({ sourceId, ...ref });

interface Call {
  readonly method: 'GET' | 'POST';
  readonly url: (sourceId: string) => string;
  readonly payload?: (sourceId: string) => unknown;
}

/** The ten routes that count, with a request each that passes the route's schema; what the source answers does not matter here. */
const COUNTED: Readonly<Record<string, Call>> = {
  'entity open': { method: 'GET', url: (s) => `/v1/entities/${s}/node_a/H-1` },
  'edge read': { method: 'GET', url: (s) => `/v1/edges/${edgeRefSegmentOf({ sourceId: s, type: 'LINKS', from: 'node_a', to: 'node_b', stableId: 'L-1' })}` },
  'aggregate edge read': { method: 'GET', url: (s) => `/v1/edges/${edgeRefSegmentOf({ sourceId: s, aggregate: { type: 'LINKS', from: { sourceId: s, entityType: 'node_a', stableId: 'H-1' }, to: { sourceId: s, entityType: 'node_b', stableId: 'H-2' } } })}` },
  'derived edge read': { method: 'GET', url: (s) => `/v1/edges/${edgeRefSegmentOf({ sourceId: s, derived: { ruleId: 'R', from: { sourceId: s, entityType: 'node_a', stableId: 'H-1' }, to: { sourceId: s, entityType: 'node_a', stableId: 'H-2' } } })}` },
  'entity lookup': { method: 'POST', url: () => '/v1/entities/lookup', payload: (s) => ({ sourceId: s, ref }) },
  search: { method: 'POST', url: () => '/v1/search/entities', payload: (s) => ({ sourceId: s, text: 'needle-text' }) },
  'search more': { method: 'POST', url: () => '/v1/search/entities/more', payload: (s) => ({ sourceId: s, text: 'needle-text', group: 'exact', cursor: 'x' }) },
  'degree preview': { method: 'POST', url: () => '/v1/graph/preview-expansion', payload: (s) => ({ sourceId: s, ref }) },
  'derived neighbors': { method: 'POST', url: () => '/v1/graph/derived-neighbors', payload: (s) => ({ sourceId: s, ref }) },
  coverage: { method: 'POST', url: () => '/v1/graph/coverage', payload: (s) => ({ sourceId: s, entities: [{ ref: element(s), loadedRelationships: 0, loadedQuality: 'exact' }] }) },
  expand: { method: 'POST', url: () => '/v1/graph/expand', payload: (s) => ({ sourceId: s, ref, neighborTypes: ['node_b'] }) },
  'read by references': { method: 'POST', url: () => '/v1/graph/read-refs', payload: (s) => ({ sourceId: s, entities: [element(s)] }) },
  'open investigation': { method: 'POST', url: () => '/v1/investigations', payload: (s) => ({ sourceId: s, entity: element(s) }) },
  'source test': { method: 'POST', url: (s) => `/v1/sources/${s}/test` },
};

const NOT_COUNTED: Readonly<Record<string, Call>> = {
  me: { method: 'GET', url: () => '/v1/me' },
  sources: { method: 'GET', url: () => '/v1/sources' },
  profile: { method: 'GET', url: (s) => `/v1/sources/${s}/profile` },
  'investigation list': { method: 'GET', url: () => '/v1/investigations' },
  'investigation read': { method: 'GET', url: () => '/v1/investigations/00000000-0000-4000-8000-000000000000' },
  healthz: { method: 'GET', url: () => '/healthz' },
  readyz: { method: 'GET', url: () => '/readyz' },
};

async function started(clock?: () => number, write: (line: string) => void = () => undefined, given?: TestExecutor) {
  const [source] = mapping.sources;
  if (source === undefined) throw new Error('the mapping has no source');
  const executor = given ?? new TestExecutor(withSchema(() => schemaAnswer(onlineIndexesOf(source)), () => Promise.resolve({ status: 'rows' as const, rows: [] })));
  const defaults = communitySeams();
  const policy: PolicyProvider = { authorizeSource: ({ sourceId }) => Promise.resolve(sourceId === 'secret' ? { allowed: false, reason: 'no' } : { allowed: true }) };
  const acquired: unknown[] = [];
  const audited: unknown[] = [];
  const coordinator = { acquireRead: (request: Parameters<typeof defaults.coordinator.acquireRead>[0]) => (acquired.push(request), defaults.coordinator.acquireRead(request)) };
  const audit = { record: (event: Parameters<typeof defaults.audit.record>[0]) => (audited.push(event), defaults.audit.record(event)) };
  const seams = { ...defaults, policy, coordinator, audit };
  const parts = testSourceGate(mapping, { executor, seams });
  const limiter = createRequestLimiter({ ...(clock === undefined ? {} : { clock }), startSweep: () => () => undefined });
  const sourceTester = { run: () => Promise.resolve({ sourceId: 'demo' } as never) };
  const app = await buildApp({ webRoot, logger: createLogger({ write }), store: memoryAppStore(), mapping, gate: parts.gate, seams, limiter, sourceTester });
  const send = (call: Call, sourceId: string) => app.inject({ method: call.method, url: call.url(sourceId), ...(call.payload === undefined ? {} : { payload: call.payload(sourceId) as object }) });
  return { app, executor, limiter, send, acquired, audited, parts, sourceTester };
}

describe.each(Object.entries(COUNTED))('the %s route', (_name, call) => {
  it('counts each request once, and answers RATE_LIMITED, with a Retry-After, to the one over the limit and reads nothing for it', async () => {
    let now = 5_000_000;
    const { app, executor, send, acquired, audited } = await started(() => now);
    for (let i = 0; i < LIMIT; i += 1) {
      expect((await send(call, 'demo')).statusCode).not.toBe(429);
      now += 1_000;
    }
    const readsBefore = executor.calls.length;
    const slotsBefore = acquired.length;
    const auditedBefore = audited.length;
    const refused = await send(call, 'demo');
    expect(refused.statusCode).toBe(429);
    const body = refused.json();
    expect(body).toMatchObject({ error: { code: 'RATE_LIMITED', retryable: true } });
    expect(body.error.details.retryAfterMs).toBe(60_000 - LIMIT * 1_000);
    expect(refused.headers['retry-after']).toBe(String(Math.ceil((60_000 - LIMIT * 1_000) / 1000)));
    expect(executor.calls.length).toBe(readsBefore);
    expect(acquired.length).toBe(slotsBefore);
    expect(audited.length).toBe(auditedBefore);
    now += body.error.details.retryAfterMs;
    expect((await send(call, 'demo')).statusCode).not.toBe(429);
    await app.close();
  });

  it('answers NOT_FOUND, uncounted, for a source the person may not read and for one that is not configured', async () => {
    const { app, limiter, send } = await started();
    const statuses = new Set<number>();
    const bodies = new Set<string>();
    for (const sourceId of ['secret', 'nowhere']) {
      for (let i = 0; i < LIMIT * 3; i += 1) {
        const answer = await send(call, sourceId);
        statuses.add(answer.statusCode);
        bodies.add(answer.json().error.code);
      }
    }
    expect([...statuses]).toEqual([404]);
    expect([...bodies]).toEqual(['NOT_FOUND']);
    expect(limiter.inspect().size).toBe(0);
    await app.close();
  });
});

describe('requests that are not counted', () => {
  it.each(Object.entries(NOT_COUNTED))('the %s route is never refused and never counted', async (_name, call) => {
    const { app, limiter, send } = await started();
    for (let i = 0; i < LIMIT * 4; i += 1) expect((await send(call, 'demo')).statusCode).not.toBe(429);
    expect(limiter.inspect().size).toBe(0);
    await app.close();
  });

  it('a malformed body answers INVALID_REQUEST over the limit and is not counted', async () => {
    const { app, limiter, send } = await started();
    for (let i = 0; i < LIMIT * 3; i += 1) {
      const answer = await app.inject({ method: 'POST', url: '/v1/graph/expand', payload: { sourceId: 'demo' } });
      expect(answer.json().error.code).toBe('INVALID_REQUEST');
    }
    expect(limiter.inspect().size).toBe(0);
    await send(COUNTED['expand'] as Call, 'demo');
    expect(limiter.inspect().size).toBe(1);
    await app.close();
  });

  it('a request the service refuses after the access check (an unknown type) is counted', async () => {
    const { app, limiter } = await started();
    const answer = await app.inject({ method: 'POST', url: '/v1/graph/preview-expansion', payload: { sourceId: 'demo', ref: { entityType: 'nothing', stableId: 'x' } } });
    expect(answer.statusCode).toBe(404);
    expect([...limiter.inspect().values()]).toEqual([1]);
    await app.close();
  });

  it('counts a request that passes the schema and is refused by the gate\'s own validation (a cursor that is not one)', async () => {
    const { app, limiter } = await started();
    const answer = await app.inject({ method: 'POST', url: '/v1/search/entities/more', payload: { sourceId: 'demo', text: 'needle-text', group: 'exact', cursor: 'not-a-cursor' } });
    expect(answer.statusCode).toBeGreaterThanOrEqual(400);
    expect(answer.statusCode).not.toBe(429);
    expect([...limiter.inspect().values()]).toEqual([1]);
    await app.close();
  });

  it('never counts the capabilities check of a source, which reads it many times through the same gate as the routes', async () => {
    const { app, limiter, send, executor, parts } = await started(undefined, undefined, serverExecutor());
    const tester = createSourceTester({ gate: parts.gate, mapping, store: memoryAppStore(), clock: () => Date.UTC(2026, 10, 2, 10, 0, 0) });
    const principal = (await memoryAppStore().current()).principal;
    const before = executor.calls.length;
    for (let i = 0; i < LIMIT * 3; i += 1) await tester.run({ traceId: `tr-${i}`, principal, sourceId: 'demo' });
    expect(executor.calls.length).toBeGreaterThan(before + LIMIT * 3);
    expect(limiter.inspect().size).toBe(0);
    expect((await send(COUNTED['search'] as Call, 'demo')).statusCode).not.toBe(429);
    await app.close();
  });

  it('answers INTERNAL_ERROR and reads nothing when the limiter cannot tell the time', async () => {
    const { app, executor, send } = await started(() => {
      throw new Error('no clock');
    });
    const answer = await send(COUNTED['expand'] as Call, 'demo');
    expect(answer.statusCode).toBe(500);
    expect(answer.json().error.code).toBe('INTERNAL_ERROR');
    expect(executor.calls.filter((call) => call.templateId !== 'schema-tokens' && call.templateId !== 'schema-indexes')).toHaveLength(0);
    await app.close();
  });

  it('logs a refusal at info with its trace ID, source and wait, and no value of the request', async () => {
    const lines: string[] = [];
    const { app, send } = await started(undefined, (line) => void lines.push(line));
    const call = COUNTED['search'] as Call;
    for (let i = 0; i <= LIMIT; i += 1) await send(call, 'demo');
    const entry = lines.map((line) => JSON.parse(line) as Record<string, unknown>).find((each) => each['event'] === 'request.rate_limited');
    expect(entry).toMatchObject({ level: 30, sourceId: 'demo', retryAfterMs: expect.any(Number) as number });
    expect(entry?.['traceId']).toMatch(/^tr-/);
    expect(lines.join('\n')).not.toContain('needle-text');
    await app.close();
  });

  it('a source with no setting is paced at 120 a minute', async () => {
    const { app, send } = await started();
    const call = COUNTED['search'] as Call;
    for (let i = 0; i < 120; i += 1) expect((await send(call, 'plain')).statusCode).not.toBe(429);
    expect((await send(call, 'plain')).statusCode).toBe(429);
    await app.close();
  });
});

describe('the rate flag', () => {
  it('is a field of the access call only: the gate request, and so the read, is the same with it and without it', async () => {
    const [source] = mapping.sources;
    if (source === undefined) throw new Error('the mapping has no source');
    const row = entityRows(plainNode(['NodeA'], { id: 'H-1' }));
    const executor = new TestExecutor(withSchema(() => schemaAnswer(onlineIndexesOf(source)), () => Promise.resolve(row)));
    const parts = testSourceGate(mapping, { executor });
    const access = createSourceAccess({ mapping, seams: communitySeams(), logger: { warn: () => undefined }, limiter: createRequestLimiter({ startSweep: () => () => undefined }) });
    const reader = createEntityReader({ gate: parts.gate, mapping, access });
    const request = { traceId: 'tr-1', principal: (await memoryAppStore().current()).principal, sourceId: 'demo', entityType: 'node_a', stableId: 'H-1', mask: false };
    await reader.read(request);
    await reader.read({ ...request, rate: 'count' });
    const loads = executor.calls.filter((call) => call.templateId === ENTITY_LOAD_ID);
    expect(loads).toHaveLength(2);
    const plain = ({ onClosed: _onClosed, deadlineAt: _deadlineAt, ...rest }: (typeof loads)[number]) => rest;
    expect(plain(loads[1] as (typeof loads)[number])).toEqual(plain(loads[0] as (typeof loads)[number]));
  });
});

const COUNTED_ROUTES = [
  'GET /v1/entities/:sourceId/:entityType/:stableId',
  'POST /v1/entities/lookup',
  'GET /v1/edges/:ref',
  'GET /v1/source-links/:ref',
  'POST /v1/search/entities',
  'POST /v1/search/entities/more',
  'POST /v1/graph/preview-expansion',
  'POST /v1/graph/derived-neighbors',
  'POST /v1/graph/coverage',
  'POST /v1/graph/read-refs',
  'POST /v1/graph/expand',
  'POST /v1/investigations',
  'POST /v1/sources/:id/test',
];
const UNCOUNTED_ROUTES = ['GET /v1/me', 'GET /v1/sources', 'GET /v1/sources/:id/profile', 'GET /v1/investigations', 'GET /v1/investigations/:id', 'PUT /v1/investigations/:id/draft', 'PUT /v1/investigations/:id', 'POST /v1/investigations/:id/status', 'GET /healthz', 'GET /readyz'];

describe('every route has a decision', () => {
  it('is either counted or on the list of routes that read no source, so a new route cannot be left out', async () => {
    const { app } = await started();
    const routes = registeredRoutesOf(app)
      .filter((route) => route.method !== 'HEAD' && (route.url.startsWith('/v1') || route.url === '/healthz' || route.url === '/readyz'))
      .map((route) => `${route.method} ${route.url}`);
    expect(routes.length).toBeGreaterThan(0);
    for (const route of routes) expect([...COUNTED_ROUTES, ...UNCOUNTED_ROUTES], route).toContain(route);
    for (const route of COUNTED_ROUTES) expect(routes, route).toContain(route);
    await app.close();
  });
});

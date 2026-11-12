import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../errors.js';
import { assembleGate } from '../gate/assemble.js';
import { DEFAULT_BUDGETS } from '../gate/budgets.js';
import { SYSTEM_PRINCIPAL } from '../gate/system-principal.js';
import type { SystemRunner } from '../gate/types.js';
import { communitySeams } from '../seams/community-seams.js';
import type { Principal } from '../seams/seams.js';
import { createNeo4jExecutor } from '../sources/executor.js';
import { fakeDrivers } from '../testing/fake-source-driver.js';
import { auditing, mappingOf, sourceWith } from '../testing/gate-fixtures.js';
import { gateRequest, LOCAL_PRINCIPAL, TestExecutor } from '../testing/gate.js';
import { testSourceGate } from '../testing/source-gate.js';
import { SERVER_ROW } from '../testing/source-tester.js';
import { createReachabilityCache } from './cache.js';
import { createScheduledPing } from './ping.js';

const mapping = mappingOf(sourceWith('alpha'), sourceWith('beta'));
const ids = mapping.sources.map((source) => source.id);
const answering = () => new TestExecutor(() => Promise.resolve({ status: 'rows', rows: [SERVER_ROW] }));

function pingOver(executor: TestExecutor, seams = auditing().seams, mappingModel = mapping) {
  const parts = testSourceGate(mappingModel, { executor, seams });
  const cache = createReachabilityCache(mappingModel.sources.map((source) => source.id));
  return { ping: createScheduledPing({ system: parts.system, mapping: mappingModel, cache, clock: () => 1234 }), cache, ...parts };
}

describe('one run of the ping', () => {
  it('asks every source at once for the connectivity template through the system runner, as the system principal, and caches reachable', async () => {
    const seen: Principal[] = [];
    const arrived: string[] = [];
    const waiting: (() => void)[] = [];
    const executor = new TestExecutor(
      (call) =>
        new Promise((resolve) => {
          arrived.push(call.sourceId);
          waiting.push(() => resolve({ status: 'rows', rows: [SERVER_ROW] }));
          if (waiting.length === 2) for (const release of waiting) release();
        }),
    );
    const coordinator = { acquireRead: (request: { principal: Principal }) => (seen.push(request.principal), Promise.resolve({ status: 'granted' as const, lease: { release: () => Promise.resolve() } })) };
    const { ping, cache } = pingOver(executor, { ...auditing().seams, coordinator });
    const results = await ping.run();
    expect(arrived.sort()).toEqual(['alpha', 'beta']);
    expect(executor.calls.map((call) => [call.sourceId, call.templateId, call.rowLimit])).toEqual(expect.arrayContaining([['alpha', 'connectivity', 2], ['beta', 'connectivity', 2]]));
    expect(seen).toEqual([SYSTEM_PRINCIPAL, SYSTEM_PRINCIPAL]);
    expect(results.map((result) => [result.sourceId, result.current, result.skipped])).toEqual([['alpha', 'reachable', false], ['beta', 'reachable', false]]);
    expect(cache.get('alpha')).toBe('reachable');
  });

  it.each([
    ['unreachable', { status: 'unavailable', reason: 'unreachable' } as const, 'The source could not be reached.'],
    ['authentication', { status: 'unavailable', reason: 'authentication' } as const, 'The source refused the sign-in.'],
    ['credentials', { status: 'unavailable', reason: 'credentials' } as const, 'The credentials named in the mapping are not set.'],
    ['database', { status: 'unavailable', reason: 'database' } as const, 'The database named in the mapping does not exist on the server.'],
    ['refused', { status: 'unavailable', reason: 'refused' } as const, 'The source refused the read.'],
    ['a timeout', { status: 'timeout' } as const, 'The source did not answer in time.'],
  ])('caches unreachable with the fixed sentence for %s', async (_name, outcome, sentence) => {
    const { ping, cache } = pingOver(new TestExecutor(() => Promise.resolve(outcome)));
    const results = await ping.run();
    expect(results.map((result) => [result.current, result.reason, result.skipped])).toEqual([['unreachable', sentence, false], ['unreachable', sentence, false]]);
    expect(results.map((result) => [result.failure, result.cause])).toEqual([[_name === 'a timeout' ? 'timeout' : _name, null], [_name === 'a timeout' ? 'timeout' : _name, null]]);
    expect(cache.get('beta')).toBe('unreachable');
  });

  it('marks a source as recovered only when it goes from unreachable or unknown to reachable', async () => {
    let answers = false;
    const executor = new TestExecutor(() => Promise.resolve(answers ? { status: 'rows', rows: [SERVER_ROW] } : { status: 'unavailable', reason: 'unreachable' }));
    const { ping, cache } = pingOver(executor);
    expect((await ping.run()).map((result) => result.recovered)).toEqual([false, false]);
    answers = true;
    expect((await ping.run()).map((result) => [result.previous, result.current, result.recovered])).toEqual([['unreachable', 'reachable', true], ['unreachable', 'reachable', true]]);
    expect((await ping.run()).map((result) => result.recovered)).toEqual([false, false]);
    cache.set('alpha', 'unknown');
    expect((await ping.run()).map((result) => result.recovered)).toEqual([true, false]);
  });
});

describe('a run that says nothing about the source', () => {
  const SKIPPED: readonly (readonly [string, () => ReturnType<typeof pingOver>])[] = [
    ['a busy coordinator', () => pingOver(answering(), { ...auditing().seams, coordinator: { acquireRead: () => Promise.resolve({ status: 'busy' }) } })],
    ['a coordinator that refuses admission', () => pingOver(answering(), { ...auditing().seams, coordinator: { acquireRead: () => Promise.resolve({ status: 'unavailable' }) } })],
    ['an open breaker', () => pingOver(answering(), { ...auditing().seams, coordinator: { acquireRead: () => Promise.resolve({ status: 'unavailable', reason: 'repeated-timeouts', retryAfterMs: 20_000 }) } })],
    ['a full pool', () => pingOver(new TestExecutor(() => Promise.resolve({ status: 'unavailable', reason: 'pool-full' })))],
    ['a closed executor', () => pingOver(new TestExecutor(() => Promise.resolve({ status: 'unavailable', reason: 'closed' })))],
    ['an executor that throws', () => pingOver(new TestExecutor(() => Promise.reject(new Error('boom'))))],
  ];

  it.each(SKIPPED)('%s leaves the cache as it was, counts a skipped ping and throws nothing', async (_name, make) => {
    const { ping, cache } = make();
    cache.set('alpha', 'reachable');
    const results = await ping.run();
    expect(results.every((result) => result.skipped && !result.recovered)).toBe(true);
    expect(cache.get('alpha')).toBe('reachable');
    expect(results.every((result) => result.cause !== null && result.failure === null && !result.cause.includes('boom'))).toBe(true);
    expect(cache.get('beta')).toBe('unknown');
    expect(ping.metrics.snapshot()['alpha']).toEqual({ attempts: 1, reachable: 0, unreachable: 0, skipped: 1 });
  });

  it.each([
    ['ACCESS_DENIED', 'ACCESS_DENIED'],
    ['NOT_FOUND', 'NOT_FOUND'],
    ['INTERNAL_ERROR', 'INTERNAL_ERROR'],
  ] as const)('%s from the runner is skipped', async (_name, code) => {
    const system: SystemRunner = { run: () => Promise.reject(new AppError(code)) };
    const cache = createReachabilityCache(ids);
    const results = await createScheduledPing({ system, mapping, cache }).run();
    expect(results.every((result) => result.skipped)).toBe(true);
    expect(cache.counts()).toEqual({ reachable: 0, unreachable: 0, unknown: 2 });
    expect(results.map((result) => result.cause)).toEqual([code, code]);
  });
});

describe('the audit log', () => {
  it('receives no event from a ping that is reachable, unreachable, timed out, skipped, or for a source the gate does not know', async () => {
    const outcomes = [
      { status: 'rows', rows: [SERVER_ROW] },
      { status: 'unavailable', reason: 'unreachable' },
      { status: 'timeout' },
      { status: 'unavailable', reason: 'pool-full' },
    ] as const;
    for (const outcome of outcomes) {
      const recording = auditing();
      const { ping } = pingOver(new TestExecutor(() => Promise.resolve(outcome)), recording.seams);
      await ping.run();
      expect(recording.events).toEqual([]);
    }
    const recording = auditing();
    const parts = testSourceGate(mappingOf(sourceWith('alpha')), { executor: answering(), seams: recording.seams });
    const cache = createReachabilityCache(['alpha', 'ghost']);
    const ghostMapping = { sources: [...mapping.sources.slice(0, 1), ...mappingOf(sourceWith('ghost')).sources] };
    const results = await createScheduledPing({ system: parts.system, mapping: ghostMapping, cache }).run();
    expect(results.map((result) => [result.sourceId, result.skipped])).toEqual([['alpha', false], ['ghost', true]]);
    expect(recording.events).toEqual([]);
  });

  it('still receives an event for a user run of the connectivity template and for the system run of another template', async () => {
    const recording = auditing();
    const { gate, system } = pingOver(answering(), recording.seams);
    await gate.run(gateRequest({ sourceId: 'alpha', templateId: 'connectivity', params: {}, limit: 1 }));
    await system.run({ traceId: 'tr-x', sourceId: 'alpha', templateId: 'capabilities', params: {}, limit: 1 });
    expect(recording.events.map((event) => [event.actorId === LOCAL_PRINCIPAL.id ? 'user' : 'system', event.action])).toEqual([
      ['user', 'source.connectivity'],
      ['system', 'source.capabilities'],
    ]);
  });
});

describe('the counters', () => {
  it('hold per source the attempts, reachable, unreachable and skipped pings', async () => {
    const outcomes = [{ status: 'rows', rows: [SERVER_ROW] }, { status: 'unavailable', reason: 'unreachable' }, { status: 'unavailable', reason: 'pool-full' }] as const;
    let index = 0;
    const executor = new TestExecutor((call) => Promise.resolve(call.sourceId === 'alpha' ? (outcomes[index++ % 3] ?? outcomes[0]) : { status: 'rows' as const, rows: [SERVER_ROW] }));
    const { ping } = pingOver(executor);
    await ping.run();
    await ping.run();
    await ping.run();
    expect(ping.metrics.snapshot()).toEqual({
      alpha: { attempts: 3, reachable: 1, unreachable: 1, skipped: 1 },
      beta: { attempts: 3, reachable: 3, unreachable: 0, skipped: 0 },
    });
  });
});

describe('a source that never answers', () => {
  it('is unreachable with the timeout sentence after one gate deadline', async () => {
    const fake = fakeDrivers({ beginHang: true });
    const executor = createNeo4jExecutor({ sources: mapping.sources, env: { DEMO_USER: 'u', DEMO_PASSWORD: 'p' }, logger: { warn: () => undefined }, createDriver: fake.factory });
    const defaults = communitySeams();
    const parts = assembleGate({ mapping, seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit: defaults.audit }, executor, logger: { warn: () => undefined } });
    const cache = createReachabilityCache(ids);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const running = createScheduledPing({ system: parts.system, mapping, cache }).run();
      await vi.advanceTimersByTimeAsync(DEFAULT_BUDGETS.requestTimeoutMs);
      const results = await running;
      expect(results.map((result) => [result.current, result.reason])).toEqual([['unreachable', 'The source did not answer in time.'], ['unreachable', 'The source did not answer in time.']]);
    } finally {
      vi.useRealTimers();
      await executor.close();
    }
  });
});

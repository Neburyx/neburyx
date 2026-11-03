import { describe, expect, it } from 'vitest';
import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';
import type { PingResult } from '../source-ping/ping.js';
import { memoryAppStore } from '../testing/app-store.js';
import { mappingOf, sourceWith } from '../testing/gate-fixtures.js';
import { fittingSchemaAnswer, SERVER_ROW, serverExecutor } from '../testing/source-tester.js';
import { testSourceGate } from '../testing/source-gate.js';
import { createFirstContact, MAX_BACKOFF_MS } from './first-contact.js';
import { createUsabilityRecord } from './usability.js';

const mapping = mappingOf(sourceWith('alpha'), sourceWith('beta'));
const INTERVAL = 30_000;
const clock = () => Date.UTC(2026, 10, 2, 10, 0, 0);
const reachable = (sourceId: string, overrides: Partial<PingResult> = {}): PingResult => ({ sourceId, previous: 'unknown', current: 'reachable', reason: null, skipped: false, recovered: true, startedAt: 1_000, ...overrides });

function rig(options: { readonly capabilities?: (call: ExecuteCall) => ExecuteOutcome | Promise<ExecuteOutcome>; readonly schema?: (call: ExecuteCall) => ExecuteOutcome } = {}) {
  const store = memoryAppStore();
  const record = createUsabilityRecord();
  const logs: object[] = [];
  const executor = serverExecutor(options.capabilities ?? { status: 'rows', rows: [SERVER_ROW] }, { status: 'unavailable', reason: 'refused' }, options.schema ?? fittingSchemaAnswer);
  const parts = testSourceGate(mapping, { executor });
  // what start.ts does: a check that is stored sets the record
  const observing = {
    ...store,
    recordSourceCheck: async (check: Parameters<typeof store.recordSourceCheck>[0]) => {
      await store.recordSourceCheck(check);
      record.observe(check.report);
    },
  };
  const contact = createFirstContact({ system: parts.system, mapping, store: observing, record, clock, logger: { warn: (fields) => void logs.push(fields) }, intervalMs: INTERVAL });
  return { contact, store, record, logs, executor };
}

const states = async (store: ReturnType<typeof memoryAppStore>) => (await store.listSources()).map((row) => [row.id, row.state]);
const noWait = async () => new Promise((resolve) => setImmediate(resolve));

describe('the check on first contact', () => {
  it('runs the whole check for a source that answered and has none, stores its report and makes the source usable', async () => {
    const { contact, store, record, executor } = rig();
    await store.syncSources(mapping.sources);
    contact.afterTick([reachable('alpha')]);
    await contact.drain();
    expect(record.verdictOf('alpha')).toBe('usable');
    expect(record.verdictOf('beta')).toBe('unchecked');
    expect(store.checks.map((check) => [check.report.sourceId, check.triggeredBy, check.report.mappingChecks.status])).toEqual([['alpha', null, 'pass']]);
    expect(executor.calls.map((call) => call.templateId)).toEqual(['capabilities', 'privileges', 'schema-tokens', 'schema-indexes', 'degree-probe', 'degree-probe', 'degree-probe']);
    expect(await states(store)).toEqual([['alpha', 'connected'], ['beta', 'unknown']]);
  });

  it('leaves a source whose mapping fails unusable and unavailable with the reason, and does not check it again on the ticks that follow', async () => {
    const { contact, store, record, executor } = rig({ schema: (call) => (call.templateId === 'schema-tokens' ? { status: 'rows', rows: [{ labels: [], types: [] }] } : fittingSchemaAnswer(call)) });
    await store.syncSources(mapping.sources);
    contact.afterTick([reachable('alpha')]);
    await contact.drain();
    expect(record.verdictOf('alpha')).toBe('unusable');
    expect((await store.listSources())[0]).toMatchObject({ id: 'alpha', state: 'unavailable' });
    const before = executor.calls.length;
    for (let tick = 0; tick < 3; tick += 1) contact.afterTick([reachable('alpha', { recovered: false, previous: 'reachable' })]);
    await contact.drain();
    expect(executor.calls).toHaveLength(before);
  });

  it('runs nothing for a ping that did not answer, nor for a skipped one, nor for a source that already has a verdict', async () => {
    const { contact, record, executor } = rig();
    record.observe({ sourceId: 'beta', checkedAt: '2026-11-02T10:00:00.000Z', server: { product: 'Neo4j Kernel', version: '5.26.32', edition: 'community' }, mappingChecks: { status: 'pass', findings: [] } });
    contact.afterTick([reachable('alpha', { current: 'unreachable', reason: 'x' }), reachable('alpha', { skipped: true }), reachable('beta')]);
    await contact.drain();
    expect(executor.calls).toEqual([]);
  });

  it('answers at once, before the check ends, so the pings of the other sources are not held', async () => {
    let release: (() => void) | undefined;
    const held = new Promise<ExecuteOutcome>((resolve) => (release = () => resolve({ status: 'rows', rows: [SERVER_ROW] })));
    const { contact, record } = rig({ capabilities: () => held });
    contact.afterTick([reachable('alpha')]);
    await noWait();
    expect(record.verdictOf('alpha')).toBe('unchecked');
    release?.();
    await contact.drain();
    expect(record.verdictOf('alpha')).toBe('usable');
  });

  it('starts no second check for a source while one is running, and waits for the one that is when drained', async () => {
    let release: (() => void) | undefined;
    let started = 0;
    const held = new Promise<ExecuteOutcome>((resolve) => (release = () => resolve({ status: 'rows', rows: [SERVER_ROW] })));
    const { contact } = rig({ capabilities: () => ((started += 1), held) });
    contact.afterTick([reachable('alpha')]);
    contact.afterTick([reachable('alpha')]);
    contact.afterTick([reachable('alpha')]);
    await noWait();
    expect(started).toBe(1);
    let drained = false;
    const draining = contact.drain().then(() => (drained = true));
    await noWait();
    expect(drained).toBe(false);
    release?.();
    await draining;
    expect(drained).toBe(true);
  });

  it('starts no check once stopped', async () => {
    const { contact, executor } = rig();
    contact.stop();
    contact.afterTick([reachable('alpha')]);
    await contact.drain();
    expect(executor.calls).toEqual([]);
  });

  it('checks a source with a server version outside the matrix once, as not run, and makes it usable and degraded', async () => {
    const { contact, store, record } = rig({ capabilities: { status: 'rows', rows: [{ ...SERVER_ROW, version: '4.4.0' }] } as unknown as () => ExecuteOutcome });
    await store.syncSources(mapping.sources);
    contact.afterTick([reachable('alpha')]);
    await contact.drain();
    expect(store.checks[0]?.report).toMatchObject({ outcome: 'warn', mappingChecks: { status: 'not-run' } });
    expect(record.verdictOf('alpha')).toBe('usable');
    expect((await store.listSources())[0]).toMatchObject({ state: 'degraded' });
  });
});

describe('a check that does not settle', () => {
  const busy = (): ExecuteOutcome => ({ status: 'unavailable', reason: 'pool-full' });

  it('stores nothing, changes no state, is logged once with the source id, and leaves the source unchecked', async () => {
    const { contact, store, record, logs } = rig({ capabilities: busy });
    await store.syncSources(mapping.sources);
    contact.afterTick([reachable('alpha')]);
    await contact.drain();
    expect(store.checks).toEqual([]);
    expect(record.verdictOf('alpha')).toBe('unchecked');
    expect(logs).toEqual([{ event: 'source.first_contact_failed', sourceId: 'alpha' }]);
    expect(await states(store)).toEqual([['alpha', 'unknown'], ['beta', 'unknown']]);
  });

  it('waits twice as many ticks after each failure, from none to ten minutes, per source', async () => {
    const { contact, executor } = rig({ capabilities: busy });
    const attemptsAfter = async (ticks: number): Promise<number> => {
      for (let tick = 0; tick < ticks; tick += 1) {
        contact.afterTick([reachable('alpha', { recovered: false, previous: 'reachable' })]);
        await contact.drain();
      }
      return executor.calls.filter((call) => call.templateId === 'capabilities').length;
    };
    // attempts at ticks 1, 2, 4, 8, 16: after a failure the next attempt skips 0, 1, 3, 7 ticks (and never more than ten minutes' worth)
    expect(await attemptsAfter(1)).toBe(1);
    expect(await attemptsAfter(1)).toBe(2);
    expect(await attemptsAfter(1)).toBe(2);
    expect(await attemptsAfter(1)).toBe(3);
    expect(await attemptsAfter(3)).toBe(3);
    expect(await attemptsAfter(1)).toBe(4);
    expect(await attemptsAfter(7)).toBe(4);
    expect(await attemptsAfter(1)).toBe(5);
    expect(MAX_BACKOFF_MS / INTERVAL).toBe(20);
  });

  it('never waits longer than ten minutes between two attempts', async () => {
    const { contact, executor } = rig({ capabilities: busy });
    const attemptTicks: number[] = [];
    for (let tick = 1; tick <= 200; tick += 1) {
      const before = executor.calls.length;
      contact.afterTick([reachable('alpha', { recovered: false, previous: 'reachable' })]);
      await contact.drain();
      if (executor.calls.length > before) attemptTicks.push(tick);
    }
    const gaps = attemptTicks.slice(1).map((tick, index) => tick - (attemptTicks[index] ?? 0));
    expect(gaps.slice(0, 5)).toEqual([1, 2, 4, 8, 16]);
    expect(Math.max(...gaps)).toBe(MAX_BACKOFF_MS / INTERVAL);
  });

  it('is not slowed by another source that fails, and resets once a check settles', async () => {
    let failing = true;
    const { contact, record, executor } = rig({ capabilities: (call) => (call.sourceId === 'alpha' && failing ? busy() : { status: 'rows', rows: [SERVER_ROW] }) });
    contact.afterTick([reachable('alpha'), reachable('beta')]);
    await contact.drain();
    expect(record.verdictOf('beta')).toBe('usable');
    expect(record.verdictOf('alpha')).toBe('unchecked');
    failing = false;
    contact.afterTick([reachable('alpha')]);
    await contact.drain();
    expect(record.verdictOf('alpha')).toBe('usable');
    const before = executor.calls.length;
    contact.afterTick([reachable('alpha')]);
    await contact.drain();
    expect(executor.calls).toHaveLength(before);
  });
});

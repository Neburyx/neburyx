import { describe, expect, it, vi } from 'vitest';
import { memoryStoreWith } from '../testing/app-store.js';
import type { PingResult } from './ping.js';
import { startPingSchedule } from './schedule.js';
import { mappingOf, sourceWith } from '../testing/gate-fixtures.js';
import { identityHashOf } from '../registry/identity-hash.js';
import { applyPingResults } from './state.js';

const mapping = mappingOf(sourceWith('a'), sourceWith('b'), sourceWith('c'));
const context = { mapping };
const [sourceA, sourceB] = mapping.sources;
const result = (sourceId: string, overrides: Partial<PingResult> = {}): PingResult => ({ sourceId, previous: 'reachable', current: 'unreachable', reason: 'The source could not be reached.', failure: 'unreachable', skipped: false, cause: null, recovered: false, startedAt: 1_000, ...overrides });

describe('writing the state of the results', () => {
  it('writes the failed and the reached results, with the time the read started, and nothing for a skipped one', async () => {
    const changes: unknown[] = [];
    const store = { applyPingState: (change: unknown) => (changes.push(change), Promise.resolve(true)) };
    await applyPingResults(store, { warn: () => undefined }, [result('a'), result('b', { current: 'reachable', reason: null }), result('c', { skipped: true })], context);
    expect(changes).toEqual([
      { sourceId: 'a', reachable: false, reason: 'The source could not be reached.', observedAt: '1970-01-01T00:00:01.000Z', identityHash: identityHashOf(sourceA), configHash: sourceA?.configHash },
      { sourceId: 'b', reachable: true, reason: null, observedAt: '1970-01-01T00:00:01.000Z', identityHash: identityHashOf(sourceB), configHash: sourceB?.configHash },
    ]);
  });

  it('logs one line with the source ID for each write that fails, and still writes the others', async () => {
    const lines: { fields: object; message: string }[] = [];
    const written: string[] = [];
    const store = { applyPingState: (change: { sourceId: string }) => (change.sourceId === 'a' ? Promise.reject(new Error('refused, with a secret') ) : (written.push(change.sourceId), Promise.resolve(true))) };
    await applyPingResults(store, { warn: (fields, message) => void lines.push({ fields, message }) }, [result('a'), result('b')], context);
    expect(lines).toEqual([{ fields: { event: 'source.ping_state_failed', sourceId: 'a' }, message: 'source ping state write failed' }]);
    expect(written).toEqual(['b']);
  });

  it('tries again on the next run after a failed write', async () => {
    const store = memoryStoreWith({ sources: [{ id: 'a', alias: 'a', state: 'connected', stateReason: null, synthetic: false, lastTestAt: null }], failPingState: true });
    const lines: object[] = [];
    await applyPingResults(store, { warn: (fields) => void lines.push(fields) }, [result('a')], context);
    await applyPingResults(store, { warn: (fields) => void lines.push(fields) }, [result('a')], context);
    expect(lines).toHaveLength(2);
  });
});

describe('closing while a state write is in flight', () => {
  it('lets the write finish before drain resolves, drops the results of a run that ended after stop, and logs nothing', async () => {
    vi.useFakeTimers();
    try {
      let release: (() => void) | undefined;
      const order: string[] = [];
      const store = { applyPingState: () => new Promise<boolean>((resolve) => (release = () => (order.push('written'), resolve(true)))) };
      const lines: object[] = [];
      const schedule = startPingSchedule({
        ping: { run: () => Promise.resolve([result('a')]), metrics: { snapshot: () => ({}) } },
        intervalMs: 100,
        onResults: (results) => applyPingResults(store, { warn: (fields) => void lines.push(fields) }, results, context),
      });
      await vi.advanceTimersByTimeAsync(100);
      schedule.stop();
      const drained = schedule.drain().then(() => order.push('drained'));
      await vi.advanceTimersByTimeAsync(50);
      expect(order).toEqual([]);
      release?.();
      await drained;
      expect(order).toEqual(['written', 'drained']);
      await vi.advanceTimersByTimeAsync(1000);
      expect(lines).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

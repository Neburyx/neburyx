import type { AuditEvent, AuditSink } from '@neburyx/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuditQueue, idFieldsOf } from './queue.js';
import type { AuditSettings } from './settings.js';

const SETTINGS: AuditSettings = { queueSize: 3, retryLimit: 2, retryWaitMs: 100, writeTimeoutMs: 1000 };

const event = (action: string, extra: Partial<AuditEvent> = {}): AuditEvent => ({ actorId: 'u-1', actorRole: 'investigator', action, result: 'success', traceId: 'tr-1', ...extra });

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
  reject(): void;
}

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  let reject: () => void = () => undefined;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = () => fail(new Error('down'));
  });
  return { promise, resolve, reject };
}

interface Recorded {
  readonly sink: AuditSink;
  readonly written: string[];
  readonly started: string[];
  readonly signals: AbortSignal[];
}

function recording(behaviour: (action: string, attempt: number) => Promise<void> | void = () => undefined): Recorded {
  const written: string[] = [];
  const started: string[] = [];
  const signals: AbortSignal[] = [];
  const attempts = new Map<string, number>();
  const sink: AuditSink = {
    async record(recorded, options) {
      started.push(recorded.action);
      if (options?.signal !== undefined) signals.push(options.signal);
      const attempt = (attempts.get(recorded.action) ?? 0) + 1;
      attempts.set(recorded.action, attempt);
      await behaviour(recorded.action, attempt);
      written.push(recorded.action);
    },
  };
  return { sink, written, started, signals };
}

function logs() {
  const lines: Record<string, unknown>[] = [];
  return { lines, logger: { warn: (fields: Record<string, unknown>) => void lines.push(fields) } };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('the audit queue', () => {
  it('returns at once from a record and never throws, whatever the sink does', async () => {
    const { logger } = logs();
    const throwing: AuditSink = { record: () => { throw new Error('sync'); } };
    const never: AuditSink = { record: () => new Promise<void>(() => undefined) };
    const queue = createAuditQueue({ sinks: [{ name: 'a', sink: throwing }, { name: 'b', sink: never }], settings: SETTINGS, logger });
    for (let i = 0; i < 10; i += 1) await expect(queue.sink.record(event(`e${i}`))).resolves.toBeUndefined();
  });

  it('writes each event once, in the order recorded, with the same fields, one at a time', async () => {
    const { logger } = logs();
    const first = deferred();
    const sink = recording((action) => (action === 'a' ? first.promise : undefined));
    const queue = createAuditQueue({ sinks: [{ name: 'postgres', sink: sink.sink }], settings: SETTINGS, logger });
    const events = [event('a', { sourceId: 's-1' }), event('b'), event('c')];
    for (const recorded of events) await queue.sink.record(recorded);
    await vi.advanceTimersByTimeAsync(10);
    expect(sink.started).toEqual(['a']);
    first.resolve();
    await vi.advanceTimersByTimeAsync(10);
    expect(sink.written).toEqual(['a', 'b', 'c']);
    expect(queue.counts()).toEqual({ written: 3, failed: 0, dropped: 0, queued: 0 });
  });

  it('tries a failed write again with a growing wait, and counts a write that finally succeeds', async () => {
    const { logger } = logs();
    const sink = recording((_action, attempt) => (attempt < 3 ? Promise.reject(new Error('down')) : undefined));
    const queue = createAuditQueue({ sinks: [{ name: 'postgres', sink: sink.sink }], settings: SETTINGS, logger });
    await queue.sink.record(event('a'));
    await vi.advanceTimersByTimeAsync(0);
    expect(sink.started).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(sink.started).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(199);
    expect(sink.started).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sink.written).toEqual(['a']);
    expect(queue.counts()).toEqual({ written: 1, failed: 0, dropped: 0, queued: 0 });
  });

  it('gives up after the retry limit, counts the event as failed and logs its id fields and no detail', async () => {
    const { logger, lines } = logs();
    const sink = recording(() => Promise.reject(new Error('down')));
    const queue = createAuditQueue({ sinks: [{ name: 'postgres', sink: sink.sink }], settings: SETTINGS, logger });
    await queue.sink.record(event('graph.expand', { sourceId: 's-1', investigationId: 'i-1', resourceRef: 'CANARY-REF', detail: { counts: { entities: 1 } } as never }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sink.started).toHaveLength(3);
    expect(queue.counts()).toMatchObject({ written: 0, failed: 1, dropped: 0, queued: 0 });
    expect(lines).toEqual([{ event: 'audit.event_failed', sink: 'postgres', action: 'graph.expand', result: 'success', traceId: 'tr-1', actorId: 'u-1', sourceId: 's-1', investigationId: 'i-1' }]);
    expect(JSON.stringify(lines)).not.toContain('CANARY');
  });

  it('drops a new event when the queue is full, returns at once, and counts the drop', async () => {
    const { logger, lines } = logs();
    const held = deferred();
    const sink = recording(() => held.promise);
    const queue = createAuditQueue({ sinks: [{ name: 'postgres', sink: sink.sink }], settings: SETTINGS, logger });
    for (const action of ['a', 'b', 'c', 'd', 'e']) await queue.sink.record(event(action));
    expect(queue.counts()).toMatchObject({ dropped: 2, queued: 3 });
    expect(lines.map((line) => line['event'])).toEqual(['audit.event_dropped', 'audit.event_dropped']);
    held.resolve();
    await vi.advanceTimersByTimeAsync(10);
    expect(sink.written).toEqual(['a', 'b', 'c']);
  });

  it('treats an attempt that outlives the write limit as failed, aborts it, and writes the next event only after it has settled', async () => {
    const { logger, lines } = logs();
    const slow = deferred();
    const sink = recording((action, attempt) => (action === 'a' && attempt === 1 ? slow.promise : undefined));
    const queue = createAuditQueue({ sinks: [{ name: 'postgres', sink: sink.sink }], settings: { ...SETTINGS, retryLimit: 0 }, logger });
    await queue.sink.record(event('a'));
    await queue.sink.record(event('b'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(sink.signals[0]?.aborted).toBe(true);
    expect(lines.map((line) => line['event'])).toContain('audit.write_timeout');
    expect(sink.started).toEqual(['a']);
    slow.resolve();
    await vi.advanceTimersByTimeAsync(10);
    expect(sink.written).toEqual(['a', 'b']);
    expect(sink.started).toEqual(['a', 'b']);
    expect(queue.counts()).toMatchObject({ failed: 1, written: 1 });
  });

  it('keeps returning at once and keeps memory bounded when a sink never settles, far beyond the stated bound', async () => {
    const { logger } = logs();
    const sink = recording(() => new Promise<void>(() => undefined));
    const queue = createAuditQueue({ sinks: [{ name: 'postgres', sink: sink.sink }], settings: SETTINGS, logger });
    for (let i = 0; i < 50; i += 1) await queue.sink.record(event(`e${i}`));
    await vi.advanceTimersByTimeAsync(1_000_000);
    expect(queue.counts()).toMatchObject({ queued: 3, dropped: 47 });
    expect(sink.started).toEqual(['e0']);
  });

  it('lets one sink stall without holding the other back, and keeps the order of the other', async () => {
    const { logger } = logs();
    const stalled = recording(() => new Promise<void>(() => undefined));
    const healthy = recording();
    const queue = createAuditQueue({ sinks: [{ name: 'postgres', sink: stalled.sink }, { name: 'stdout', sink: healthy.sink }], settings: SETTINGS, logger });
    for (const action of ['a', 'b', 'c']) await queue.sink.record(event(action));
    await vi.advanceTimersByTimeAsync(5000);
    expect(healthy.written).toEqual(['a', 'b', 'c']);
    expect(stalled.written).toEqual([]);
  });

  it('on stop waits for the queues up to the limit, then drops what is waiting, counts it, and lets the write in progress count itself when it settles', async () => {
    const { logger } = logs();
    const held = deferred();
    const sink = recording((action) => (action === 'a' ? held.promise : undefined));
    const queue = createAuditQueue({ sinks: [{ name: 'postgres', sink: sink.sink }], settings: SETTINGS, logger });
    await queue.sink.record(event('a'));
    await queue.sink.record(event('b'));
    const stopped = queue.stop(500);
    await vi.advanceTimersByTimeAsync(500);
    await stopped;
    expect(queue.counts()).toMatchObject({ dropped: 1, queued: 1 });
    held.resolve();
    await vi.advanceTimersByTimeAsync(10);
    expect(queue.counts()).toEqual({ written: 1, failed: 0, dropped: 1, queued: 0 });
    await queue.sink.record(event('c'));
    expect(queue.counts().dropped).toBe(2);
  });

  it('on stop returns as soon as the queues are empty', async () => {
    const { logger } = logs();
    const sink = recording();
    const queue = createAuditQueue({ sinks: [{ name: 'postgres', sink: sink.sink }], settings: SETTINGS, logger });
    await queue.sink.record(event('a'));
    const stopped = queue.stop(60_000);
    await vi.advanceTimersByTimeAsync(10);
    await stopped;
    expect(sink.written).toEqual(['a']);
    expect(queue.counts().dropped).toBe(0);
  });
});

describe('idFieldsOf', () => {
  it('holds the ids and codes of an event and never its detail', () => {
    expect(Object.keys(idFieldsOf(event('a', { resourceRef: 'x', resourceType: 'y', detail: { reason: 'r' } as never })))).toEqual(['action', 'result', 'traceId', 'actorId']);
  });
});

describe('the audit counts as /readyz reads them', () => {
  it('count successes, failures after the retries and drops, and a read of them never waits for a sink', async () => {
    const { logger } = logs();
    const fail = recording((action) => (action === 'bad' ? Promise.reject(new Error('down')) : undefined));
    const queue = createAuditQueue({ sinks: [{ name: 'postgres', sink: fail.sink }], settings: { ...SETTINGS, retryLimit: 0, queueSize: 2 }, logger });
    await queue.sink.record(event('ok'));
    await queue.sink.record(event('bad'));
    await queue.sink.record(event('third'));
    await queue.sink.record(event('fourth'));
    expect(queue.counts()).toMatchObject({ dropped: 2, queued: 2 });
    await vi.advanceTimersByTimeAsync(10);
    expect(queue.counts()).toEqual({ written: 1, failed: 1, dropped: 2, queued: 0 });
  });
});

describe('a write that stalls', () => {
  it('is counted as failed at the deadline while the sink is still unresolved, and is not counted again when it settles or tried again', async () => {
    const { logger } = logs();
    const slow = deferred();
    const sink = recording(() => slow.promise);
    const queue = createAuditQueue({ sinks: [{ name: 'postgres', sink: sink.sink }], settings: SETTINGS, logger });
    await queue.sink.record(event('a'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(queue.counts()).toMatchObject({ failed: 1, written: 0, queued: 1 });
    slow.resolve();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(queue.counts()).toEqual({ written: 0, failed: 1, dropped: 0, queued: 0 });
    expect(sink.started).toEqual(['a']);
  });
});

describe('stopping the queue', () => {
  it('makes no further try of the write in progress, cancels its wait, aborts it, and counts the event once', async () => {
    const { logger } = logs();
    const sink = recording(() => Promise.reject(new Error('down')));
    const queue = createAuditQueue({ sinks: [{ name: 'postgres', sink: sink.sink }], settings: SETTINGS, logger });
    await queue.sink.record(event('a'));
    await queue.sink.record(event('b'));
    await vi.advanceTimersByTimeAsync(0);
    expect(sink.started).toEqual(['a']);
    const stopped = queue.stop(0);
    await vi.advanceTimersByTimeAsync(10_000);
    await stopped;
    expect(sink.started).toEqual(['a']);
    expect(queue.counts()).toEqual({ written: 0, failed: 1, dropped: 1, queued: 0 });
  });
});

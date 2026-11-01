import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExperimentError } from './errors.js';
import { prepare, runAll, runClose, runTimeout } from './experiments.js';
import { NEVER, ONE_ROW, fakeBackend } from './fake-backend.js';
import { TAIL_MS } from './settings.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('runClose', () => {
  it('keeps looking at the server while the close never settles, and reports it unsettled', async () => {
    const { backend, lookCalls } = fakeBackend({ txClose: () => NEVER() });
    const failures: string[] = [];
    const run = runClose(backend, 'transaction', failures);
    await vi.advanceTimersByTimeAsync(80_000);
    const result = await run;
    expect(result.closeEnd.kind).toBe('unsettled');
    expect(result.end.kind).toBe('unsettled');
    expect(Math.max(...result.samples.map((s) => s.atMs))).toBeGreaterThan(44_000);
    expect(lookCalls()).toBeGreaterThan(80);
    expect(result.driverReuse).toEqual({ ok: true });
  });

  it('marks the case inconclusive when the read had already returned before the close', async () => {
    const { backend } = fakeBackend({ crossProduct: () => Promise.resolve(ONE_ROW), look: () => ({ state: 'absent' }) });
    const run = runClose(backend, 'session', []);
    await vi.advanceTimersByTimeAsync(80_000);
    const result = await run;
    expect(result.reading).toMatchObject({ verdict: 'inconclusive', callEndedBeforeClose: true });
  });

  it('closes the session or the transaction according to the target, at the time it says', async () => {
    const closing = fakeBackend({ sessionClose: () => Promise.resolve() });
    const run = runClose(closing.backend, 'session', []);
    await vi.advanceTimersByTimeAsync(80_000);
    const result = await run;
    expect(result.closeEnd).toMatchObject({ kind: 'returned' });
    expect(closing.events.filter((e) => e.what === 'tx.close')).toHaveLength(0);
    expect(closing.events.filter((e) => e.what === 'session.close').length).toBeGreaterThanOrEqual(1);
  });

  it('reports a failed observer cleanup and a session that will not close', async () => {
    const { backend } = fakeBackend({ lookCleanup: () => Promise.resolve('observer session: boom'), sessionClose: () => NEVER() });
    const failures: string[] = [];
    const run = runClose(backend, 'transaction', failures);
    await vi.advanceTimersByTimeAsync(120_000);
    await run;
    expect(failures.some((f) => f.startsWith('observer session: boom ('))).toBe(true);
    expect(failures).toContain('session of the transaction close run: did not finish within 5000 ms');
  });
});

describe('runClose reuse', () => {
  it('measures reuse from the read alone and reports a fresh session that fails to close', async () => {
    const { backend } = fakeBackend({ sessionClose: () => Promise.reject(new Error('reset')) });
    const failures: string[] = [];
    const run = runClose(backend, 'transaction', failures);
    await vi.advanceTimersByTimeAsync(80_000);
    const result = await run;
    expect(result.driverReuse).toEqual({ ok: true });
    expect(failures).toContain('fresh session of the transaction close run: none');
  });

  it('reports a fresh session that never closes, and still counts the read as having worked', async () => {
    const { backend } = fakeBackend({ sessionClose: () => NEVER() });
    const failures: string[] = [];
    const run = runClose(backend, 'transaction', failures);
    await vi.advanceTimersByTimeAsync(120_000);
    const result = await run;
    expect(result.driverReuse).toEqual({ ok: true });
    expect(failures).toContain('fresh session of the transaction close run: did not finish within 5000 ms');
  });
});

describe('runAll', () => {
  it('keeps the cleanup problems found before an experiment failed', async () => {
    const { backend } = fakeBackend({
      sessionClose: () => Promise.reject(new Error('reset')),
      begin: () => Promise.reject(new Error('cannot begin')),
    });
    const run = runAll(backend, 'neo4j:test');
    const outcome = run.then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(60_000);
    const error = await outcome;
    if (!(error instanceof ExperimentError)) throw new Error('expected an ExperimentError');
    expect(error.message).toBe('cannot begin');
    expect(error.cleanupFailures).toContain('session of the preparation: none');
  });
});

describe('runTimeout', () => {
  it('closes the original transaction only after the observation window', async () => {
    const { backend, events } = fakeBackend({
      crossProduct: () => new Promise((resolve) => setTimeout(() => resolve(ONE_ROW), 40)),
      look: (atMs) => ({ state: atMs < 1000 ? 'running' : 'absent' }),
    });
    const failures: string[] = [];
    const run = runTimeout(backend, failures);
    await vi.advanceTimersByTimeAsync(40_000);
    const result = await run;
    const begun = events.find((e) => e.what === 'begin');
    const closed = events.find((e) => e.what === 'tx.close');
    expect(result.end.kind).toBe('returned');
    expect(closed && begun && closed.at - begun.at).toBeGreaterThanOrEqual(TAIL_MS);
    expect(result.sessionReuse).toEqual({ ok: true });
    expect(failures).toEqual([]);
  });

  it('does not close a transaction the server already ended', async () => {
    const { backend, events } = fakeBackend({ crossProduct: () => Promise.reject(Object.assign(new Error('timed out'), { code: 'Neo.X' })) });
    const run = runTimeout(backend, []);
    await vi.advanceTimersByTimeAsync(40_000);
    const result = await run;
    expect(result.end).toMatchObject({ kind: 'raised', code: 'Neo.X' });
    expect(events.filter((e) => e.what === 'tx.close')).toHaveLength(0);
  });
});

describe('prepare', () => {
  it('reports a session that fails to close and a connection that will not close', async () => {
    const { backend } = fakeBackend({ sessionClose: () => Promise.reject(new Error('reset')), connectionClose: () => NEVER() });
    const failures: string[] = [];
    const run = prepare(backend, 'neo4j:test', failures);
    await vi.advanceTimersByTimeAsync(20_000);
    const facts = await run;
    expect(facts).toEqual({ image: 'neo4j:test', serverVersion: '9.9.9', edition: 'community', driverVersion: '9.9.9' });
    expect(failures).toEqual(['session of the preparation: none', 'connection of the preparation: did not finish within 5000 ms']);
  });
});

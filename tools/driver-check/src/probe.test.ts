import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Poller, bounded, describeError, settle, type Look, type LookResult } from './probe.js';

const answered = (look: Look, answeredAt: number, cleanup: Promise<string | undefined> = Promise.resolve(undefined)): LookResult => ({ look, answeredAt, cleanup });

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('settle', () => {
  it('returns the value of a promise that finishes in time', async () => {
    const outcome = await settle(Promise.resolve(7), 1000, performance.now());
    expect(outcome).toMatchObject({ kind: 'value', value: 7 });
  });

  it('returns the error of a promise that fails in time', async () => {
    const outcome = await settle(Promise.reject(new Error('no')), 1000, performance.now());
    expect(outcome.kind).toBe('error');
  });

  it('reports a promise that is still pending at the limit as unsettled, at the limit', async () => {
    const pending = settle(new Promise<number>(() => undefined), 30_000, performance.now());
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toEqual({ kind: 'unsettled', atMs: 30_000 });
  });
});

describe('bounded', () => {
  it('throws, naming the phase, when it does not finish in time', async () => {
    const pending = bounded('begin the transaction', new Promise<number>(() => undefined), 5000);
    const result = expect(pending).rejects.toThrow('begin the transaction did not finish within 5000 ms');
    await vi.advanceTimersByTimeAsync(5000);
    await result;
  });

  it('passes an error through', async () => {
    await expect(bounded('x', Promise.reject(new Error('boom')), 1000)).rejects.toThrow('boom');
  });
});

describe('describeError', () => {
  it('reads the class and code of an error, and tolerates other values', () => {
    expect(describeError(Object.assign(new Error('x'), { code: 'Neo.Code' }))).toEqual({ errorClass: 'Error', code: 'Neo.Code' });
    expect(describeError(new Error('x'))).toEqual({ errorClass: 'Error', code: 'none' });
    expect(describeError('text')).toEqual({ errorClass: 'string', code: 'none' });
  });
});

describe('Poller', () => {
  it('keeps looking while a close that never settles is still pending', async () => {
    let calls = 0;
    const poller = new Poller(async () => answered({ state: ++calls < 3 ? 'absent' : 'running' }, performance.now()), 500, () => performance.now());
    poller.start();
    let closeState = 'pending';
    const close = settle(new Promise<void>(() => undefined), 30_000, performance.now()).then((outcome) => {
      closeState = outcome.kind;
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(closeState).toBe('pending');
    expect(calls).toBeGreaterThanOrEqual(10);
    expect(poller.sawRunning()).toBe(true);
    await vi.advanceTimersByTimeAsync(25_000);
    await close;
    const stopping = poller.stop();
    await vi.advanceTimersByTimeAsync(500);
    await stopping;
    expect(closeState).toBe('unsettled');
  });

  it('records when a slow look was sent and when it was answered', async () => {
    const clock = { now: 0, calls: 0 };
    const slowOnce = async (): Promise<LookResult> => {
      if (++clock.calls > 1) return new Promise<LookResult>(() => undefined);
      clock.now += 1500;
      return answered({ state: 'absent' }, clock.now);
    };
    const poller = new Poller(slowOnce, 500, () => clock.now);
    poller.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(poller.samples(0)).toEqual([{ sentMs: 0, atMs: 1500, state: 'absent' }]);
  });

  it('timestamps the answer before the cleanup that follows it', async () => {
    const clock = { now: 0, calls: 0 };
    const slowCleanup = async (): Promise<LookResult> => {
      if (++clock.calls > 1) return new Promise<LookResult>(() => undefined);
      const answeredAt = 100;
      clock.now = 4100;
      return answered({ state: 'running' }, answeredAt, new Promise((resolve) => setTimeout(() => resolve(undefined), 4000)));
    };
    const poller = new Poller(slowCleanup, 500, () => clock.now);
    poller.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(poller.samples(0)).toEqual([{ sentMs: 0, atMs: 100, state: 'running' }]);
  });

  it('returns the cleanups that failed once, counting repeats', async () => {
    let calls = 0;
    const poller = new Poller(async () => answered({ state: 'absent' }, performance.now(), Promise.resolve(++calls === 2 ? undefined : 'observer session: boom')), 500, () => performance.now());
    poller.start();
    await vi.advanceTimersByTimeAsync(2400);
    const stopping = poller.stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(await stopping).toEqual(['observer session: boom (4 looks)']);
  });
});

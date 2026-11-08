import { describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import { createRequestLimiter, WINDOW_MS, type RequestLimiter } from './request-limiter.js';

function limiterAt(start = 1_000_000) {
  let now = start;
  let sweeps = 0;
  let stopped = false;
  let sweepNow: () => void = () => undefined;
  const limiter = createRequestLimiter({
    clock: () => now,
    startSweep: (run) => {
      sweepNow = run;
      sweeps += 1;
      return () => {
        stopped = true;
      };
    },
  });
  return { limiter, at: (time: number) => void (now = time), tick: (ms: number) => void (now += ms), sweepNow: () => sweepNow(), sweeps: () => sweeps, stopped: () => stopped };
}

const key = (principalId: string, sourceId = 'demo') => ({ sourceId, principalId });

function refusal(limiter: RequestLimiter, limit: number, principalId = 'p', sourceId = 'demo'): AppError {
  try {
    limiter.admit(key(principalId, sourceId), limit);
  } catch (error) {
    if (error instanceof AppError) return error;
  }
  throw new Error('the request was admitted');
}

describe('the request limiter', () => {
  it('refuses the request over the limit with RATE_LIMITED and the time until the oldest counted request is 60 s old', () => {
    const { limiter, tick } = limiterAt();
    limiter.admit(key('p'), 3);
    tick(10_000);
    limiter.admit(key('p'), 3);
    tick(10_000);
    limiter.admit(key('p'), 3);
    tick(5_000);
    const error = refusal(limiter, 3);
    expect(error.code).toBe('RATE_LIMITED');
    expect(error.details).toEqual({ retryAfterMs: WINDOW_MS - 25_000 });
  });

  it('admits a request sent after exactly the wait, and one 60,000 ms old no longer counts', () => {
    const { limiter, tick } = limiterAt();
    limiter.admit(key('p'), 1);
    tick(20_000);
    const error = refusal(limiter, 1);
    const wait = (error.details as { retryAfterMs: number }).retryAfterMs;
    tick(wait - 1);
    expect(refusal(limiter, 1).code).toBe('RATE_LIMITED');
    tick(1);
    limiter.admit(key('p'), 1);
  });

  it('does not count a refused request, and the wait only shrinks as time passes', () => {
    const { limiter, tick } = limiterAt();
    limiter.admit(key('p'), 1);
    const waits: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      tick(1_000);
      waits.push((refusal(limiter, 1).details as { retryAfterMs: number }).retryAfterMs);
    }
    expect(waits).toEqual([...waits].sort((a, b) => b - a));
    expect(new Set(waits).size).toBe(5);
    expect(limiter.inspect().get(JSON.stringify(['demo', 'p']))).toBe(1);
  });

  it('never answers a wait below 1 ms', () => {
    const { limiter, at } = limiterAt(0);
    limiter.admit(key('p'), 1);
    at(WINDOW_MS - 1);
    expect((refusal(limiter, 1).details as { retryAfterMs: number }).retryAfterMs).toBe(1);
  });

  it('keeps people and sources apart', () => {
    const { limiter } = limiterAt();
    limiter.admit(key('p'), 1);
    limiter.admit(key('q'), 1);
    limiter.admit(key('p', 'other'), 1);
    expect(refusal(limiter, 1).code).toBe('RATE_LIMITED');
  });

  it('forgets a key with no request in the window, by the sweep and by pruning', () => {
    const { limiter, tick, sweepNow } = limiterAt();
    for (let i = 0; i < 1_000; i += 1) limiter.admit(key(`p${i}`), 5);
    expect(limiter.inspect().size).toBe(1_000);
    tick(WINDOW_MS);
    sweepNow();
    expect(limiter.inspect().size).toBe(0);
  });

  it('stops its sweep when closed', () => {
    const { limiter, stopped, sweeps } = limiterAt();
    expect(sweeps()).toBe(0);
    limiter.admit(key('p'), 5);
    limiter.admit(key('p'), 5);
    expect(sweeps()).toBe(1);
    limiter.close();
    expect(stopped()).toBe(true);
  });

  it('fails closed when the clock gives no usable time', () => {
    const limiter = createRequestLimiter({ clock: () => Number.NaN, startSweep: () => () => undefined });
    expect(() => limiter.admit(key('p'), 5)).toThrowError(expect.objectContaining({ code: 'INTERNAL_ERROR' }) as Error);
    const throwing = createRequestLimiter({
      clock: () => {
        throw new Error('no clock');
      },
      startSweep: () => () => undefined,
    });
    expect(() => throwing.admit(key('p'), 5)).toThrow();
  });
});

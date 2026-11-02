import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PingResult, ScheduledPing } from './ping.js';
import { PING_INTERVAL_MS, startPingSchedule } from './schedule.js';

afterEach(() => vi.useRealTimers());

const RESULT: PingResult = { sourceId: 'alpha', previous: 'reachable', current: 'reachable', reason: null, skipped: false, recovered: false, startedAt: 0 };

function fakePing(run: () => Promise<readonly PingResult[]>): { readonly ping: ScheduledPing; readonly runs: () => number } {
  let count = 0;
  return { ping: { run: () => (count += 1, run()), metrics: { snapshot: () => ({}) } }, runs: () => count };
}

describe('the schedule', () => {
  it('uses a 30 second interval', () => {
    expect(PING_INTERVAL_MS).toBe(30_000);
  });

  it('runs once per interval', async () => {
    vi.useFakeTimers();
    const { ping, runs } = fakePing(() => Promise.resolve([RESULT]));
    const seen: (readonly PingResult[])[] = [];
    startPingSchedule({ ping, intervalMs: PING_INTERVAL_MS, onResults: (results) => (seen.push(results), Promise.resolve()) });
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS - 1);
    expect(runs()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(runs()).toBe(1);
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
    expect(runs()).toBe(2);
    expect(seen).toEqual([[RESULT], [RESULT]]);
  });

  it('skips a tick while the previous run is still going, and runs again after it ended', async () => {
    vi.useFakeTimers();
    let finish: (() => void) | undefined;
    const { ping, runs } = fakePing(() => new Promise((resolve) => (finish = () => resolve([RESULT]))));
    startPingSchedule({ ping, intervalMs: 100 });
    await vi.advanceTimersByTimeAsync(350);
    expect(runs()).toBe(1);
    finish?.();
    await vi.advanceTimersByTimeAsync(100);
    expect(runs()).toBe(2);
  });

  it('clears the timer on stop, starts no run after it, and drops the results of a run in flight', async () => {
    vi.useFakeTimers();
    let finish: (() => void) | undefined;
    const { ping, runs } = fakePing(() => new Promise((resolve) => (finish = () => resolve([RESULT]))));
    const seen: unknown[] = [];
    const schedule = startPingSchedule({ ping, intervalMs: 100, onResults: (results) => (seen.push(results), Promise.resolve()) });
    await vi.advanceTimersByTimeAsync(100);
    expect(runs()).toBe(1);
    schedule.stop();
    expect(vi.getTimerCount()).toBe(0);
    finish?.();
    await vi.advanceTimersByTimeAsync(1000);
    expect(runs()).toBe(1);
    expect(seen).toEqual([]);
  });

  it('keeps going after a run that failed, and reports the failure', async () => {
    vi.useFakeTimers();
    const failures: number[] = [];
    let attempt = 0;
    const { ping, runs } = fakePing(() => (attempt += 1) === 1 ? Promise.reject(new Error('x')) : Promise.resolve([RESULT]));
    startPingSchedule({ ping, intervalMs: 100, onFailure: () => failures.push(1) });
    await vi.advanceTimersByTimeAsync(300);
    expect(runs()).toBe(3);
    expect(failures).toEqual([1]);
  });

  it('does not keep the process alive', () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(globalThis, 'setInterval');
    const schedule = startPingSchedule({ ping: fakePing(() => Promise.resolve([])).ping, intervalMs: 100 });
    const timer: unknown = spy.mock.results[0]?.value;
    expect(typeof timer === 'object' && timer !== null && 'hasRef' in timer && typeof timer.hasRef === 'function' ? timer.hasRef() : 'no timer').toBe(false);
    schedule.stop();
    spy.mockRestore();
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { bounded, pollUntil, runAll } from './neo4j-server.js';
import { checkSeries, provideSeries, seriesOf } from './series.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('running every cleanup step', () => {
  it('attempts each step when one rejects, and reports all failures together', async () => {
    const ran: string[] = [];
    const failure = runAll([
      () => {
        ran.push('first');
        return Promise.reject(new Error('first failed'));
      },
      () => {
        ran.push('second');
        return undefined;
      },
      () => {
        ran.push('third');
        return Promise.reject(new Error('third failed'));
      },
    ]);
    await expect(failure).rejects.toMatchObject({ errors: [{ message: 'first failed' }, { message: 'third failed' }] });
    expect(ran).toEqual(['first', 'second', 'third']);
  });

  it('is silent when every step succeeds', async () => {
    await expect(runAll([() => Promise.resolve(), () => undefined])).resolves.toBeUndefined();
  });
});

describe('bounding an observation', () => {
  it('passes the value or the failure of work that finishes in time', async () => {
    await expect(bounded(Promise.resolve(3), 100, 'work')).resolves.toBe(3);
    await expect(bounded(Promise.reject(new Error('own failure')), 100, 'work')).rejects.toThrow('own failure');
  });

  it('fails explicitly, naming the work, when it does not finish in time', async () => {
    vi.useFakeTimers();
    const outcome = bounded(new Promise<never>(() => undefined), 100, 'the look').catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(100);
    expect(await outcome).toMatchObject({ message: 'the look did not finish within 100 ms' });
  });
});

describe('polling until an observation answers', () => {
  it('answers true as soon as the observation does', async () => {
    const observe = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    vi.useFakeTimers();
    const answer = pollUntil(observe, 10_000, 250);
    await vi.advanceTimersByTimeAsync(250);
    expect(await answer).toBe(true);
    expect(observe).toHaveBeenCalledTimes(2);
  });

  it('answers false at the limit and starts no observation after it', async () => {
    vi.useFakeTimers();
    const observe = vi.fn().mockResolvedValue(false);
    const answer = pollUntil(observe, 1000, 400);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await answer).toBe(false);
    const calls = observe.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(observe).toHaveBeenCalledTimes(calls);
  });

  it('fails explicitly when an observation cannot finish within the time left', async () => {
    vi.useFakeTimers();
    const observe = vi.fn().mockReturnValue(new Promise<boolean>(() => undefined));
    const outcome = pollUntil(observe, 1000, 250).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await outcome).toMatchObject({ message: 'the observation did not finish within 1000 ms' });
    expect(observe).toHaveBeenCalledTimes(1);
  });
});

describe('the series of the server the Neo4j tests accept', () => {
  it.each([
    ['5.26.32', '5.26'],
    ['5.26.0', '5.26'],
    ['2026.10.1', '2026'],
    ['2026.1.0', '2026'],
  ])('accepts %s as %s', (version, series) => {
    expect(seriesOf(version)).toBe(series);
    expect(checkSeries(version)).toBe(series);
  });

  it.each([
    ['5.25.0', 'the server runs 5.25'],
    ['2025.1.0', 'the server runs 2025.1'],
    ['2027.1.0', 'the server runs 2027.1'],
    ['5.260.1', 'the server runs 5.260'],
    ['', 'the server runs no version'],
  ])('refuses %j, naming the series it saw and the two accepted', (version, saw) => {
    expect(() => checkSeries(version)).toThrow(saw);
    expect(() => checkSeries(version)).toThrow('Neo4j 5.26 and 2026');
  });

  it('hands the series of the server to the test files, and hands nothing over for a series it refuses', () => {
    const provided: [string, string][] = [];
    expect(provideSeries('2026.10.1', (key, value) => provided.push([key, value]))).toBe('2026');
    expect(provided).toEqual([['neo4jSeries', '2026']]);
    expect(() => provideSeries('5.25.0', (key, value) => provided.push([key, value]))).toThrow();
    expect(provided).toHaveLength(1);
  });
});

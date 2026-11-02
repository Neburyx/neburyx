import { afterEach, describe, expect, it, vi } from 'vitest';
import { bounded, DEFAULT_NEO4J_IMAGE, neo4jImageFrom, pollUntil, runAll } from './neo4j-container.js';

describe('the Neo4j image', () => {
  it('is the one named by NEBURYX_NEO4J_IMAGE', () => {
    expect(neo4jImageFrom({ NEBURYX_NEO4J_IMAGE: 'neo4j:2026' })).toBe('neo4j:2026');
  });

  it.each([{}, { NEBURYX_NEO4J_IMAGE: '' }])('is the default image when the variable is not set: %j', (env) => {
    expect(neo4jImageFrom(env)).toBe(DEFAULT_NEO4J_IMAGE);
    expect(DEFAULT_NEO4J_IMAGE).toBe('neo4j:5.26');
  });
});

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

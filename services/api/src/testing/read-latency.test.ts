import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ceilingOf, durationMs, INTERVAL_SETTING, serverLag, timeOneRead, timeOvershoot, timeWarmRead } from './read-latency.js';

type Rows = readonly unknown[];

const settings = (rows: Rows | Error) => ({
  session: () => ({
    run: async () => {
      if (rows instanceof Error) throw rows;
      return { records: rows.map((value) => ({ get: () => value })) };
    },
    close: async () => undefined,
  }),
});

const after = (ms: number, answer: unknown = { ok: true }): Promise<unknown> => new Promise((resolve) => setTimeout(() => resolve(answer), ms));

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the ceiling of a read forced past a budget', () => {
  it('is the budget, the lag and ten ordinary reads', () => {
    expect(ceilingOf(1000, 2000, 40)).toBe(3400);
    expect(ceilingOf(3000, 2000, 1380)).toBe(18_800);
  });

  it('stays far below the time of a read that no timeout stopped', () => {
    expect(ceilingOf(1000, 2000, 60)).toBe(3600);
    expect(60_000).toBeGreaterThan(ceilingOf(1000, 2000, 60));
  });
});

describe('the timings', () => {
  it('times one read in whole ms', async () => {
    const timed = timeOneRead(() => after(30));
    await vi.advanceTimersByTimeAsync(30);
    expect(await timed).toBe(30);
  });

  it('times at least 1 ms', async () => {
    expect(await timeOneRead(() => Promise.resolve({ ok: true }))).toBe(1);
  });

  it('refuses the time of a read that answered not ok, naming its code', async () => {
    await expect(timeOneRead(() => Promise.resolve({ ok: false, failure: { code: 'QUERY_TIMEOUT' } }))).rejects.toThrow('"QUERY_TIMEOUT"');
    await expect(timeOneRead(() => Promise.resolve({ ok: false }))).rejects.toThrow(/did not succeed \(unknown\)/);
  });

  it('discards a slow first read and its error, and times the second', async () => {
    const times = [400, 25];
    let calls = 0;
    const read = () => {
      calls += 1;
      return calls === 1 ? new Promise((_, reject) => setTimeout(() => reject(new Error('cold')), 400)) : after(times[1] ?? 0);
    };
    const timed = timeWarmRead(read);
    await vi.advanceTimersByTimeAsync(400);
    await vi.advanceTimersByTimeAsync(25);
    expect(await timed).toBe(25);
    expect(calls).toBe(2);
  });

  it('times how far past the budget a forced read answers, even when it fails', async () => {
    const timed = timeOvershoot(20, () => new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 60)));
    await vi.advanceTimersByTimeAsync(60);
    expect(await timed).toBe(40);
  });

  it.each([['2s', 2000], ['500ms', 500], ['1m', 60_000], ['1.5s', 1500], ['1h', 3_600_000]])('reads %s as %d ms', (text, ms) => {
    expect(durationMs(text)).toBe(ms);
  });

  it.each(['', 'soon', '2', '-1s', '2d'])('reads %j as no duration', (text) => {
    expect(durationMs(text)).toBeUndefined();
  });
});

describe('the lag of the server', () => {
  it(`is the value of ${INTERVAL_SETTING} when the login reads it`, async () => {
    let forcedReads = 0;
    expect(
      await serverLag(settings(['2s']), async () => {
        forcedReads += 1;
        return 1;
      }),
    ).toEqual({ lagMs: 2000, via: 'setting' });
    expect(forcedReads).toBe(0);
  });

  it.each<[string, Rows | Error]>([['a refused login', new Error('not allowed')], ['no row', []], ['a word', ['soon']], ['a number', [7]]])('is the largest of three forced reads for %s', async (_name, rows) => {
    const overshoots = [300, 900, 400];
    let next = 0;
    expect(await serverLag(settings(rows), async () => overshoots[next++] ?? 0)).toEqual({ lagMs: 900, via: 'calibration' });
    expect(next).toBe(3);
  });
});

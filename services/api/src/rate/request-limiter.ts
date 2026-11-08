import { AppError } from '../errors.js';

export const WINDOW_MS = 60_000;

export interface RequestKey {
  readonly sourceId: string;
  readonly principalId: string;
}

export interface RequestLimiter {
  /** Counts one request, or throws `RATE_LIMITED` with the time until the oldest counted request leaves the window; a refused request is not counted. */
  admit(key: RequestKey, limitPerMinute: number): void;
  /** The number of requests counted now, by key; a key exists only while it holds a request in the window. */
  inspect(): ReadonlyMap<string, number>;
  /** Stops the sweep of idle keys. */
  close(): void;
}

export interface RequestLimiterOptions {
  readonly clock?: () => number;
  /** Starts the sweep of idle keys; returns the function that stops it. */
  readonly startSweep?: (run: () => void, everyMs: number) => () => void;
}

const realSweep = (run: () => void, everyMs: number): (() => void) => {
  const handle = setInterval(run, everyMs);
  handle.unref();
  return () => clearInterval(handle);
};

/**
 * The request rate of one API copy: a sliding window of the last 60 seconds over the requests admitted for a person on a source. The wait of a refused request is the time until the oldest
 * counted request is 60 seconds old, so a request sent after exactly that wait is admitted.
 */
export function createRequestLimiter(options: RequestLimiterOptions = {}): RequestLimiter {
  const clock = options.clock ?? Date.now;
  const windows = new Map<string, number[]>();

  const keyOf = (key: RequestKey): string => JSON.stringify([key.sourceId, key.principalId]);

  /** Drops the times that are 60 seconds old or older; the window is open at the old end. */
  const prune = (times: number[], now: number): void => {
    let stale = 0;
    while (stale < times.length && now - (times[stale] as number) >= WINDOW_MS) stale += 1;
    if (stale > 0) times.splice(0, stale);
  };

  const sweep = (): void => {
    const now = clock();
    for (const [key, times] of windows) {
      prune(times, now);
      if (times.length === 0) windows.delete(key);
    }
  };

  /** The sweep starts with the first request, so an app that never counts one holds no timer. */
  let stopSweep: (() => void) | undefined;

  return {
    admit(key, limitPerMinute) {
      const now = clock();
      if (!Number.isFinite(now)) throw new AppError('INTERNAL_ERROR');
      stopSweep ??= (options.startSweep ?? realSweep)(sweep, WINDOW_MS);
      const id = keyOf(key);
      const times = windows.get(id) ?? [];
      prune(times, now);
      const oldest = times[0];
      if (times.length >= limitPerMinute && oldest !== undefined) {
        windows.set(id, times);
        throw new AppError('RATE_LIMITED', { retryAfterMs: Math.max(1, Math.ceil(oldest + WINDOW_MS - now)) });
      }
      times.push(now);
      windows.set(id, times);
    },
    inspect() {
      sweep();
      return new Map([...windows].map(([key, times]) => [key, times.length]));
    },
    close() {
      stopSweep?.();
      stopSweep = undefined;
    },
  };
}

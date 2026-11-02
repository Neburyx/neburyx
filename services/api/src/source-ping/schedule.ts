import type { PingResult, ScheduledPing } from './ping.js';

/** One run every 30 seconds. */
export const PING_INTERVAL_MS = 30_000;

export interface PingScheduleOptions {
  readonly ping: ScheduledPing;
  readonly intervalMs: number;
  /** Called with the results of a run that finished before `stop`. */
  readonly onResults?: (results: readonly PingResult[]) => Promise<void>;
  readonly onFailure?: () => void;
}

export interface PingSchedule {
  /** Clears the timer. A run in flight is not waited for and its results are dropped. */
  stop(): void;
  /** Resolves when the state writes of a run that had already ended when `stop` was called are finished. */
  drain(): Promise<void>;
}

/** Runs the ping on a timer, never two runs at once. The timer does not keep the process alive. */
export function startPingSchedule(options: PingScheduleOptions): PingSchedule {
  let stopped = false;
  let running = false;
  let applying: Promise<void> = Promise.resolve();

  async function tick(): Promise<void> {
    if (running || stopped) return;
    running = true;
    try {
      const results = await options.ping.run();
      if (stopped) return;
      applying = options.onResults?.(results) ?? Promise.resolve();
      await applying;
    } catch {
      options.onFailure?.();
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => void tick(), options.intervalMs);
  timer.unref();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    // a failed write is already reported through onFailure; closing must not fail because of it
    drain: () => applying.catch(() => undefined),
  };
}

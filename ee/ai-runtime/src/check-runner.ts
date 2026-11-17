import { availableParallelism } from 'node:os';
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';

/** A check that measures over this many milliseconds runs in a worker thread from then on, so that it does not hold the event loop of the main thread. Four times the 95th percentile of the check on the largest view, as `docs/benchmarks/ai-runtime.md` records. */
export const DEFAULT_OFFLOAD_THRESHOLD_MS = 50;

/** Worker threads that run checks at once: one fewer than the processors, so that the main thread keeps one, and at least one. A check that waits for a worker counts the wait in its time limit. */
const DEFAULT_MAX_CHECK_WORKERS = Math.max(1, availableParallelism() - 1);

/** The module that holds a check and the name of its exported function, as the worker loads them. */
export interface CheckModule {
  readonly url: string;
  readonly exportName: string;
}

export interface HeavyCheck<Input, Output> {
  /** The key of the measurement kept for this check. */
  readonly name: string;
  readonly inline: (input: Input) => Output;
  readonly module: CheckModule;
  /** Reads what the worker sent back; undefined for anything that is not an output of this check. */
  readonly parse: (value: unknown) => Output | undefined;
}

export type CheckOutcome<Output> = { readonly status: 'done'; readonly value: Output } | { readonly status: 'refused'; readonly reason: 'worker-failed' | 'timeout' | 'cancelled' };

export interface CheckRunner {
  run<Input, Output>(check: HeavyCheck<Input, Output>, input: Input, limits: { readonly timeoutMs: number; readonly signal?: AbortSignal }): Promise<CheckOutcome<Output>>;
}

export interface CheckRunnerOptions {
  readonly thresholdMs?: number;
  /** The most worker threads running checks at once. */
  readonly maxWorkers?: number;
  /** Milliseconds from any fixed point; a test moves it. */
  readonly clock?: () => number;
  /** The script that loads a check in a worker thread; the one of this package unless a test names another. */
  readonly workerUrl?: URL;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/**
 * Runs a check where its measured time says. The time of the last run of each check is kept for the life of the process and replaced by every run: a check over the threshold runs in a worker thread, and one that measures
 * under it again runs in place again. A worker that fails, does not answer within the time or is cancelled gives a refusal, never a value; a worker is stopped as soon as the result is known.
 */
export function createCheckRunner(options: CheckRunnerOptions = {}): CheckRunner {
  const thresholdMs = options.thresholdMs ?? DEFAULT_OFFLOAD_THRESHOLD_MS;
  const clock = options.clock ?? (() => performance.now());
  const workerUrl = options.workerUrl ?? new URL('./check-worker.js', import.meta.url);
  const maxWorkers = options.maxWorkers ?? DEFAULT_MAX_CHECK_WORKERS;
  const lastMs = new Map<string, number>();
  let running = 0;
  const waiting: (() => void)[] = [];

  const releaseWorker = (): void => {
    running -= 1;
    waiting.shift()?.();
  };

  function inWorker<Input, Output>(check: HeavyCheck<Input, Output>, input: Input, limits: { readonly timeoutMs: number; readonly signal?: AbortSignal }): Promise<CheckOutcome<Output>> {
    return new Promise((resolve) => {
      if (limits.signal?.aborted === true) {
        resolve({ status: 'refused', reason: 'cancelled' });
        return;
      }
      let settled = false;
      let worker: Worker | undefined;
      let waitingFor: (() => void) | undefined;
      const finish = (outcome: CheckOutcome<Output>): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        limits.signal?.removeEventListener('abort', onAbort);
        if (waitingFor !== undefined) waiting.splice(waiting.indexOf(waitingFor), 1);
        if (worker !== undefined) {
          void worker.terminate();
          releaseWorker();
        }
        resolve(outcome);
      };
      const timer = setTimeout(() => finish({ status: 'refused', reason: 'timeout' }), limits.timeoutMs);
      function onAbort(): void {
        finish({ status: 'refused', reason: 'cancelled' });
      }
      limits.signal?.addEventListener('abort', onAbort, { once: true });
      const start = (): void => {
        waitingFor = undefined;
        running += 1;
        worker = new Worker(workerUrl, { workerData: { module: check.module.url, exportName: check.module.exportName, input } });
        worker.once('message', (message: unknown) => {
          const ms = isRecord(message) ? message['ms'] : undefined;
          const value = isRecord(message) ? check.parse(message['value']) : undefined;
          if (typeof ms !== 'number' || value === undefined) {
            finish({ status: 'refused', reason: 'worker-failed' });
            return;
          }
          lastMs.set(check.name, ms);
          finish({ status: 'done', value });
        });
        worker.once('error', () => finish({ status: 'refused', reason: 'worker-failed' }));
        worker.once('exit', () => finish({ status: 'refused', reason: 'worker-failed' }));
      };
      if (running < maxWorkers) start();
      else {
        waitingFor = start;
        waiting.push(start);
      }
    });
  }

  return {
    async run(check, input, limits) {
      const last = lastMs.get(check.name);
      if (last !== undefined && last > thresholdMs) return inWorker(check, input, limits);
      const started = clock();
      const value = check.inline(input);
      lastMs.set(check.name, clock() - started);
      return { status: 'done', value };
    },
  };
}

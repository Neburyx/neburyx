import { POLL_MS, PHASE_LIMIT_MS } from './settings.js';
import type { Sample, SampleState } from './readings.js';

export type Settled<T> =
  | { readonly kind: 'value'; readonly value: T; readonly atMs: number }
  | { readonly kind: 'error'; readonly error: unknown; readonly atMs: number }
  | { readonly kind: 'unsettled'; readonly atMs: number };

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Waits for a promise for at most `limitMs`; times are milliseconds since `origin` (a `performance.now()` value). */
export async function settle<T>(pending: Promise<T>, limitMs: number, origin: number): Promise<Settled<T>> {
  const limit = Symbol('limit');
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<typeof limit>((resolve) => {
    timer = setTimeout(() => resolve(limit), limitMs);
  });
  try {
    const result = await Promise.race([
      pending.then(
        (value): Settled<T> => ({ kind: 'value', value, atMs: performance.now() - origin }),
        (error: unknown): Settled<T> => ({ kind: 'error', error, atMs: performance.now() - origin }),
      ),
      timeout,
    ]);
    return result === limit ? { kind: 'unsettled', atMs: limitMs } : result;
  } finally {
    clearTimeout(timer);
  }
}

/** Returns the value, or throws if the promise failed or did not finish in time. */
export async function bounded<T>(what: string, pending: Promise<T>, limitMs = PHASE_LIMIT_MS): Promise<T> {
  const outcome = await settle(pending, limitMs, performance.now());
  if (outcome.kind === 'value') return outcome.value;
  if (outcome.kind === 'error') throw outcome.error;
  throw new Error(`${what} did not finish within ${limitMs} ms`);
}

export function describeError(error: unknown): { errorClass: string; code: string } {
  if (!(error instanceof Error)) return { errorClass: typeof error, code: 'none' };
  const code = 'code' in error && typeof error.code === 'string' ? error.code : 'none';
  return { errorClass: error.constructor.name, code };
}

export function assertNever(value: never): never {
  throw new Error(`unhandled case: ${JSON.stringify(value)}`);
}

export interface Look {
  readonly state: SampleState;
  readonly detail?: string;
}

/** A look, the time its answer arrived (same clock as the poller's), and the cleanup that follows it. */
export interface LookResult {
  readonly look: Look;
  readonly answeredAt: number;
  readonly cleanup: Promise<string | undefined>;
}

interface Raw {
  readonly sent: number;
  readonly received: number;
  readonly look: Look;
}

/** Looks at the server's transaction list on its own schedule, so a stuck client under test cannot hold it up. */
export class Poller {
  private readonly raw: Raw[] = [];
  private readonly cleanups: Promise<string | undefined>[] = [];
  private stopped = false;
  private loop: Promise<void> | undefined;

  constructor(
    private readonly look: () => Promise<LookResult>,
    private readonly intervalMs: number = POLL_MS,
    private readonly now: () => number = () => performance.now(),
  ) {}

  start(): void {
    this.loop = this.run();
  }

  /** Stops looking and waits for the cleanup of every look; returns the cleanups that failed. */
  async stop(): Promise<string[]> {
    this.stopped = true;
    await this.loop;
    const counts = new Map<string, number>();
    for (const outcome of await Promise.all(this.cleanups)) {
      if (outcome !== undefined) counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
    }
    return [...counts].map(([text, count]) => (count > 1 ? `${text} (${count} looks)` : text));
  }

  sawRunning(): boolean {
    return this.raw.some((r) => r.look.state === 'running');
  }

  samples(origin: number): Sample[] {
    return this.raw.map(({ sent, received, look }) => ({
      sentMs: sent - origin,
      atMs: received - origin,
      state: look.state,
      ...(look.detail ? { detail: look.detail } : {}),
    }));
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      const sent = this.now();
      const { look, answeredAt: received, cleanup } = await this.look();
      this.raw.push({ sent, received, look });
      this.cleanups.push(cleanup);
      await sleep(Math.max(0, this.intervalMs - (received - sent)));
    }
  }
}

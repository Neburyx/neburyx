import { describe, expect, it } from 'vitest';
import { observeCancel, type TransactionWatch } from './cancel.js';

/** A watch whose clock only moves when it sleeps, and whose list answers from a script. */
function scripted(listed: readonly boolean[]) {
  let at = 0;
  let looks = 0;
  const watch: TransactionWatch = {
    isListed: () => Promise.resolve(listed[Math.min(looks++, listed.length - 1)] ?? false),
    now: () => at,
    sleep: (ms) => Promise.resolve(void (at += ms)),
  };
  return { watch, looks: () => looks };
}

const untilAborted = (signal: AbortSignal) => new Promise<'cancelled'>((resolve) => signal.addEventListener('abort', () => resolve('cancelled'), { once: true }));

describe('the observation of a cancel', () => {
  it('aborts once the transaction is listed and gives the time of the first look that finds it gone', async () => {
    const { watch } = scripted([false, true, true, true, false]);
    const seen = await observeCancel(untilAborted, watch, { appearMs: 1000, goneMs: 10_000, intervalMs: 25 });
    expect(seen).toEqual({ kind: 'gone', goneAfterMs: 50, looks: 3 });
  });

  it('is finished first when the transaction is never listed within the wait', async () => {
    const { watch } = scripted([false]);
    const seen = await observeCancel(untilAborted, watch, { appearMs: 100, goneMs: 10_000, intervalMs: 25 });
    expect(seen).toEqual({ kind: 'finished-first' });
  });

  it('is finished first when the read ends on its own before it is aborted', async () => {
    const { watch } = scripted([false, false]);
    const seen = await observeCancel(() => Promise.resolve('other' as const), watch, { appearMs: 1000, goneMs: 10_000, intervalMs: 25 });
    expect(seen).toEqual({ kind: 'finished-first' });
  });

  it('fails to be gone when the transaction is still listed after the limit, and says how long it waited', async () => {
    const { watch } = scripted([true]);
    const seen = await observeCancel(untilAborted, watch, { appearMs: 1000, goneMs: 200, intervalMs: 25 });
    expect(seen).toMatchObject({ kind: 'not-gone', waitedMs: 200 });
  });

  it('aborts the read when it gives up waiting for the transaction to be listed', async () => {
    let aborted = false;
    const { watch } = scripted([false]);
    const seen = await observeCancel(
      (signal) =>
        new Promise<'cancelled'>((resolve) =>
          signal.addEventListener('abort', () => {
            aborted = true;
            resolve('cancelled');
          }),
        ),
      watch,
      { appearMs: 50, goneMs: 100, intervalMs: 25 },
    );
    expect(seen).toEqual({ kind: 'finished-first' });
    expect(aborted).toBe(true);
  });
});

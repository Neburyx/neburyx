import { describe, expect, it, vi } from 'vitest';
import { callFor, NOW, rig, useClock } from '../testing/source-rig.js';

const ROWS = [{ n: 1 }, { n: 2 }];

/** Calls the executor with an `onClosed` that records the promise it is given and when that promise settles. */
function closedOf() {
  const seen = { given: 0, settled: false };
  const onClosed = (closed: Promise<void>): void => {
    seen.given += 1;
    void closed.then(() => {
      seen.settled = true;
    });
  };
  return { seen, onClosed };
}

describe('the return of a read connection', () => {
  it('is announced before the answer and settles once the session is closed', async () => {
    useClock();
    const { executor, fake } = rig({ rows: ROWS });
    const { seen, onClosed } = closedOf();
    const answer = await executor.execute(callFor({ onClosed }));
    expect(answer).toEqual({ status: 'rows', rows: ROWS });
    expect(seen.given).toBe(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.drivers[0]?.sessions[0]?.closeCalls).toBe(1);
    expect(seen.settled).toBe(true);
  });

  it('settles when the close is given up after the source timeout, which is logged, and not before', async () => {
    useClock();
    const { executor, logs } = rig({ manual: true, sessionClose: 'hang' });
    const { seen, onClosed } = closedOf();
    const answer = executor.execute(callFor({ deadlineAt: NOW + 1000, onClosed }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(await answer).toEqual({ status: 'timeout' });
    expect(seen.given).toBe(1);
    await vi.advanceTimersByTimeAsync(4999);
    expect(seen.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(seen.settled).toBe(true);
    expect(logs.map((entry) => entry.fields['event'])).toEqual(['source.cleanup_slow']);
  });

  it('is announced for a read that fails with an error the gate is not told the details of', async () => {
    useClock();
    const { executor } = rig({ streamError: new Error('driver fault') });
    const { seen, onClosed } = closedOf();
    await expect(executor.execute(callFor({ onClosed }))).rejects.toMatchObject({ code: 'READ_FAILED' });
    expect(seen.given).toBe(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(seen.settled).toBe(true);
  });
});

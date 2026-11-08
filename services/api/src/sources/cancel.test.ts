import { describe, expect, it, vi } from 'vitest';
import { callFor, NOW, rig, useClock } from '../testing/source-rig.js';

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};
const eventsOf = (fake: ReturnType<typeof rig>['fake']): string[] | undefined => fake.drivers[0]?.sessions[0]?.events;
const sessionOf = (fake: ReturnType<typeof rig>['fake']) => fake.drivers[0]?.sessions[0];

describe('a read whose request is cancelled while it runs', () => {
  it('closes the session as the abort happens, with no rollback before it, and ends as cancelled without waiting for the close', async () => {
    useClock();
    const { executor, fake, logs } = rig({ manual: true, sessionClose: 'hang' });
    const controller = new AbortController();
    const closed: Promise<void>[] = [];
    const answer = executor.execute(callFor({ signal: controller.signal, onClosed: (given) => closed.push(given) }));
    await flush();
    expect(sessionOf(fake)?.closeCalls).toBe(0);
    controller.abort();
    // asked in the abort's own call, not a tick later
    expect(sessionOf(fake)?.closeCalls).toBe(1);
    expect(await answer).toEqual({ status: 'cancelled' });
    await flush();
    expect(eventsOf(fake)).toEqual(['close']);
    expect(sessionOf(fake)?.rollbackCalls).toBe(0);
    expect(closed).toHaveLength(1);
    expect(logs.map((entry) => entry.fields['event'])).not.toContain('source.rollback_slow');
  });

  it('hands over the close before the outcome, and the close promise settles only when the session is closed', async () => {
    useClock();
    const { executor } = rig({ manual: true });
    const controller = new AbortController();
    const order: string[] = [];
    let settled = false;
    const answer = executor.execute(
      callFor({
        signal: controller.signal,
        onClosed: (given) => {
          order.push('closed handed');
          void given.then(() => (settled = true));
        },
      }),
    );
    await flush();
    controller.abort();
    await answer;
    order.push('outcome');
    expect(order).toEqual(['closed handed', 'outcome']);
    await flush();
    expect(settled).toBe(true);
  });

  it('ends a read that is still waiting for its transaction to begin, and never rolls back', async () => {
    useClock();
    const { executor, fake } = rig({ beginHang: true });
    const controller = new AbortController();
    const answer = executor.execute(callFor({ signal: controller.signal }));
    await flush();
    controller.abort();
    expect(await answer).toEqual({ status: 'cancelled' });
    await flush();
    expect(eventsOf(fake)).toEqual(['close']);
  });

  it('ends once when the abort comes twice', async () => {
    useClock();
    const { executor, fake } = rig({ manual: true });
    const controller = new AbortController();
    const answer = executor.execute(callFor({ signal: controller.signal }));
    await flush();
    controller.abort();
    controller.abort();
    expect(await answer).toEqual({ status: 'cancelled' });
    await flush();
    expect(sessionOf(fake)?.closeCalls).toBe(1);
  });
});

describe('a read whose signal is already aborted', () => {
  it('opens no session and reaches no driver', async () => {
    useClock();
    const { executor, fake } = rig({ rows: [{ n: 1 }] });
    const controller = new AbortController();
    controller.abort();
    expect(await executor.execute(callFor({ signal: controller.signal }))).toEqual({ status: 'cancelled' });
    expect(fake.drivers.flatMap((driver) => driver.sessions)).toEqual([]);
  });
});

describe('an abort that comes after the read ended', () => {
  it('changes nothing: the rows are the answer and the end of the read is the usual one', async () => {
    useClock();
    const { executor, fake } = rig({ rows: [{ n: 1 }] });
    const controller = new AbortController();
    const answer = await executor.execute(callFor({ signal: controller.signal }));
    controller.abort();
    await flush();
    expect(answer).toEqual({ status: 'rows', rows: [{ n: 1 }] });
    expect(eventsOf(fake)).toEqual(['rollback', 'close']);
    expect(sessionOf(fake)?.closeCalls).toBe(1);
  });

  it('gives rows or cancelled, never both, when the rows arrive in the abort tick', async () => {
    useClock();
    const { executor, fake } = rig({ manual: true });
    const controller = new AbortController();
    const closes: Promise<void>[] = [];
    const answer = executor.execute(callFor({ signal: controller.signal, onClosed: (given) => closes.push(given) }));
    await flush();
    const observer = sessionOf(fake)?.observer;
    observer?.onNext({ n: 1 });
    observer?.onCompleted();
    controller.abort();
    expect(await answer).toEqual({ status: 'rows', rows: [{ n: 1 }] });
    await flush();
    expect(closes).toHaveLength(1);
    expect(sessionOf(fake)?.closeCalls).toBe(1);
  });
});

describe('a read that is not cancelled', () => {
  it('still ends with a rollback before the close, and keeps no abort listener on the signal', async () => {
    useClock();
    const { executor, fake } = rig({ rows: [{ n: 1 }] });
    const controller = new AbortController();
    await executor.execute(callFor({ signal: controller.signal, deadlineAt: NOW + 1000 }));
    await flush();
    expect(eventsOf(fake)).toEqual(['rollback', 'close']);
    // a listener left behind would close a finished read's session a second time
    controller.abort();
    await flush();
    expect(sessionOf(fake)?.closeCalls).toBe(1);
  });
});

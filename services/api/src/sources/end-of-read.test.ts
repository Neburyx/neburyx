import { describe, expect, it, vi } from 'vitest';
import { neo4jError } from '../testing/fake-source-driver.js';
import { callFor, NOW, rig, useClock } from '../testing/source-rig.js';

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};
const ROWS = [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }, { n: 5 }];
const eventsOf = (fake: ReturnType<typeof rig>['fake']): string[] | undefined => fake.drivers[0]?.sessions[0]?.events;

describe('the end of a read: its transaction is rolled back before its session is closed', () => {
  // the driver has asked for the next batch of a result that is still streaming, and only a rollback cancels that; a close alone leaves a reply for the connection's next user
  it.each([
    ['the row limit is reached while the source has more', { rows: ROWS, endless: true }, {}, { status: 'rows', rows: ROWS.slice(0, 3) }],
    ['the stream ends within the limit', { rows: ROWS.slice(0, 2) }, {}, { status: 'rows', rows: ROWS.slice(0, 2) }],
    ['the stream ends with no row', { rows: [] }, {}, { status: 'rows', rows: [] }],
    ['the server refuses the query', { streamError: neo4jError('Neo.ClientError.Security.Forbidden') }, {}, { status: 'unavailable', reason: 'refused' }, ['source.read_failed']],
    ['the server says the transaction timed out', { streamError: neo4jError('Neo.ClientError.Transaction.TransactionTimedOut') }, {}, { status: 'timeout' }],
  ] as const)('when %s', async (_name, behaviour, overrides, answer, logged: readonly string[] = []) => {
    useClock();
    const { executor, fake, logs } = rig(behaviour);
    expect(await executor.execute(callFor(overrides))).toEqual(answer);
    await flush();
    expect(eventsOf(fake)).toEqual(['rollback', 'close']);
    // only what a failed read logged before: nothing about the rollback
    expect(logs.map((entry) => entry.fields['event'])).toEqual(logged);
  });

  it('when the guard timer ends the read while the query still runs', async () => {
    useClock();
    const { executor, fake } = rig({ manual: true });
    const answer = executor.execute(callFor({ deadlineAt: NOW + 1000 }));
    await flush();
    expect(eventsOf(fake)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await answer).toEqual({ status: 'timeout' });
    await flush();
    expect(eventsOf(fake)).toEqual(['rollback', 'close']);
  });

  it('closes only the session when the transaction was never begun: it hangs, or it fails', async () => {
    useClock();
    const hanging = rig({ beginHang: true });
    const waiting = hanging.executor.execute(callFor({ deadlineAt: NOW + 1000 }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(await waiting).toEqual({ status: 'timeout' });
    await flush();
    expect(eventsOf(hanging.fake)).toEqual(['close']);
    const failing = rig({ beginError: neo4jError('Neo.ClientError.Security.Unauthorized') });
    expect(await failing.executor.execute(callFor())).toEqual({ status: 'unavailable', reason: 'authentication' });
    await flush();
    expect(eventsOf(failing.fake)).toEqual(['close']);
  });

  it('asks for the transaction of the read that was cut short, once, and never for another read', async () => {
    useClock();
    const { executor, fake } = rig({ rows: ROWS, endless: true });
    await executor.execute(callFor());
    await executor.execute(callFor());
    await flush();
    expect(fake.drivers[0]?.sessions.map((session) => session.events)).toEqual([
      ['rollback', 'close'],
      ['rollback', 'close'],
    ]);
  });
});

describe('a rollback that fails or does not answer', () => {
  it('changes no answer: a rollback that fails is not reported, and the session is still closed', async () => {
    useClock();
    const { executor, fake, logs } = rig({ rows: ROWS, endless: true, rollback: 'reject' });
    expect(await executor.execute(callFor())).toEqual({ status: 'rows', rows: ROWS.slice(0, 3) });
    await flush();
    expect(eventsOf(fake)).toEqual(['rollback', 'close']);
    expect(logs).toEqual([]);
  });

  it('does not delay the answer, and closes the session after a second, saying once that the rollback is slow', async () => {
    useClock();
    const { executor, fake, logs } = rig({ rows: ROWS, endless: true, rollback: 'hang' });
    expect(await executor.execute(callFor())).toEqual({ status: 'rows', rows: ROWS.slice(0, 3) });
    await vi.advanceTimersByTimeAsync(999);
    expect(eventsOf(fake)).toEqual(['rollback']);
    await vi.advanceTimersByTimeAsync(1);
    expect(eventsOf(fake)).toEqual(['rollback', 'close']);
    expect(logs).toEqual([{ fields: { event: 'source.rollback_slow', sourceId: 'demo' }, message: 'source rollback is taking too long' }]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(logs).toHaveLength(1);
  });

  it('does not delay the answer of the guard timer either', async () => {
    useClock();
    const { executor, fake } = rig({ manual: true, rollback: 'hang' });
    const answer = executor.execute(callFor({ deadlineAt: NOW + 1000 }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(await answer).toEqual({ status: 'timeout' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(eventsOf(fake)).toEqual(['rollback', 'close']);
  });

  it('keeps the report of a close that also hangs, once the source timeout has passed after the rollback wait', async () => {
    useClock();
    const { executor, logs } = rig({ rows: [], rollback: 'hang', sessionClose: 'hang' });
    await executor.execute(callFor());
    await vi.advanceTimersByTimeAsync(5000);
    expect(logs.map((entry) => entry.fields['event'])).toEqual(['source.rollback_slow', 'source.cleanup_slow']);
  });

  it('is waited for by close() no longer than the source timeout, as a close is', async () => {
    useClock();
    const { executor, fake } = rig({ rows: [], rollback: 'hang', sessionClose: 'hang' });
    await executor.execute(callFor());
    const closing = executor.close();
    await vi.advanceTimersByTimeAsync(5000);
    await closing;
    expect(fake.drivers[0]?.closeCalls).toBe(1);
  });
});

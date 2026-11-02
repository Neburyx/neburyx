import { describe, expect, it, vi } from 'vitest';
import { neo4jError } from '../testing/fake-source-driver.js';
import { AdapterError } from './errors.js';
import { callFor, ENV, NOW, rig, useClock } from '../testing/source-rig.js';

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

describe('a read that runs out of time', () => {
  it('answers timeout when the deadline has already passed, and opens nothing', async () => {
    useClock();
    const { executor, fake } = rig({ rows: [{ n: 1 }] });
    expect(await executor.execute(callFor({ deadlineAt: NOW }))).toEqual({ status: 'timeout' });
    expect(await executor.execute(callFor({ deadlineAt: NOW - 5 }))).toEqual({ status: 'timeout' });
    expect(fake.drivers).toHaveLength(0);
  });

  it.each(['Neo.ClientError.Transaction.TransactionTimedOut', 'Neo.ClientError.Transaction.TransactionTimedOutClientConfiguration'])(
    'answers timeout for the server code %s',
    async (code) => {
      useClock();
      const { executor } = rig({ streamError: neo4jError(code) });
      expect(await executor.execute(callFor())).toEqual({ status: 'timeout' });
    },
  );

  it('answers timeout from the guard when the deadline arrives while the query is still running, and starts closing the session', async () => {
    useClock();
    const { executor, fake } = rig({ manual: true });
    const answer = executor.execute(callFor({ deadlineAt: NOW + 1000 }));
    await flush();
    expect(fake.drivers[0]?.sessions[0]?.closeCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await answer).toEqual({ status: 'timeout' });
    expect(fake.drivers[0]?.sessions[0]?.closeCalls).toBe(1);
  });

  it('answers timeout from the guard when the transaction cannot even be opened in time', async () => {
    useClock();
    const { executor, fake } = rig({ beginHang: true });
    const answer = executor.execute(callFor({ deadlineAt: NOW + 1000 }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(await answer).toEqual({ status: 'timeout' });
    expect(fake.drivers[0]?.sessions[0]?.closeCalls).toBe(1);
  });

  it.each(['hang', 'reject'] as const)('answers timeout when the session close %ss, and does not wait for it', async (sessionClose) => {
    useClock();
    const { executor, fake, logs } = rig({ manual: true, sessionClose });
    const answer = executor.execute(callFor({ deadlineAt: NOW + 1000 }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(await answer).toEqual({ status: 'timeout' });
    expect(fake.drivers[0]?.sessions[0]?.closeCalls).toBe(1);
    if (sessionClose === 'reject') expect(logs.map((entry) => entry.fields['event'])).toEqual(['source.cleanup_failed']);
  });

  it('keeps the answer when the pending call finishes or fails after the guard, without an unhandled rejection', async () => {
    useClock();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const { executor, fake } = rig({ manual: true });
      const answer = executor.execute(callFor({ deadlineAt: NOW + 1000 }));
      await flush();
      await vi.advanceTimersByTimeAsync(1000);
      expect(await answer).toEqual({ status: 'timeout' });
      const observer = fake.drivers[0]?.sessions[0]?.observer;
      observer?.onNext({ n: 1 });
      observer?.onError(neo4jError('Neo.ClientError.Transaction.Terminated'));
      observer?.onCompleted();
      await vi.advanceTimersByTimeAsync(10);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('does not let a transaction that opens after the guard run its query', async () => {
    useClock();
    let release: () => void = () => undefined;
    const { executor, fake } = rig({ beginGate: new Promise<void>((resolve) => (release = resolve)) });
    const answer = executor.execute(callFor({ deadlineAt: NOW + 1000 }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(await answer).toEqual({ status: 'timeout' });
    release();
    await flush();
    expect(fake.drivers[0]?.sessions[0]?.queries).toEqual([]);
  });
});

describe('a source that cannot be reached', () => {
  it.each([
    ['a connection failure', 'ServiceUnavailable'],
    ['a lost session', 'SessionExpired'],
  ])('answers unavailable for %s, keeps the driver and recovers on the next call', async (_name, code) => {
    useClock();
    const made = rig({ beginError: neo4jError(code) });
    expect(await made.executor.execute(callFor())).toEqual({ status: 'unavailable', reason: 'unreachable' });
    made.fake.behaviour = { rows: [{ n: 1 }] };
    expect(await made.executor.execute(callFor())).toEqual({ status: 'rows', rows: [{ n: 1 }] });
    expect(made.fake.drivers).toHaveLength(1);
    expect(made.fake.drivers[0]?.closeCalls).toBe(0);
  });

  it('answers unavailable for a pool acquisition timeout, which the driver raises without a code of its own', async () => {
    useClock();
    const { executor } = rig({ beginError: neo4jError('N/A', 'Connection acquisition timed out in 2000 ms. Pool status: Active conn count = 1, Idle conn count = 0.') });
    expect(await executor.execute(callFor())).toEqual({ status: 'unavailable', reason: 'pool-full' });
  });

  it('answers unavailable for an authentication failure and discards the driver, so corrected credentials are read again', async () => {
    useClock();
    const made = rig({ beginError: neo4jError('Neo.ClientError.Security.Unauthorized') });
    expect(await made.executor.execute(callFor())).toEqual({ status: 'unavailable', reason: 'authentication' });
    await flush();
    expect(made.fake.drivers[0]?.closeCalls).toBe(1);
    made.env['DEMO_PASSWORD'] = 'the corrected password';
    made.fake.behaviour = { rows: [{ n: 1 }] };
    expect(await made.executor.execute(callFor())).toEqual({ status: 'rows', rows: [{ n: 1 }] });
    expect(made.fake.drivers).toHaveLength(2);
    expect(made.fake.drivers[1]?.settings.password).toBe('the corrected password');
    expect(ENV.DEMO_PASSWORD).toBe('a password value');
  });

  it.each(['Neo.ClientError.Security.AuthenticationRateLimit', 'Neo.ClientError.Security.CredentialsExpired'])('treats %s as an authentication failure', async (code) => {
    useClock();
    const made = rig({ streamError: neo4jError(code) });
    expect(await made.executor.execute(callFor())).toEqual({ status: 'unavailable', reason: 'authentication' });
    await flush();
    expect(made.fake.drivers[0]?.closeCalls).toBe(1);
  });
});

describe('any other driver error', () => {
  const MARKERS = ['MARKER_QUERY_TEXT', 'MARKER_PARAMETER', 'MARKER_ROW', 'MARKER_MESSAGE'];

  it('is thrown as an AdapterError with a fixed code, and neither it nor the logs hold the query, a parameter, a row or the driver message', async () => {
    useClock();
    const made = rig({ rows: [{ value: 'MARKER_ROW' }], streamError: neo4jError('Neo.ClientError.Statement.SyntaxError', 'MARKER_MESSAGE near MARKER_QUERY_TEXT') });
    const attempt = made.executor.execute(callFor({ cypher: 'RETURN MARKER_QUERY_TEXT', parameters: { value: 'MARKER_PARAMETER' } }));
    await expect(attempt).rejects.toThrow(AdapterError);
    const error = await attempt.catch((caught: unknown) => caught);
    expect(error).toMatchObject({ name: 'AdapterError', code: 'READ_FAILED', message: 'The source could not run the read.' });
    await flush();
    const everything = JSON.stringify([String(error), made.logs]);
    for (const marker of MARKERS) expect(everything).not.toContain(marker);
    expect(made.logs[0]?.fields).toEqual({ event: 'source.read_failed', sourceId: 'demo', serverCode: 'Neo.ClientError.Statement.SyntaxError' });
  });

  it('is thrown for an error that carries no code, and still holds no driver text', async () => {
    useClock();
    const made = rig({ beginError: new Error('MARKER_MESSAGE') });
    await expect(made.executor.execute(callFor())).rejects.toThrow('The source could not run the read.');
    expect(JSON.stringify(made.logs)).not.toContain('MARKER_MESSAGE');
  });
});

describe('the cleanup after a call', () => {
  it('logs a close that fails at once, and a close still running when the source timeout has passed once, with the source id only', async () => {
    useClock();
    const failing = rig({ rows: [], sessionClose: 'reject' });
    await failing.executor.execute(callFor());
    await flush();
    expect(failing.logs).toEqual([{ fields: { event: 'source.cleanup_failed', sourceId: 'demo' }, message: 'source cleanup failed' }]);

    const hanging = rig({ rows: [], sessionClose: 'hang' });
    await hanging.executor.execute(callFor());
    await vi.advanceTimersByTimeAsync(4999);
    expect(hanging.logs).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(hanging.logs).toEqual([{ fields: { event: 'source.cleanup_slow', sourceId: 'demo' }, message: 'source cleanup is taking too long' }]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(hanging.logs).toHaveLength(1);
  });
});

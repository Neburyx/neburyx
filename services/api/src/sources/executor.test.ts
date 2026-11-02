import { describe, expect, it, vi } from 'vitest';
import { createNeo4jExecutor } from './executor.js';
import { fakeDrivers, neo4jError } from '../testing/fake-source-driver.js';
import { AdapterError } from './errors.js';
import { callFor, ENV, NOW, rig, sourceModel, useClock } from '../testing/source-rig.js';

const ROWS = [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }, { n: 5 }];

describe('rows within the row limit', () => {
  it('answers exactly the row limit when the query would produce more, and stops reading', async () => {
    useClock();
    const { executor, fake } = rig({ rows: ROWS, endless: true });
    expect(await executor.execute(callFor())).toEqual({ status: 'rows', rows: ROWS.slice(0, 3) });
    expect(fake.drivers[0]?.sessions[0]?.closeCalls).toBe(1);
  });

  it('answers all rows when there are fewer than the limit, and an empty list for none', async () => {
    useClock();
    const first = rig({ rows: ROWS.slice(0, 2) });
    expect(await first.executor.execute(callFor())).toEqual({ status: 'rows', rows: ROWS.slice(0, 2) });
    const second = rig({ rows: [] });
    expect(await second.executor.execute(callFor())).toEqual({ status: 'rows', rows: [] });
  });

  it('ignores whatever the stream does after the limit was reached', async () => {
    useClock();
    const { executor, fake } = rig({ manual: true });
    const answer = executor.execute(callFor({ rowLimit: 2 }));
    await vi.advanceTimersByTimeAsync(0);
    const observer = fake.drivers[0]?.sessions[0]?.observer;
    observer?.onNext({ n: 1 });
    observer?.onNext({ n: 2 });
    observer?.onNext({ n: 3 });
    observer?.onError(neo4jError('Neo.ClientError.Transaction.Terminated'));
    observer?.onCompleted();
    expect(await answer).toEqual({ status: 'rows', rows: [{ n: 1 }, { n: 2 }] });
  });
});

describe('the transaction', () => {
  it('is an explicit read transaction in a session on the mapping database with the row limit as fetch size', async () => {
    useClock();
    const { executor, fake } = rig({ rows: [] });
    await executor.execute(callFor({ rowLimit: 7 }));
    const session = fake.drivers[0]?.sessions[0];
    expect(session?.config).toEqual({ database: 'graph-db', defaultAccessMode: 'READ', fetchSize: 7 });
    expect(session?.begins).toEqual([{ timeout: 5000, metadata: { traceId: 'trace-1', templateId: 'search', templateVersion: '1' } }]);
    expect(session?.queries).toEqual([{ cypher: 'MATCH (n) RETURN n', parameters: { text: 'x' } }]);
  });

  it.each([
    ['the call timeout is nearer', { timeoutMs: 2000, deadlineAt: NOW + 10_000 }, 2000],
    ['the deadline is nearer', { timeoutMs: 5000, deadlineAt: NOW + 1500 }, 1500],
  ])('has the smaller of the call timeout and the time left to the deadline when %s', async (_name, overrides, expected) => {
    useClock();
    const { executor, fake } = rig({ rows: [] });
    await executor.execute(callFor(overrides));
    expect(fake.drivers[0]?.sessions[0]?.begins[0]?.timeout).toBe(expected);
  });

  it('is never shorter than one millisecond', async () => {
    useClock();
    const { executor, fake } = rig({ rows: [] });
    await executor.execute(callFor({ deadlineAt: NOW + 0.4 }));
    expect(fake.drivers[0]?.sessions[0]?.begins[0]?.timeout).toBe(1);
  });
});

describe('a call the adapter will not run', () => {
  it.each([
    ['the user variable is missing', { DEMO_PASSWORD: 'x' }],
    ['the password variable is missing', { DEMO_USER: 'x' }],
    ['the user variable is empty', { DEMO_USER: '', DEMO_PASSWORD: 'x' }],
    ['the password variable is empty', { DEMO_USER: 'x', DEMO_PASSWORD: '' }],
  ])('answers unavailable without connecting when %s, and logs only the source id', async (_name, env) => {
    useClock();
    const { executor, fake, logs } = rig({ rows: ROWS }, [sourceModel()], env);
    expect(await executor.execute(callFor())).toEqual({ status: 'unavailable' });
    expect(fake.drivers).toHaveLength(0);
    expect(logs).toEqual([{ fields: { event: 'source.credentials_missing', sourceId: 'demo' }, message: 'source credentials are not set' }]);
  });

  it('reads the credentials again on the next call and recovers once they are set', async () => {
    useClock();
    const made = rig({ rows: [] }, [sourceModel()], {});
    expect(await made.executor.execute(callFor())).toEqual({ status: 'unavailable' });
    Object.assign(made.env, ENV);
    expect(await made.executor.execute(callFor())).toEqual({ status: 'rows', rows: [] });
    expect(made.fake.drivers[0]?.settings).toMatchObject({ username: 'reader', password: 'a password value' });
  });

  it('answers unavailable for a source id that is not in the mapping', async () => {
    useClock();
    const { executor, fake } = rig({ rows: ROWS });
    expect(await executor.execute(callFor({ sourceId: 'other' }))).toEqual({ status: 'unavailable' });
    expect(fake.drivers).toHaveLength(0);
  });

  it('refuses a call whose access mode is not READ, before anything is opened', async () => {
    useClock();
    const { executor, fake } = rig({ rows: ROWS });
    await expect(executor.execute(Object.assign(callFor(), { accessMode: 'WRITE' }))).rejects.toThrow(AdapterError);
    expect(fake.drivers).toHaveLength(0);
  });
});

describe('a driver that cannot be created', () => {
  it('is thrown as an AdapterError without the driver message, which can hold the address, and is tried again on the next call', async () => {
    useClock();
    const logs: { fields: object; message: string }[] = [];
    let broken = true;
    const working = fakeDrivers({ rows: [] });
    const executor = createNeo4jExecutor({
      sources: [sourceModel()],
      env: { ...ENV },
      logger: { warn: (fields, message) => logs.push({ fields, message }) },
      clock: () => Date.now(),
      createDriver: (settings) => {
        if (broken) throw new Error('Invalid URI bolt://graph.example.test:7687?region=MARKER_ADDRESS');
        return working.factory(settings);
      },
    });
    await expect(executor.execute(callFor())).rejects.toThrow('The source could not run the read.');
    expect(JSON.stringify(logs)).not.toContain('MARKER_ADDRESS');
    expect(logs).toEqual([{ fields: { event: 'source.read_failed', sourceId: 'demo', serverCode: undefined }, message: 'source read failed' }]);
    broken = false;
    expect(await executor.execute(callFor())).toEqual({ status: 'rows', rows: [] });
    await executor.close();
  });
});

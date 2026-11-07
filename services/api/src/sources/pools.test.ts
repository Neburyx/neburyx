import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { callFor, rig, sourceModel, useClock } from '../testing/source-rig.js';

const second = (): ReturnType<typeof sourceModel> => sourceModel({ id: 'other', database: 'second-db' });

describe('one pool per source', () => {
  it('creates a source driver on its first call and none for a source nobody has called', async () => {
    useClock();
    const { executor, fake } = rig({ rows: [] }, [sourceModel(), second()]);
    expect(fake.drivers).toHaveLength(0);
    await executor.execute(callFor());
    expect(fake.drivers).toHaveLength(1);
    await executor.execute(callFor({ sourceId: 'other' }));
    expect(fake.drivers).toHaveLength(2);
    await executor.execute(callFor());
    expect(fake.drivers).toHaveLength(2);
    expect(fake.drivers.map((driver) => driver.sessions[0]?.config.database)).toEqual(['graph-db', 'second-db']);
  });

  it('sizes each pool from the budgets of its own source: twice its slots, so a connection still closing never holds back a read that has its slot', async () => {
    useClock();
    const small = sourceModel({ budgets: { source_concurrency: 4, queue_wait_ms: 1500, timeout_ms: 3000 } });
    const large = sourceModel({ id: 'other', budgets: { source_concurrency: 40, queue_wait_ms: 500, timeout_ms: 9000 } });
    const { executor, fake } = rig({ rows: [] }, [small, large]);
    await executor.execute(callFor());
    await executor.execute(callFor({ sourceId: 'other' }));
    expect(fake.drivers.map((driver) => [driver.settings.maxConnectionPoolSize, driver.settings.connectionAcquisitionTimeout, driver.settings.connectionTimeout])).toEqual([
      [8, 1500, 3000],
      [80, 500, 9000],
    ]);
  });

  it('creates exactly one driver for concurrent first calls to one source', async () => {
    useClock();
    const { executor, fake } = rig({ rows: [] });
    await Promise.all(Array.from({ length: 10 }, () => executor.execute(callFor())));
    expect(fake.drivers).toHaveLength(1);
    expect(fake.drivers[0]?.sessions).toHaveLength(10);
  });
});

describe('the address handed to the driver', () => {
  it.each(['neo4j+s', 'bolt+s', 'neo4j+ssc', 'bolt+ssc', 'neo4j', 'bolt'])('is passed as written for the scheme %s, with no encryption or trust setting added', async (scheme) => {
    useClock();
    const uri = `${scheme}://graph.example.test:7687`;
    const { executor, fake } = rig({ rows: [] }, [sourceModel({ uri })]);
    await executor.execute(callFor());
    expect(fake.drivers[0]?.settings.uri).toBe(uri);
    expect(Object.keys(fake.drivers[0]?.settings ?? {}).sort()).toEqual(['connectionAcquisitionTimeout', 'connectionTimeout', 'maxConnectionPoolSize', 'password', 'uri', 'username']);
  });

  it('reaches the real driver with nothing but the three pool settings', () => {
    const text = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'driver.ts'), 'utf8');
    expect(text).not.toMatch(/encrypted|trust/i);
    const config = /neo4j\.driver\([^]*?\{([^}]*)\}\);/.exec(text)?.[1] ?? '';
    expect(config.match(/\w+(?=:)/g)).toEqual(['maxConnectionPoolSize', 'connectionAcquisitionTimeout', 'connectionTimeout']);
  });
});

describe('closing the executor', () => {
  it('closes every driver, tolerates one that fails to close, does nothing the second time and answers unavailable afterwards', async () => {
    useClock();
    const made = rig({ rows: [], driverClose: 'reject' }, [sourceModel(), second()]);
    await made.executor.execute(callFor());
    await made.executor.execute(callFor({ sourceId: 'other' }));
    await made.executor.close();
    expect(made.fake.drivers.map((driver) => driver.closeCalls)).toEqual([1, 1]);
    await made.executor.close();
    expect(made.fake.drivers.map((driver) => driver.closeCalls)).toEqual([1, 1]);
    expect(await made.executor.execute(callFor())).toEqual({ status: 'unavailable', reason: 'closed' });
    expect(made.fake.drivers).toHaveLength(2);
  });

  it('logs each driver that fails to close with its source id only, and still closes the others', async () => {
    useClock();
    const made = rig({ rows: [], driverClose: 'reject' }, [sourceModel(), second()]);
    await made.executor.execute(callFor());
    await made.executor.execute(callFor({ sourceId: 'other' }));
    await made.executor.close();
    expect(made.logs).toEqual([
      { fields: { event: 'source.driver_close_failed', sourceId: 'demo' }, message: 'source driver did not close' },
      { fields: { event: 'source.driver_close_failed', sourceId: 'other' }, message: 'source driver did not close' },
    ]);
  });

  it('waits for a pending cleanup no longer than the timeout of its source', async () => {
    useClock();
    const made = rig({ rows: [], sessionClose: 'hang' }, [sourceModel({ budgets: { timeout_ms: 3000 } })]);
    await made.executor.execute(callFor());
    const done = vi.fn();
    void made.executor.close().then(done);
    await vi.advanceTimersByTimeAsync(2999);
    expect(done).not.toHaveBeenCalled();
    expect(made.fake.drivers[0]?.closeCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toHaveBeenCalledTimes(1);
    expect(made.fake.drivers[0]?.closeCalls).toBe(1);
  });
});

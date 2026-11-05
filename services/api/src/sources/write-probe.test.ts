import { describe, expect, it, vi } from 'vitest';
import { mappingOf, sourceWith } from '../testing/gate-fixtures.js';
import { fakeProbeDriver, type FakeProbeBehaviour } from '../testing/fake-probe-driver.js';
import { neo4jError } from '../testing/fake-source-driver.js';
import { runWriteProbe } from './write-probe.js';

const ENV = { MARKER_USER_VAR: 'MARKER_USER_VALUE', MARKER_PASS_VAR: 'MARKER_PASS_VALUE' };
const AUTH = { kind: 'basic', username_env: 'MARKER_USER_VAR', password_env: 'MARKER_PASS_VAR' };
const [source] = mappingOf(sourceWith('alpha', { uri: 'neo4j+s://MARKER_HOST.example.test:7687', database: 'investigations', auth: AUTH, budgets: { timeout_ms: 3000 } })).sources;
if (source === undefined) throw new Error('the fixture has a source');

function rig(behaviour: FakeProbeBehaviour = {}, env: Record<string, string | undefined> = ENV) {
  const fake = fakeProbeDriver(behaviour);
  const logs: { fields: object; message: string }[] = [];
  const run = () => runWriteProbe(source, 'tr-probe', { env, logger: { warn: (fields, message) => void logs.push({ fields, message }) }, createDriver: fake.factory });
  return { fake, logs, run };
}

describe('a server that accepts the statement', () => {
  it('is answered can-write after one write transaction on the source database, run and rolled back, with nothing else called', async () => {
    const { fake, run } = rig();
    expect(await run()).toBe('can-write');
    expect(fake.settings).toHaveLength(1);
    expect(fake.sessions).toHaveLength(1);
    const [session] = fake.sessions;
    expect(session?.config).toEqual({ database: 'investigations', defaultAccessMode: 'WRITE' });
    expect(session?.begins).toEqual([{ timeout: 3000, metadata: { traceId: 'tr-probe' } }]);
    expect(session?.statements).toEqual(['CREATE () RETURN 1 AS probe']);
    expect(session?.rollbacks).toBe(1);
    expect(session?.closeCalls).toBe(1);
    expect(fake.driverCloseCalls).toBe(1);
    expect(fake.forbidden).toEqual([]);
  });

  it('runs a statement that holds no label, relationship type, property key or input', async () => {
    const { fake, run } = rig();
    await run();
    expect(fake.sessions[0]?.statements.every((statement) => !/[:{}$`'"]/.test(statement))).toBe(true);
  });

  it('opens its own driver with the source address, the credentials the mapping names and a pool of one', async () => {
    const { fake, run } = rig();
    await run();
    expect(fake.settings[0]).toMatchObject({ uri: 'neo4j+s://MARKER_HOST.example.test:7687', username: 'MARKER_USER_VALUE', password: 'MARKER_PASS_VALUE', maxConnectionPoolSize: 1, connectionTimeout: 3000 });
  });
});

describe('a server that refuses the statement', () => {
  it.each(['Neo.ClientError.Security.Forbidden', 'Neo.ClientError.General.ForbiddenOnReadOnlyDatabase', 'Neo.ClientError.General.WriteOnReadOnlyAccessDatabase'])('with %s is answered cannot-write, and the transaction is still rolled back', async (code) => {
    const { fake, run } = rig({ runError: neo4jError(code) });
    expect(await run()).toBe('cannot-write');
    expect(fake.sessions[0]?.rollbacks).toBe(1);
    expect(fake.driverCloseCalls).toBe(1);
    expect(fake.forbidden).toEqual([]);
  });

  it.each([
    ['a database that is not available', neo4jError('Neo.TransientError.General.DatabaseUnavailable')],
    ['a secondary of a cluster', neo4jError('Neo.ClientError.Cluster.NotALeader')],
    ['a timeout', neo4jError('Neo.ClientError.Transaction.TransactionTimedOut')],
    ['a lost connection', neo4jError('ServiceUnavailable')],
    ['an error with no code', new Error('MARKER_MESSAGE')],
    ['any other refusal', neo4jError('Neo.ClientError.Statement.SyntaxError')],
  ])('with %s is answered inconclusive', async (_name, error) => {
    const { fake, run } = rig({ runError: error });
    expect(await run()).toBe('inconclusive');
    expect(fake.sessions[0]?.rollbacks).toBe(1);
    expect(fake.driverCloseCalls).toBe(1);
  });

  it('is answered cannot-write when the server refuses to open the transaction for the login, with nothing to roll back', async () => {
    const { fake, run } = rig({ beginError: neo4jError('Neo.ClientError.Security.Forbidden') });
    expect(await run()).toBe('cannot-write');
    expect(fake.sessions[0]?.rollbacks).toBe(0);
    expect(fake.sessions[0]?.statements).toEqual([]);
    expect(fake.driverCloseCalls).toBe(1);
  });

  it('is answered inconclusive when the transaction cannot be opened because the source is down, with nothing to roll back', async () => {
    const { fake, run } = rig({ beginError: neo4jError('ServiceUnavailable') });
    expect(await run()).toBe('inconclusive');
    expect(fake.sessions[0]?.rollbacks).toBe(0);
    expect(fake.driverCloseCalls).toBe(1);
  });
});

describe('a probe that cannot start', () => {
  it.each([
    ['both credentials unset', {}],
    ['the user empty', { ...ENV, MARKER_USER_VAR: '' }],
    ['the password unset', { MARKER_USER_VAR: 'u' }],
  ])('with %s is answered inconclusive and opens no driver', async (_name, env) => {
    const { fake, run } = rig({}, env);
    expect(await run()).toBe('inconclusive');
    expect(fake.settings).toEqual([]);
  });
});

describe('a driver that cannot be opened', () => {
  it('is answered inconclusive when the factory throws, and when the session cannot be opened the driver is still closed', async () => {
    const thrown = await runWriteProbe(source, 'tr-probe', { env: ENV, logger: { warn: () => undefined }, createDriver: () => { throw new Error('MARKER_MESSAGE'); } });
    expect(thrown).toBe('inconclusive');
    const fake = fakeProbeDriver();
    const closing = await runWriteProbe(source, 'tr-probe', {
      env: ENV,
      logger: { warn: () => undefined },
      createDriver: (settings) => ({ ...fake.factory(settings), session: () => { throw new Error('MARKER_MESSAGE'); } }),
    });
    expect(closing).toBe('inconclusive');
    expect(fake.driverCloseCalls).toBe(1);
  });
});

describe('a rollback that fails', () => {
  it('is logged once with the source ID only, and the answer stands with the driver closed', async () => {
    const { fake, logs, run } = rig({ rollbackError: neo4jError('ServiceUnavailable', 'MARKER_MESSAGE') });
    expect(await run()).toBe('can-write');
    expect(logs).toEqual([{ fields: { event: 'source.write_probe_rollback_failed', sourceId: 'alpha' }, message: 'source write probe rollback failed' }]);
    expect(JSON.stringify(logs)).not.toContain('MARKER');
    expect(fake.driverCloseCalls).toBe(1);
  });
});

describe('a source that does not answer', () => {
  it.each([
    ['opening the transaction', { beginHang: true }],
    ['the statement', { runHang: true }],
  ] as const)('is answered inconclusive when %s hangs, within the budget of the source, and the driver is closed', async (_name, behaviour) => {
    vi.useFakeTimers();
    try {
      const { fake, run } = rig(behaviour);
      const answer = run();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await answer).toBe('inconclusive');
      expect(fake.driverCloseCalls).toBe(1);
      expect(fake.sessions[0]?.closeCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the answer when the rollback hangs', async () => {
    vi.useFakeTimers();
    try {
      const { fake, run } = rig({ rollbackHang: true });
      const answer = run();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await answer).toBe('can-write');
      expect(fake.driverCloseCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the fake driver', () => {
  it('records the calls the probe must never make', () => {
    const fake = fakeProbeDriver();
    const driver = fake.factory({ uri: 'bolt://x', username: 'u', password: 'p', maxConnectionPoolSize: 1, connectionAcquisitionTimeout: 1, connectionTimeout: 1 });
    const session = driver.session({ database: 'x', defaultAccessMode: 'WRITE' });
    for (const [owner, name] of [[session, 'run'], [session, 'executeWrite'], [session, 'writeTransaction'], [session, 'executeQuery'], [driver, 'executeQuery']] as const) {
      const call: unknown = Reflect.get(owner, name);
      expect(call).toBeTypeOf('function');
      if (typeof call === 'function') expect(() => call()).toThrow('must not be called');
    }
    expect(fake.forbidden).toEqual(['session.run', 'executeWrite', 'writeTransaction', 'session.executeQuery', 'driver.executeQuery']);
  });
});

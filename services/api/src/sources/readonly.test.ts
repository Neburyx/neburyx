import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { expectNoForbiddenCalls, fakeDrivers, neo4jError, type FakeBehaviour } from '../testing/fake-source-driver.js';
import { callFor, rig, useClock } from '../testing/source-rig.js';
import { AdapterError } from './errors.js';

const SOURCES = dirname(fileURLToPath(import.meta.url));
const FORBIDDEN = /\b(?:WRITE|executeRead|executeWrite|readTransaction|writeTransaction|executeQuery)\b/;
const scratch = mkdtempSync(join(tmpdir(), 'readonly-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function productionFiles(folder: string): string[] {
  return readdirSync(folder)
    .filter((name) => /\.[cm]?[jt]sx?$/.test(name) && !/\.test\.[cm]?[jt]sx?$/.test(name))
    .map((name) => join(folder, name));
}

function forbiddenIn(file: string): string | undefined {
  return FORBIDDEN.exec(readFileSync(file, 'utf8'))?.[0];
}

interface ExecutorPath {
  readonly name: string;
  readonly behaviour: FakeBehaviour;
  readonly overrides?: Parameters<typeof callFor>[0];
  readonly answer: string;
}

const PATHS: readonly ExecutorPath[] = [
  { name: 'rows', behaviour: { rows: [{ n: 1 }] }, answer: 'rows' },
  { name: 'the row limit reached', behaviour: { rows: [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }], endless: true }, answer: 'rows' },
  { name: 'a server timeout', behaviour: { streamError: neo4jError('Neo.ClientError.Transaction.TransactionTimedOut') }, answer: 'timeout' },
  { name: 'the guard', behaviour: { manual: true }, overrides: { deadlineAt: 1_000_000 + 500 }, answer: 'timeout' },
  { name: 'an unavailable source', behaviour: { beginError: neo4jError('ServiceUnavailable') }, answer: 'unavailable' },
  { name: 'an authentication failure', behaviour: { beginError: neo4jError('Neo.ClientError.Security.Unauthorized') }, answer: 'unavailable' },
  { name: 'another error', behaviour: { streamError: neo4jError('Neo.ClientError.Statement.SyntaxError') }, answer: 'AdapterError' },
];

describe('every path through the executor', () => {
  it.each(PATHS)('opens only read sessions and works only in a transaction: $name', async ({ behaviour, overrides, answer }) => {
    useClock();
    const { executor, fake } = rig(behaviour);
    const attempt = executor.execute(callFor(overrides)).then(
      (outcome) => outcome.status,
      (error: unknown) => (error instanceof AdapterError ? 'AdapterError' : 'unexpected error'),
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(await attempt).toBe(answer);
    const sessions = fake.drivers.flatMap((driver) => driver.sessions);
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.map((session) => session.config.defaultAccessMode)).toEqual(sessions.map(() => 'READ'));
    for (const session of sessions) expect(session.begins.length).toBeGreaterThan(0);
    expectNoForbiddenCalls(fake);
  });
});

describe('the recording driver', () => {
  it('records every forbidden call it is given, even when the caller swallows the error, and fails the check', () => {
    const fake = fakeDrivers({});
    const driver = fake.factory({ uri: 'bolt://x', username: 'u', password: 'p', maxConnectionPoolSize: 1, connectionAcquisitionTimeout: 1, connectionTimeout: 1 });
    const session = driver.session({ database: 'x', defaultAccessMode: 'READ', fetchSize: 1 });
    for (const [owner, name] of [[session, 'executeRead'], [session, 'executeWrite'], [session, 'readTransaction'], [session, 'writeTransaction'], [session, 'executeQuery'], [session, 'run'], [driver, 'executeQuery']] as const) {
      const call: unknown = Reflect.get(owner, name);
      expect(call).toBeTypeOf('function');
      if (typeof call === 'function') expect(() => call()).toThrow('must not be called');
    }
    expect(fake.forbidden).toEqual(['executeRead', 'executeWrite', 'readTransaction', 'writeTransaction', 'session.executeQuery', 'session.run', 'driver.executeQuery']);
    expect(() => expectNoForbiddenCalls(fake)).toThrow('forbidden driver calls');
  });
});

describe('the production files of the adapter', () => {
  it('never name a write access mode or a managed or one-shot query method', () => {
    const files = productionFiles(SOURCES);
    expect(files.length).toBeGreaterThan(3);
    expect(files.flatMap((file) => forbiddenIn(file) ?? [])).toEqual([]);
  });

  it.each(['WRITE', 'executeRead', 'executeWrite', 'readTransaction', 'writeTransaction', 'executeQuery'])('are found out when they name %s', (name) => {
    const planted = join(scratch, `planted-${name}.ts`);
    writeFileSync(planted, `export const x = driver.${name};\n`);
    expect(forbiddenIn(planted)).toBe(name);
  });

  it('may name beginTransaction and the transaction run', () => {
    const allowed = join(scratch, 'allowed.ts');
    writeFileSync(allowed, 'export const x = session.beginTransaction(config).then((tx) => tx.run(q, p));\n');
    expect(forbiddenIn(allowed)).toBeUndefined();
  });
});

describe('a call that is not a read', () => {
  it('is refused before anything is opened', async () => {
    useClock();
    const { executor, fake } = rig({ rows: [] });
    await expect(executor.execute(Object.assign(callFor(), { accessMode: 'WRITE' }))).rejects.toThrow(AdapterError);
    expect(fake.drivers).toHaveLength(0);
  });
});

describe('the declared operations', () => {
  it('say what is supported, what is served by templates and what is not supported', () => {
    const { executor } = rig();
    expect(executor.operations).toEqual({
      execute: 'supported',
      searchEntities: 'by-template',
      getEntity: 'by-template',
      getRelationship: 'by-template',
      previewExpansion: 'by-template',
      expandNeighbors: 'by-template',
      findBoundedPaths: 'by-template',
      runTemplate: 'by-template',
      capabilities: 'by-template',
      cancel: 'unsupported',
    });
  });

  it('answer unsupported for a cancel, and open nothing', async () => {
    useClock();
    const { executor, fake } = rig({ rows: [] });
    expect(await executor.cancel('operation-1')).toEqual({ status: 'unsupported' });
    expect(fake.drivers).toHaveLength(0);
  });
});

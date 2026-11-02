import { describe, expect, it } from 'vitest';
import { SYSTEM_ID } from '../gate/system-principal.js';
import { memoryAppStore, memoryStoreWith } from '../testing/app-store.js';
import { auditing, mappingOf, sourceWith } from '../testing/gate-fixtures.js';
import { TestExecutor } from '../testing/gate.js';
import { testSourceGate } from '../testing/source-gate.js';
import { SERVER_ROW } from '../testing/source-tester.js';
import { createStartupChecker, startupProblem } from './startup.js';

const mapping = mappingOf(sourceWith('alpha'), sourceWith('beta'));
const clock = () => Date.UTC(2026, 10, 2, 10, 0, 0);

interface Line {
  readonly level: 'info' | 'warn';
  readonly fields: object;
  readonly message: string;
}

function logger() {
  const lines: Line[] = [];
  return { lines, info: (fields: object, message: string) => void lines.push({ level: 'info', fields, message }), warn: (fields: object, message: string) => void lines.push({ level: 'warn', fields, message }) };
}

function checker(executor: TestExecutor, store = memoryAppStore(), mappingModel = mapping) {
  const recording = auditing();
  const parts = testSourceGate(mappingModel, { executor, seams: recording.seams });
  const log = logger();
  return { checker: createStartupChecker({ system: parts.system, mapping: mappingModel, store, logger: log, clock }), store, log, recording };
}

const answering = () => new TestExecutor(() => Promise.resolve({ status: 'rows', rows: [SERVER_ROW] }));

describe('the startup check', () => {
  it('starts every source before any has answered, as the system principal, and stores each result with no user', async () => {
    const started: string[] = [];
    const waiting: (() => void)[] = [];
    const executor = new TestExecutor(
      (call) =>
        new Promise((resolve) => {
          started.push(call.sourceId);
          waiting.push(() => resolve({ status: 'rows', rows: [SERVER_ROW] }));
          if (waiting.length === 2) for (const release of waiting) release();
        }),
    );
    const { checker: startup, store, recording } = checker(executor);
    const results = await startup.run();
    expect(started.sort()).toEqual(['alpha', 'beta']);
    expect(results).toEqual([{ sourceId: 'alpha', outcome: 'pass' }, { sourceId: 'beta', outcome: 'pass' }]);
    expect(store.checks.map((check) => check.triggeredBy)).toEqual([null, null]);
    expect(recording.events.map((event) => [event.actorId, event.actorRole, event.action])).toEqual([
      [SYSTEM_ID, null, 'source.capabilities'],
      [SYSTEM_ID, null, 'source.capabilities'],
    ]);
  });

  it('records a down source and an answering one, and writes exactly one line per source with only the id and the outcome', async () => {
    const executor = new TestExecutor((call) => Promise.resolve(call.sourceId === 'alpha' ? { status: 'unavailable', reason: 'unreachable' } : { status: 'rows', rows: [SERVER_ROW] }));
    const { checker: startup, store, log } = checker(executor);
    const results = await startup.run();
    expect(results).toEqual([{ sourceId: 'alpha', outcome: 'fail' }, { sourceId: 'beta', outcome: 'pass' }]);
    expect(store.checks.map((check) => [check.report.sourceId, check.report.state])).toEqual([['alpha', 'unavailable'], ['beta', 'connected']]);
    expect(log.lines).toEqual([
      { level: 'warn', fields: { event: 'source.startup_check', sourceId: 'alpha', outcome: 'fail' }, message: 'source startup check' },
      { level: 'info', fields: { event: 'source.startup_check', sourceId: 'beta', outcome: 'pass' }, message: 'source startup check' },
    ]);
  });

  it('stores a warn for a server that reports an empty version, and the start goes on', async () => {
    const executor = new TestExecutor(() => Promise.resolve({ status: 'rows', rows: [{ ...SERVER_ROW, version: '' }] }));
    const { checker: startup, store } = checker(executor);
    expect((await startup.run()).map((result) => result.outcome)).toEqual(['warn', 'warn']);
    expect(store.checks.map((check) => check.report.state)).toEqual(['degraded', 'degraded']);
  });

  it('reports error, stores nothing and warns for a failure that says nothing about the source', async () => {
    const executor = new TestExecutor(() => Promise.resolve({ status: 'unavailable', reason: 'pool-full' }));
    const { checker: startup, store, log } = checker(executor);
    expect((await startup.run()).map((result) => result.outcome)).toEqual(['error', 'error']);
    expect(store.checks).toEqual([]);
    expect(log.lines.map((line) => [line.level, line.fields])).toEqual([
      ['warn', { event: 'source.startup_check', sourceId: 'alpha', outcome: 'error' }],
      ['warn', { event: 'source.startup_check', sourceId: 'beta', outcome: 'error' }],
    ]);
  });

  it('runs nothing for a mapping with no source', async () => {
    const executor = answering();
    const { checker: startup, log } = checker(executor, memoryAppStore(), { sources: [] });
    expect(await startup.run()).toEqual([]);
    expect(executor.calls).toEqual([]);
    expect(log.lines).toEqual([]);
  });

  it('rejects when the database refuses the write, so the start fails', async () => {
    const { checker: startup } = checker(answering(), memoryStoreWith({ failRecording: true }));
    await expect(startup.run()).rejects.toThrow('the check could not be written');
  });

  it('leaves the state unknown for a source whose row is missing', async () => {
    const { checker: startup, store } = checker(answering(), memoryStoreWith({ inactiveSources: ['alpha'] }));
    expect(await startup.run()).toEqual([{ sourceId: 'alpha', outcome: 'error' }, { sourceId: 'beta', outcome: 'pass' }]);
    expect(store.checks.map((check) => check.report.sourceId)).toEqual(['beta']);
  });
});

describe('startupProblem', () => {
  it('names no problem for any result today', () => {
    expect(startupProblem([{ sourceId: 'alpha', outcome: 'fail' }, { sourceId: 'beta', outcome: 'error' }])).toBeUndefined();
  });
});

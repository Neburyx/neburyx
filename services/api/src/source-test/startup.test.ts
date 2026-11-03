import { describe, expect, it } from 'vitest';
import { SYSTEM_ID } from '../gate/system-principal.js';
import { memoryAppStore, memoryStoreWith } from '../testing/app-store.js';
import { auditing, mappingOf, sourceWith } from '../testing/gate-fixtures.js';
import { TestExecutor } from '../testing/gate.js';
import { testSourceGate } from '../testing/source-gate.js';
import { fittingSchemaAnswer, SERVER_ROW, serverExecutor } from '../testing/source-tester.js';
import { createStartupChecker, startupProblem, type StartupResult } from './startup.js';

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

const answering = () => serverExecutor();

describe('the startup check', () => {
  it('starts every source before any has answered, as the system principal, and stores each result with no user', async () => {
    const started: string[] = [];
    const waiting: (() => void)[] = [];
    const executor = serverExecutor(
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
    expect(results).toEqual([{ sourceId: 'alpha', outcome: 'pass', answered: true, findings: [] }, { sourceId: 'beta', outcome: 'pass', answered: true, findings: [] }]);
    expect(store.checks.map((check) => check.triggeredBy)).toEqual([null, null]);
    expect(recording.events.map((event) => [event.actorId, event.actorRole, event.action])).toEqual([
      [SYSTEM_ID, null, 'source.capabilities'],
      [SYSTEM_ID, null, 'source.capabilities'],
      [SYSTEM_ID, null, 'source.privileges'],
      [SYSTEM_ID, null, 'source.privileges'],
      [SYSTEM_ID, null, 'source.schema_tokens'],
      [SYSTEM_ID, null, 'source.schema_tokens'],
      [SYSTEM_ID, null, 'source.schema_indexes'],
      [SYSTEM_ID, null, 'source.schema_indexes'],
      [SYSTEM_ID, null, 'source.degree_probe'],
      [SYSTEM_ID, null, 'source.degree_probe'],
      [SYSTEM_ID, null, 'source.degree_probe'],
      [SYSTEM_ID, null, 'source.degree_probe'],
      [SYSTEM_ID, null, 'source.degree_probe'],
      [SYSTEM_ID, null, 'source.degree_probe'],
    ]);
  });

  it('records a down source and an answering one, and writes exactly one line per source with only the id and the outcome', async () => {
    const executor = serverExecutor((call) => (call.sourceId === 'alpha' ? { status: 'unavailable', reason: 'unreachable' } : { status: 'rows', rows: [SERVER_ROW] }));
    const { checker: startup, store, log } = checker(executor);
    const results = await startup.run();
    expect(results).toEqual([{ sourceId: 'alpha', outcome: 'fail', answered: false, findings: [] }, { sourceId: 'beta', outcome: 'pass', answered: true, findings: [] }]);
    expect(store.checks.map((check) => [check.report.sourceId, check.report.state])).toEqual([['alpha', 'unavailable'], ['beta', 'connected']]);
    expect(log.lines).toEqual([
      { level: 'warn', fields: { event: 'source.startup_check', sourceId: 'alpha', outcome: 'fail' }, message: 'source startup check' },
      { level: 'info', fields: { event: 'source.startup_check', sourceId: 'beta', outcome: 'pass' }, message: 'source startup check' },
    ]);
  });

  it('stores a warn for a server that reports an empty version, and the start goes on', async () => {
    const executor = serverExecutor({ status: 'rows', rows: [{ ...SERVER_ROW, version: '' }] });
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
    expect(await startup.run()).toEqual([{ sourceId: 'alpha', outcome: 'error', answered: false, findings: [] }, { sourceId: 'beta', outcome: 'pass', answered: true, findings: [] }]);
    expect(store.checks.map((check) => check.report.sourceId)).toEqual(['beta']);
  });
});

describe('startupProblem', () => {
  const failing = (check: 'label' | 'search-index', message: string): StartupResult['findings'][number] => ({ severity: 'fail', check, entityType: 'gadget', message });
  const result = (sourceId: string, findings: StartupResult['findings'], outcome: StartupResult['outcome'] = 'fail', answered = true): StartupResult => ({ sourceId, outcome, answered, findings });

  it('names no problem for sources that did not answer, that only warn, that could not be verified or that pass', () => {
    expect(
      startupProblem([
        result('a', [], 'fail', false),
        result('b', [{ severity: 'warn', check: 'sort-index', message: 'a warning' }], 'warn'),
        result('c', [{ severity: 'warn', check: 'schema-refused', message: 'not verified' }], 'warn'),
        result('d', [], 'pass'),
        result('e', [], 'error', true),
      ]),
    ).toBeUndefined();
  });

  it('names one line for each failing finding, with the source, and ends with what to do', () => {
    expect(startupProblem([result('alpha', [failing('label', 'Entity type "claim" (label "Claim"): no node carries the label'), failing('search-index', 'x: no index')]), result('beta', [], 'pass')])).toBe(
      ['source alpha: Entity type "claim" (label "Claim"): no node carries the label', 'source alpha: x: no index', 'Fix the source, then run test-source or test it from the Sources page.'].join('\n'),
    );
  });

  it('names only the failing source when two sources are checked', () => {
    const problem = startupProblem([result('alpha', [failing('label', 'one')]), result('beta', [{ severity: 'warn', check: 'sort-index', message: 'a warning' }], 'warn')]);
    expect(problem).toContain('source alpha: one');
    expect(problem).not.toContain('beta');
  });

  it('lists at most twenty lines and counts the rest', () => {
    const many = Array.from({ length: 23 }, (_, index) => failing('label', `problem ${index + 1}`));
    const lines = (startupProblem([result('alpha', many)]) ?? '').split('\n');
    expect(lines).toHaveLength(22);
    expect(lines[0]).toBe('source alpha: problem 1');
    expect(lines[19]).toBe('source alpha: problem 20');
    expect(lines[20]).toBe('and 3 more');
  });
});

describe('the startup check of a source whose check does not settle', () => {
  it('marks the source as not checked since the start, stores no check, and still counts the source as having answered when its capabilities read did', async () => {
    const executor = serverExecutor(undefined, undefined, { status: 'unavailable', reason: 'pool-full' });
    const store = memoryAppStore();
    await store.syncSources(mapping.sources);
    const { checker: startup } = checker(executor, store);
    const results = await startup.run();
    expect(results).toEqual([
      { sourceId: 'alpha', outcome: 'error', answered: true, findings: [] },
      { sourceId: 'beta', outcome: 'error', answered: true, findings: [] },
    ]);
    expect(store.checks).toEqual([]);
    expect((await store.listSources()).map((row) => [row.id, row.state, row.stateReason])).toEqual([
      ['alpha', 'unknown', 'The source has not been checked since the start.'],
      ['beta', 'unknown', 'The source has not been checked since the start.'],
    ]);
  });

  it('writes one warning line with the event and the source id when the login may not list indexes', async () => {
    const executor = serverExecutor(undefined, undefined, (call) => (call.templateId === 'schema-indexes' ? { status: 'unavailable', reason: 'refused' } : fittingSchemaAnswer(call)));
    const { checker: startup, log } = checker(executor);
    await startup.run();
    expect(log.lines.filter((line) => Reflect.get(line.fields, 'event') === 'source.mapping_not_verified')).toEqual([
      { level: 'warn', fields: { event: 'source.mapping_not_verified', sourceId: 'alpha' }, message: 'source mapping checks were not verified' },
      { level: 'warn', fields: { event: 'source.mapping_not_verified', sourceId: 'beta' }, message: 'source mapping checks were not verified' },
    ]);
  });
});

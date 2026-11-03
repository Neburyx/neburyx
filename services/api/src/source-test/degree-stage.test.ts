import { describe, expect, it } from 'vitest';
import { sourceTestReportSchema } from '@neburyx/contracts';
import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';
import { memoryAppStore } from '../testing/app-store.js';
import { CHEAP_PLAN } from '../testing/fitting-schema.js';
import { communitySeams } from '../seams/community-seams.js';
import { auditing, mappingOf, sourceWith } from '../testing/gate-fixtures.js';
import { LOCAL_PRINCIPAL } from '../testing/gate.js';
import { firstSource } from '../testing/mapping.js';
import { testSourceGate } from '../testing/source-gate.js';
import { fittingSchemaAnswer, SERVER_ROW, serverExecutor } from '../testing/source-tester.js';
import { DEGREE_START_WINDOW_MS, degreePairs } from './degree-stage.js';
import { createSourceTester } from './tester.js';

const mapping = mappingOf(
  sourceWith('alpha', {
    entities: [
      { type: 'gadget', label: 'Gadget', stable_id: 'gadgetId' },
      { type: 'person', label: 'Person', stable_id: 'personId' },
      { type: 'thing', label: 'Thing', stable_id: 'thingId' },
    ],
    relationships: [
      { type: 'MADE_BY', from: 'gadget', to: 'person' },
      { type: 'SEEN_BY', from: 'gadget', to: 'person' },
      { type: 'KNOWS', from: 'person', to: 'person' },
    ],
  }),
);
const request = { traceId: 'tr-test', principal: LOCAL_PRINCIPAL, sourceId: 'alpha' };
const NOW = Date.UTC(2026, 10, 2, 10, 0, 0);

function rig(options: { readonly degree?: (call: ExecuteCall) => ExecuteOutcome; readonly capabilities?: ExecuteOutcome; readonly schema?: (call: ExecuteCall) => ExecuteOutcome; readonly clock?: () => number; readonly probe?: () => Promise<'can-write' | 'cannot-write' | 'inconclusive'>; readonly busyAfter?: number } = {}) {
  const logs: { fields: Record<string, unknown>; message: string }[] = [];
  const executor = serverExecutor(options.capabilities, { status: 'unavailable', reason: 'refused' }, (call) => (call.templateId === 'degree-probe' && options.degree !== undefined ? options.degree(call) : (options.schema ?? fittingSchemaAnswer)(call)));
  const recording = auditing();
  const defaults = communitySeams();
  let admitted = 0;
  const coordinator = options.busyAfter === undefined ? defaults.coordinator : { acquireRead: (read: Parameters<typeof defaults.coordinator.acquireRead>[0]) => (++admitted > (options.busyAfter ?? 0) ? Promise.resolve({ status: 'busy' as const }) : defaults.coordinator.acquireRead(read)) };
  const parts = testSourceGate(mapping, { executor, seams: { policy: recording.seams.policy, audit: recording.seams.audit, coordinator } });
  const store = memoryAppStore();
  const logger = { warn: (fields: object, message: string) => void logs.push({ fields: { ...fields }, message }) };
  const tester = createSourceTester({ gate: parts.gate, mapping, store, logger, clock: options.clock ?? (() => NOW), ...(options.probe === undefined ? {} : { probe: options.probe }) });
  const probes = () => executor.calls.filter((call) => call.templateId === 'degree-probe');
  return { tester, store, logs, probes, executor, events: recording.events };
}

describe('the pairs a source is probed for', () => {
  it('are each end of each relationship row once, in the order of the mapping', () => {
    expect(degreePairs(firstSource(mapping))).toEqual([
      { entityType: 'gadget', relationshipType: 'MADE_BY' },
      { entityType: 'person', relationshipType: 'MADE_BY' },
      { entityType: 'gadget', relationshipType: 'SEEN_BY' },
      { entityType: 'person', relationshipType: 'SEEN_BY' },
      { entityType: 'person', relationshipType: 'KNOWS' },
    ]);
  });
});

describe('the degree probes of a source whose server answers every count from the degree', () => {
  it('make one read for each pair, after the mapping reads, and report pass with a type for each entity type that has a relationship', async () => {
    const { tester, probes, executor } = rig();
    const report = sourceTestReportSchema.parse(await tester.run(request));
    expect(executor.calls.map((call) => call.templateId)).toEqual(['capabilities', 'privileges', 'schema-tokens', 'schema-indexes', ...Array.from({ length: 5 }, () => 'degree-probe')]);
    expect(probes().map((call) => call.cypher.match(/\(n:`(\w+)`\)/)?.[1] + '/' + call.cypher.match(/-\[:`(\w+)`\]->/)?.[1])).toEqual(['Gadget/MADE_BY', 'Person/MADE_BY', 'Gadget/SEEN_BY', 'Person/SEEN_BY', 'Person/KNOWS']);
    expect(report.degreeChecks).toEqual({
      status: 'pass',
      foundOn: 'Neo4j 5.26.32',
      types: [
        { entityType: 'gadget', result: 'cheap', basis: 'degree-operator', relationshipTypes: ['MADE_BY', 'SEEN_BY'] },
        { entityType: 'person', result: 'cheap', basis: 'degree-operator', relationshipTypes: ['MADE_BY', 'SEEN_BY', 'KNOWS'] },
      ],
      warnings: [],
    });
    expect(report).toMatchObject({ outcome: 'pass', state: 'connected', stateReason: null });
  });

  it('are stored with the report', async () => {
    const { tester, store } = rig();
    const report = await tester.run(request);
    expect(store.checks.map((check) => check.report)).toEqual([report]);
  });

  it('list no entity type that has no relationship, and make no read for it', async () => {
    const { tester, probes } = rig();
    const report = await tester.run(request);
    expect(report.degreeChecks.types.map((entry) => entry.entityType)).not.toContain('thing');
    expect(probes().every((call) => !call.cypher.includes('`Thing`'))).toBe(true);
  });
});

describe('a source that is not probed', () => {
  const NOT_RUN = { status: 'not-run', foundOn: null, types: [], warnings: [] };

  it.each([
    ['did not answer', { capabilities: { status: 'unavailable', reason: 'unreachable' } as ExecuteOutcome }],
    ['runs a version outside the support matrix', { capabilities: { status: 'rows', rows: [{ ...SERVER_ROW, version: '4.4.0' }] } as ExecuteOutcome }],
    ['has a mapping that does not fit it', { schema: (call: ExecuteCall): ExecuteOutcome => (call.templateId === 'schema-tokens' ? { status: 'rows', rows: [{ labels: [], types: [] }] } : fittingSchemaAnswer(call)) }],
  ])('is not run for a source that %s, and no probe is made', async (_name, options) => {
    const { tester, probes } = rig(options);
    expect((await tester.run(request)).degreeChecks).toEqual(NOT_RUN);
    expect(probes()).toEqual([]);
  });

  it('is not run for a source whose mapping holds no relationship', async () => {
    const lonely = mappingOf(sourceWith('alpha', { relationships: [], entities: [{ type: 'person', label: 'Person', stable_id: 'id' }] }));
    const executor = serverExecutor();
    const parts = testSourceGate(lonely, { executor });
    const report = await createSourceTester({ gate: parts.gate, mapping: lonely, store: memoryAppStore() }).run(request);
    expect(report.degreeChecks).toEqual(NOT_RUN);
    expect(executor.calls.filter((call) => call.templateId === 'degree-probe')).toEqual([]);
  });
});

describe('a probe the source does not answer', () => {
  it.each([
    ['the connection is lost', { status: 'unavailable', reason: 'unreachable' } as ExecuteOutcome, 'SOURCE_UNAVAILABLE'],
    ['the pool is full', { status: 'unavailable', reason: 'pool-full' } as ExecuteOutcome, 'SOURCE_UNAVAILABLE'],
    ['the executor is closed', { status: 'unavailable', reason: 'closed' } as ExecuteOutcome, 'SOURCE_UNAVAILABLE'],
  ])('is rethrown when %s, and nothing is stored', async (_name, answer, code) => {
    const { tester, store } = rig({ degree: () => answer });
    await expect(tester.run(request)).rejects.toMatchObject({ code });
    expect(store.checks).toEqual([]);
  });

  it('is rethrown as SOURCE_BUSY, with nothing stored, when the coordinator finds the source busy at the first probe', async () => {
    const { tester, store, probes } = rig({ busyAfter: 4 });
    await expect(tester.run(request)).rejects.toMatchObject({ code: 'SOURCE_BUSY' });
    expect(store.checks).toEqual([]);
    expect(probes()).toEqual([]);
  });

  it('is rethrown as an internal error, with nothing stored, when the executor fails', async () => {
    const executor = serverExecutor();
    const failing = { ...executor, execute: (call: ExecuteCall) => (call.templateId === 'degree-probe' ? Promise.reject(new Error('adapter failed')) : executor.execute(call)) };
    const parts = testSourceGate(mapping, { executor: failing as typeof executor });
    const store = memoryAppStore();
    await expect(createSourceTester({ gate: parts.gate, mapping, store }).run(request)).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(store.checks).toEqual([]);
  });
});

describe('the time of the check', () => {
  it('is taken after the degree probes and before the write probe', async () => {
    let now = NOW;
    let writeProbeAt = 0;
    const { tester, store } = rig({
      clock: () => now,
      degree: () => {
        now += 1000;
        return { status: 'rows', rows: [{ outgoing: 0, incoming: 0 }], plan: CHEAP_PLAN };
      },
      probe: () => {
        writeProbeAt = now;
        now += 500;
        return Promise.resolve('inconclusive');
      },
    });
    const report = await tester.run(request);
    expect(Date.parse(report.checkedAt)).toBe(NOW + 5000);
    expect(writeProbeAt).toBe(NOW + 5000);
    expect(store.checks).toHaveLength(1);
  });
});

describe('what a report and a log never hold', () => {
  it('is no count, db hit, plan text, operator name or unmapped name, whatever the plan said: not in the report, the log, an audit event or an error', async () => {
    const { tester, logs, events } = rig({ degree: () => ({ status: 'rows', rows: [{ outgoing: 123456, incoming: 654321 }], plan: [{ name: 'SecretOperator', details: 'getDegree((n)-[:T]->()) secret-detail', dbHits: 987654 }] }) });
    const text = JSON.stringify([await tester.run(request), logs, events]);
    for (const leaked of ['123456', '654321', '987654', 'SecretOperator', 'secret-detail', 'getDegree', 'outgoing', 'incoming', 'dbHits']) expect(text).not.toContain(leaked);
  });
});

describe('an error of a probe', () => {
  it('holds no count, db hit, plan text or operator name, and the audit events of the run hold none either', async () => {
    const failing = serverExecutor();
    const raising = { ...failing, calls: failing.calls, execute: (call: ExecuteCall) => (call.templateId === 'degree-probe' ? Promise.reject(new Error('failed after 123456 db hits in SecretOperator')) : failing.execute(call)) };
    const recording = auditing();
    const parts = testSourceGate(mapping, { executor: raising as typeof failing, seams: recording.seams });
    const error: unknown = await createSourceTester({ gate: parts.gate, mapping, store: memoryAppStore() }).run(request).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'INTERNAL_ERROR' });
    const text = JSON.stringify([error, String(error), (error as Error).message, recording.events]);
    for (const leaked of ['123456', 'SecretOperator', 'db hits']) expect(text).not.toContain(leaked);
    expect(recording.events.some((event) => event.action === 'source.degree_probe' && event.result === 'failed')).toBe(true);
  });
});

describe('a test double that is given another plan', () => {
  it('shows it in the report', async () => {
    const { tester } = rig({ degree: () => ({ status: 'rows', rows: [], plan: [{ name: 'Projection', details: 'something else', dbHits: 1 }] }) });
    const report = await tester.run(request);
    expect(report.degreeChecks).toMatchObject({ status: 'warn', types: [{ result: 'could-not-tell', basis: 'unrecognized-plan' }, { result: 'could-not-tell', basis: 'unrecognized-plan' }] });
    expect(report.degreeChecks.warnings).toHaveLength(2);
    expect(report).toMatchObject({ outcome: 'pass', state: 'connected' });
  });
});

const EXPAND_PLAN = [{ name: 'Apply', details: null, dbHits: 0 }, { name: 'Expand(All)', details: '(n)-[:T]->()', dbHits: 123456 }];
const rows = (plan: unknown): ExecuteOutcome => ({ status: 'rows', rows: [{ outgoing: 1, incoming: 1 }], plan: plan as never });
const byPair = (answers: Record<string, ExecuteOutcome>) => (call: ExecuteCall): ExecuteOutcome => {
  const key = `${call.cypher.match(/\(n:`(\w+)`\)/)?.[1]}/${call.cypher.match(/-\[:`(\w+)`\]->/)?.[1]}`;
  return answers[key] ?? rows(CHEAP_PLAN);
};

describe('a type whose count the server answers by expanding', () => {
  it('is not cheap, with one warning, and the report keeps its outcome and its state', async () => {
    const { tester } = rig({ degree: byPair({ 'Person/KNOWS': rows(EXPAND_PLAN), 'Person/MADE_BY': rows(EXPAND_PLAN), 'Person/SEEN_BY': rows(EXPAND_PLAN) }) });
    const report = sourceTestReportSchema.parse(await tester.run(request));
    expect(report.degreeChecks).toEqual({
      status: 'warn',
      foundOn: 'Neo4j 5.26.32',
      types: [
        { entityType: 'gadget', result: 'cheap', basis: 'degree-operator', relationshipTypes: ['MADE_BY', 'SEEN_BY'] },
        { entityType: 'person', result: 'not-cheap', basis: 'expand', relationshipTypes: ['MADE_BY', 'SEEN_BY', 'KNOWS'] },
      ],
      warnings: ['Degree counts are estimated for person: no cheap per-type degree index'],
    });
    expect(report).toMatchObject({ outcome: 'pass', state: 'connected', stateReason: null });
  });
});

describe('the result of an entity type with several pairs', () => {
  it('is the worst pair, however the pairs are ordered', async () => {
    const unclear = rows([{ name: 'Projection', details: 'other', dbHits: 1 }]);
    const { tester } = rig({ degree: byPair({ 'Gadget/MADE_BY': unclear, 'Gadget/SEEN_BY': rows(EXPAND_PLAN) }) });
    expect((await tester.run(request)).degreeChecks.types[0]).toMatchObject({ entityType: 'gadget', result: 'not-cheap', basis: 'expand' });
    const other = rig({ degree: byPair({ 'Gadget/MADE_BY': rows(EXPAND_PLAN), 'Gadget/SEEN_BY': unclear }) });
    expect((await other.tester.run(request)).degreeChecks.types[0]).toMatchObject({ result: 'not-cheap', basis: 'expand' });
    const clear = rig({ degree: byPair({ 'Gadget/SEEN_BY': unclear }) });
    expect((await clear.tester.run(request)).degreeChecks.types[0]).toMatchObject({ result: 'could-not-tell', basis: 'unrecognized-plan' });
  });

  it('takes the basis from the first pair in probe order when several share the worst result', async () => {
    const { tester } = rig({ degree: byPair({ 'Gadget/MADE_BY': { status: 'timeout' }, 'Gadget/SEEN_BY': rows(null) }) });
    const report = await tester.run(request);
    expect(report.degreeChecks.types[0]).toMatchObject({ entityType: 'gadget', result: 'could-not-tell', basis: 'timeout', relationshipTypes: ['MADE_BY', 'SEEN_BY'] });
    expect(report.degreeChecks.warnings.filter((warning) => warning.includes('gadget'))).toEqual(['Degree counts could not be checked for gadget: the server did not answer in time']);
  });
});

describe('the warnings of the types that are not cheap', () => {
  it.each([
    ['a plan that is not recognised', rows([{ name: 'Projection', details: 'other', dbHits: 1 }]), "the server's plan was not one this check recognizes"],
    ['no plan', rows(null), "the server's plan was not one this check recognizes"],
    ['an answer that cannot be read', { status: 'rows', rows: [{ outgoing: 1, incoming: 1 }, { outgoing: 2, incoming: 2 }], plan: CHEAP_PLAN } as ExecuteOutcome, "the server's answer could not be read"],
    ['a timeout', { status: 'timeout' } as ExecuteOutcome, 'the server did not answer in time'],
    ['a refusal', { status: 'unavailable', reason: 'refused' } as ExecuteOutcome, 'the login may not profile'],
  ])('are one sentence for %s', async (_name, answer, why) => {
    const { tester } = rig({ degree: byPair({ 'Person/KNOWS': answer, 'Person/MADE_BY': answer, 'Person/SEEN_BY': answer, 'Gadget/MADE_BY': answer, 'Gadget/SEEN_BY': answer }) });
    const report = await tester.run(request);
    expect(report.degreeChecks.warnings).toEqual([`Degree counts could not be checked for gadget: ${why}`, `Degree counts could not be checked for person: ${why}`]);
    expect(report.degreeChecks.status).toBe('warn');
  });
});

describe('a probe that fails', () => {
  it('times out as its type could-not-tell and the stage goes on', async () => {
    const { tester, probes } = rig({ degree: byPair({ 'Gadget/MADE_BY': { status: 'timeout' } }) });
    const report = await tester.run(request);
    expect(probes()).toHaveLength(5);
    expect(report.degreeChecks.types).toMatchObject([{ entityType: 'gadget', result: 'could-not-tell', basis: 'timeout' }, { entityType: 'person', result: 'cheap' }]);
  });

  it('is refused for the pair and every pair not yet probed, which make no read', async () => {
    const { tester, probes } = rig({ degree: byPair({ 'Person/MADE_BY': { status: 'unavailable', reason: 'refused' } }) });
    const report = await tester.run(request);
    expect(probes()).toHaveLength(2);
    expect(report.degreeChecks.types).toMatchObject([{ entityType: 'gadget', result: 'could-not-tell', basis: 'refused' }, { entityType: 'person', result: 'could-not-tell', basis: 'refused' }]);
  });

  it('is not started for the pairs left when one gate deadline has passed since the stage began', async () => {
    let now = NOW;
    const { tester, probes } = rig({
      clock: () => now,
      degree: () => {
        now += DEGREE_START_WINDOW_MS;
        return rows(CHEAP_PLAN);
      },
    });
    const report = await tester.run(request);
    expect(probes()).toHaveLength(1);
    expect(report.degreeChecks.types).toMatchObject([{ entityType: 'gadget', result: 'could-not-tell', basis: 'skipped' }, { entityType: 'person', result: 'could-not-tell', basis: 'skipped' }]);
  });

  it('keeps what a pair found before the window closed', async () => {
    let now = NOW;
    let asked = 0;
    const { tester } = rig({
      clock: () => now,
      degree: () => {
        asked += 1;
        now += asked === 4 ? DEGREE_START_WINDOW_MS : 1;
        return rows(CHEAP_PLAN);
      },
    });
    const report = await tester.run(request);
    expect(report.degreeChecks.types).toMatchObject([{ entityType: 'gadget', result: 'cheap' }, { entityType: 'person', result: 'could-not-tell', basis: 'skipped', relationshipTypes: ['MADE_BY', 'SEEN_BY', 'KNOWS'] }]);
  });

  it('answers an answer the template cannot read as unreadable, writes a log line with no value, and goes on', async () => {
    const { tester, logs } = rig({ degree: byPair({ 'Gadget/MADE_BY': { status: 'rows', rows: [{ outgoing: 'secret-value', incoming: 2 }, { outgoing: 'other-value', incoming: 3 }], plan: CHEAP_PLAN } }) });
    const report = await tester.run(request);
    expect(report.degreeChecks.types[0]).toMatchObject({ entityType: 'gadget', result: 'could-not-tell', basis: 'unreadable' });
    expect(logs).toEqual([{ fields: { event: 'source.degree_unreadable', sourceId: 'alpha', columnTypes: [] }, message: 'source degree probe answer could not be read' }]);
    expect(JSON.stringify(logs)).not.toContain('secret-value');
  });
});

describe('a probe that the server expands', () => {
  it('has its db hits in no report, log line or error (the transaction timeout and the gate deadline are in degree-bound.test.ts)', async () => {
    const { tester, logs } = rig({ degree: () => rows(EXPAND_PLAN) });
    const text = JSON.stringify([await tester.run(request), logs]);
    expect(text).not.toContain('123456');
    expect(text).not.toContain('Expand');
  });
});

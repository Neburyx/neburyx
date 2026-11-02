import { describe, expect, it } from 'vitest';
import { sourceTestReportSchema } from '@neburyx/contracts';
import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';
import type { IndexEntry } from '../gate/templates/schema-indexes.js';
import { memoryAppStore } from '../testing/app-store.js';
import { fittingIndexes, fittingTokens } from '../testing/fitting-schema.js';
import { mappingOf, sourceWith } from '../testing/gate-fixtures.js';
import { LOCAL_PRINCIPAL } from '../testing/gate.js';
import { SERVER_ROW, serverExecutor } from '../testing/source-tester.js';
import { testSourceGate } from '../testing/source-gate.js';
import { STAGE_START_WINDOW_MS } from './mapping-stage.js';
import { createSourceTester } from './tester.js';

const mapping = mappingOf(
  sourceWith('alpha', {
    entities: [
      { type: 'gadget', label: 'Gadget', stable_id: 'gadgetId', search: ['gadgetId', 'title'], reference: ['extRef'] },
      { type: 'person', label: 'Person', stable_id: 'personId' },
    ],
    relationships: [{ type: 'MADE_BY', from: 'gadget', to: 'person', stable_id: 'linkId', observed_at: 'madeAt', evidence: ['recordId'] }],
  }),
);
const request = { traceId: 'tr-test', principal: LOCAL_PRINCIPAL, sourceId: 'alpha' };

const node = (name: string, property: string, overrides: Partial<IndexEntry> = {}): IndexEntry => ({ type: 'RANGE', entityType: 'NODE', name, property, single: true, state: 'ONLINE', constrained: false, ...overrides });
const edge = (name: string, property: string): IndexEntry => ({ ...node(name, property), entityType: 'RELATIONSHIP' });
const FITTING: IndexEntry[] = [
  node('Gadget', 'gadgetId', { constrained: true }),
  node('Gadget', 'title'),
  node('Gadget', 'extRef'),
  node('Person', 'personId', { constrained: true }),
  edge('MADE_BY', 'linkId'),
  edge('MADE_BY', 'madeAt'),
  edge('MADE_BY', 'recordId'),
];

type Schema = { tokens?: ExecuteOutcome; indexes?: ExecuteOutcome; scan?: ExecuteOutcome | ((call: ExecuteCall) => ExecuteOutcome) };
const rows = (...items: Record<string, unknown>[]): ExecuteOutcome => ({ status: 'rows', rows: items });

function rig(schema: Schema = {}, options: { readonly capabilities?: ExecuteOutcome; readonly clock?: () => number; readonly onCall?: (call: ExecuteCall) => void } = {}) {
  const logs: { fields: Record<string, unknown>; message: string }[] = [];
  const executor = serverExecutor(options.capabilities, { status: 'unavailable', reason: 'refused' }, (call) => {
    options.onCall?.(call);
    if (call.templateId === 'schema-tokens') return schema.tokens ?? rows(fittingTokens(call.parameters));
    if (call.templateId === 'schema-indexes') return schema.indexes ?? rows({ indexes: FITTING, truncated: false });
    const scan = schema.scan ?? rows({ duplicated: 0 });
    return typeof scan === 'function' ? scan(call) : scan;
  });
  const parts = testSourceGate(mapping, { executor });
  const store = memoryAppStore();
  const logger = { warn: (fields: object, message: string) => void logs.push({ fields: { ...fields }, message }) };
  const tester = createSourceTester({ gate: parts.gate, mapping, store, logger, clock: options.clock ?? (() => Date.UTC(2026, 10, 2, 10, 0, 0)) });
  const calls = () => executor.calls.map((call) => call.templateId);
  return { tester, store, logs, calls, executor };
}

const missingIndexes = (drop: (entry: IndexEntry) => boolean): ExecuteOutcome => rows({ indexes: FITTING.filter((entry) => !drop(entry)), truncated: false });

describe('a mapping that fits the source', () => {
  it('passes, with no finding, and the report is as before', async () => {
    const { tester, calls } = rig();
    const report = sourceTestReportSchema.parse(await tester.run(request));
    expect(report).toMatchObject({ outcome: 'pass', state: 'connected', stateReason: null, mappingChecks: { status: 'pass', findings: [] } });
    expect(calls()).toEqual(['capabilities', 'privileges', 'schema-tokens', 'schema-indexes']);
  });
});

describe('a mapping that names what the source does not have', () => {
  const FIX = 'Fix the source, then run test-source or test it from the Sources page.';

  it('fails on a missing label, names it, and makes the source unavailable with the reason and what to do', async () => {
    const { tester, store } = rig({ tokens: rows({ labels: ['Person'], types: ['MADE_BY'] }) });
    const report = sourceTestReportSchema.parse(await tester.run(request));
    expect(report).toMatchObject({ outcome: 'fail', state: 'unavailable', versionSupported: true, server: { version: '5.26.32' } });
    expect(report.mappingChecks).toEqual({
      status: 'fail',
      findings: [{ severity: 'fail', check: 'label', entityType: 'gadget', message: 'Entity type "gadget" (label "Gadget"): no node carries the label' }],
    });
    expect(report.stateReason).toBe(`The mapping does not fit the source: Entity type "gadget" (label "Gadget"): no node carries the label. ${FIX}`);
    expect(store.checks).toHaveLength(1);
    expect(store.checks[0]?.report).toEqual(report);
  });

  it('fails on a missing relationship type with its from and to, and counts the other failures', async () => {
    const { tester } = rig({ tokens: rows({ labels: ['Person'], types: [] }) });
    const report = await tester.run(request);
    expect(report.mappingChecks.findings.map((entry) => [entry.check, entry.entityType ?? entry.relationshipType])).toEqual([
      ['label', 'gadget'],
      ['relationship-type', 'MADE_BY'],
    ]);
    expect(report.stateReason).toContain('(and 1 more). Fix the source');
  });

  it('fails the same way on an empty database and reads nothing more', async () => {
    const { tester, calls } = rig({ tokens: rows({ labels: [], types: [] }) });
    const report = await tester.run(request);
    expect(report).toMatchObject({ outcome: 'fail', mappingChecks: { status: 'fail' } });
    expect(report.mappingChecks.findings.map((entry) => entry.check)).toEqual(['label', 'label', 'relationship-type']);
    expect(calls()).toEqual(['capabilities', 'privileges', 'schema-tokens']);
  });
});

describe('the indexes', () => {
  it.each([
    ['search', 'title', 'search-index'],
    ['reference', 'extRef', 'reference-index'],
    ['evidence', 'recordId', 'evidence-index'],
  ])('fails on a missing %s index, and on no other check', async (_kind, property, check) => {
    const { tester } = rig({ indexes: missingIndexes((entry) => entry.property === property) });
    const report = await tester.run(request);
    expect(report).toMatchObject({ outcome: 'fail', state: 'unavailable' });
    expect(report.mappingChecks.findings.map((entry) => [entry.check, entry.property])).toEqual([[check, property]]);
  });

  it('only warns on a missing sort index: degraded, outcome warn', async () => {
    const { tester } = rig({ indexes: missingIndexes((entry) => entry.property === 'madeAt') });
    const report = await tester.run(request);
    expect(report).toMatchObject({ outcome: 'warn', state: 'degraded', mappingChecks: { status: 'warn' } });
    expect(report.stateReason).toMatch(/^The mapping has warnings: Relationship type "MADE_BY" from "gadget" to "person": no index on the sort property "madeAt"$/);
  });

  it('keeps the failure found by the labels when the indexes cannot be listed, and says what was not verified', async () => {
    const { tester } = rig({ tokens: rows({ labels: ['Person'], types: ['MADE_BY'] }), indexes: { status: 'unavailable', reason: 'refused' } });
    const report = await tester.run(request);
    expect(report.mappingChecks.status).toBe('fail');
    expect(report.mappingChecks.findings.map((entry) => entry.check)).toEqual(['label', 'schema-refused']);
  });

  it('is not verified, and degraded, when the login may not list indexes, with the message that names the privileges and says a search may scan', async () => {
    const { tester } = rig({ indexes: { status: 'unavailable', reason: 'refused' } });
    const report = await tester.run(request);
    expect(report).toMatchObject({ outcome: 'warn', state: 'degraded', mappingChecks: { status: 'not-verified' } });
    expect(report.mappingChecks.findings).toEqual([
      expect.objectContaining({
        check: 'schema-refused',
        message: 'The index checks were not verified because the login may not list indexes (grant SHOW INDEX and SHOW CONSTRAINT); a search on this source may scan.',
      }),
    ]);
  });

  it('is not verified when more indexes match than the read returns', async () => {
    const { tester } = rig({ indexes: rows({ indexes: FITTING, truncated: true }) });
    expect((await tester.run(request)).mappingChecks).toMatchObject({ status: 'not-verified', findings: [{ check: 'schema-unreadable' }] });
  });
});

describe('an answer the check cannot read', () => {
  it.each([
    ['the labels', { tokens: rows({ labels: 7, types: 'x' }) }, 'tokens'],
    ['the indexes', { indexes: rows({ unexpected: true }) }, 'indexes'],
    ['a second row', { tokens: rows({ labels: [], types: [] }, { labels: [], types: [] }) }, 'tokens'],
  ] as const)('about %s is not verified, degraded, and logs the type of each column and no value', async (_name, schema, read) => {
    const { tester, logs } = rig({ ...schema, tokens: 'tokens' in schema ? schema.tokens : undefined } as Schema);
    const report = await tester.run(request);
    expect(report).toMatchObject({ outcome: 'warn', state: 'degraded', mappingChecks: { status: 'not-verified', findings: [{ check: 'schema-unreadable' }] } });
    expect(logs.filter((line) => line.fields['event'] === 'source.schema_unreadable').map((line) => line.fields['read'])).toEqual([read]);
    expect(JSON.stringify(logs)).not.toMatch(/"(7|x)"/);
  });
});

describe('a read that says nothing about the mapping', () => {
  it.each([
    ['a timeout', { status: 'timeout' } as const, 'QUERY_TIMEOUT'],
    ['a lost connection', { status: 'unavailable', reason: 'unreachable' } as const, 'SOURCE_UNAVAILABLE'],
    ['a full pool', { status: 'unavailable', reason: 'pool-full' } as const, 'SOURCE_UNAVAILABLE'],
    ['a closed executor', { status: 'unavailable', reason: 'closed' } as const, 'SOURCE_UNAVAILABLE'],
  ])('%s is rethrown, and nothing is stored', async (_name, outcome, code) => {
    for (const read of ['tokens', 'indexes'] as const) {
      const { tester, store } = rig({ [read]: outcome });
      await expect(tester.run(request)).rejects.toMatchObject({ code });
      expect(store.checks).toEqual([]);
    }
  });
});

describe('the duplicate scan', () => {
  const NO_CONSTRAINT = rows({ indexes: FITTING.map((entry) => (entry.name === 'Gadget' && entry.property === 'gadgetId' ? { ...entry, constrained: false } : entry)), truncated: false });

  it('does not run when a constraint makes the stable ids unique', async () => {
    const { tester, calls } = rig();
    await tester.run(request);
    expect(calls()).not.toContain('stable-id-duplicates');
  });

  it('runs once for the entity type with an index and no constraint, with that entity type', async () => {
    const seen: ExecuteCall[] = [];
    const { tester } = rig({ indexes: NO_CONSTRAINT }, { onCall: (call) => call.templateId === 'stable-id-duplicates' && seen.push(call) });
    await tester.run(request);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.cypher).toBe(
      'MATCH (n:`Gadget`) USING INDEX n:`Gadget`(`gadgetId`) WHERE n.`gadgetId` IS NOT NULL WITH n.`gadgetId` AS value, count(*) AS c WHERE c > 1 RETURN toFloat(count(value)) AS duplicated',
    );
  });

  it('fails on duplicates with the count and no value', async () => {
    const { tester } = rig({ indexes: NO_CONSTRAINT, scan: rows({ duplicated: 4 }) });
    const report = await tester.run(request);
    expect(report).toMatchObject({ outcome: 'fail', state: 'unavailable' });
    expect(report.mappingChecks.findings).toEqual([expect.objectContaining({ check: 'stable-id-unique', entityType: 'gadget', property: 'gadgetId' })]);
    expect(report.mappingChecks.findings[0]?.message).toContain('4 values occur more than once');
  });

  it('warns that no constraint enforces uniqueness when no duplicate is found', async () => {
    const { tester } = rig({ indexes: NO_CONSTRAINT });
    const report = await tester.run(request);
    expect(report).toMatchObject({ outcome: 'warn', state: 'degraded', mappingChecks: { status: 'warn', findings: [{ check: 'stable-id-unenforced' }] } });
  });

  it('is not verified, and not a failure of the run, when the scan runs out of time', async () => {
    const { tester } = rig({ indexes: NO_CONSTRAINT, scan: { status: 'timeout' } });
    const report = await tester.run(request);
    expect(report).toMatchObject({ outcome: 'warn', mappingChecks: { status: 'not-verified', findings: [{ check: 'stable-id-unverified' }] } });
  });

  it('is not started for the entity types left when the time of the stage is spent', async () => {
    let now = Date.UTC(2026, 10, 2, 10, 0, 0);
    const bothUnconstrained = rows({ indexes: FITTING.map((entry) => (entry.property === 'gadgetId' || entry.property === 'personId' ? { ...entry, constrained: false } : entry)), truncated: false });
    const scans: string[] = [];
    const { tester } = rig(
      { indexes: bothUnconstrained, scan: (call) => ((now += STAGE_START_WINDOW_MS), scans.push(String(call.cypher)), { status: 'rows', rows: [{ duplicated: 0 }] }) },
      { clock: () => now },
    );
    const report = await tester.run(request);
    expect(scans).toHaveLength(1);
    expect(report.mappingChecks.findings.map((entry) => [entry.check, entry.entityType])).toEqual([
      ['stable-id-unenforced', 'gadget'],
      ['stable-id-unverified', 'person'],
    ]);
  });

  it('makes no scan read when the only RANGE index on the stable id is still being built, and warns that it is', async () => {
    const building = rows({ indexes: FITTING.map((entry) => (entry.name === 'Gadget' && entry.property === 'gadgetId' ? { ...entry, constrained: false, state: 'POPULATING' } : entry)), truncated: false });
    const { tester, calls } = rig({ indexes: building });
    const report = await tester.run(request);
    expect(report.mappingChecks.findings.map((entry) => [entry.check, entry.property])).toEqual([['index-building', 'gadgetId'], ['index-building', 'gadgetId']]);
    expect(calls()).not.toContain('stable-id-duplicates');
  });

  it('fails an entity type with neither a constraint nor a RANGE index and does not scan it', async () => {
    const { tester, calls } = rig({ indexes: missingIndexes((entry) => entry.name === 'Gadget' && entry.property === 'gadgetId') });
    const report = await tester.run(request);
    // the stable id is also a search property here, so the search index is missing as well
    expect(report.mappingChecks.findings.map((entry) => entry.check)).toEqual(['search-index', 'stable-id-unindexed']);
    expect(calls()).not.toContain('stable-id-duplicates');
  });

  it('is refused for a login that may not read the nodes: not verified', async () => {
    const { tester } = rig({ indexes: NO_CONSTRAINT, scan: { status: 'unavailable', reason: 'refused' } });
    expect((await tester.run(request)).mappingChecks).toMatchObject({ status: 'not-verified', findings: [{ check: 'schema-refused' }] });
  });
});

describe('a source the mapping checks do not run against', () => {
  it('is not run for a server version outside the matrix, with no schema read', async () => {
    const { tester, calls } = rig({}, { capabilities: rows({ ...SERVER_ROW, version: '4.4.0' }) });
    const report = await tester.run(request);
    expect(report).toMatchObject({ outcome: 'warn', stateReason: 'The server version is not on the support matrix.', mappingChecks: { status: 'not-run', findings: [] } });
    expect(calls()).toEqual(['capabilities', 'privileges']);
  });

  it('is not run for a source that did not answer', async () => {
    const { tester, calls } = rig({}, { capabilities: { status: 'unavailable', reason: 'unreachable' } });
    expect(await tester.run(request)).toMatchObject({ outcome: 'fail', mappingChecks: { status: 'not-run', findings: [] } });
    expect(calls()).toEqual(['capabilities']);
  });
});

describe('what a report and a log never hold', () => {
  it('holds no unmapped name, node value, address or credential', async () => {
    const { tester, logs } = rig({ indexes: rows({ indexes: [...FITTING, node('Gadget', 'gadgetId', { type: 'TEXT' })], truncated: false }), scan: rows({ duplicated: 0 }) });
    const report = await tester.run(request);
    const text = JSON.stringify([report, logs]);
    expect(text).not.toMatch(/graph\.example\.test|DEMO_PASSWORD|DEMO_USER/);
  });
});

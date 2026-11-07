import { rmSync } from 'node:fs';
import { degreePreviewSchema } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';
import { DEGREE_PREVIEW_BOUNDED_ID, DEGREE_PREVIEW_CHEAP_ID } from '../gate/templates/degree-preview.js';
import { DEGREE_PROBE_ID } from '../gate/templates/degree-probe.js';
import { createLogger } from '../logger.js';
import { observingStoreOf } from '../source-test/observing-store.js';
import { createStartupChecker } from '../source-test/startup.js';
import { createSourceTester } from '../source-test/tester.js';
import { createUsabilityRecord, type VerdictCheck } from '../source-test/usability.js';
import { refreshUsability } from '../source-test/usability-refresh.js';
import { memoryAppStore } from '../testing/app-store.js';
import { CHEAP_PLAN } from '../testing/fitting-schema.js';
import { fittingSchemaAnswer, SERVER_ROW as SERVER_FACTS } from '../testing/source-tester.js';
import { mappingOf, sourceWith } from '../testing/gate-fixtures.js';
import { TestExecutor } from '../testing/gate.js';
import { testSourceGate } from '../testing/source-gate.js';
import { makeWebRoot } from '../testing/web-root.js';
import { PRIVILEGES_ID } from '../gate/templates/privileges.js';
import type { Plan } from '../gate/types.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

const SERVER_ROW = { product: SERVER_FACTS.name, version: SERVER_FACTS.version, edition: SERVER_FACTS.edition };
const mapping = mappingOf(sourceWith('alpha'));
const EXPAND_PLAN: Plan = [{ name: 'Expand(All)', details: '(n)-[:T]->(m)', dbHits: 9 }];
const CHECKED_AT = Date.UTC(2026, 10, 2, 10, 0, 0);

interface Rig {
  readonly app: Awaited<ReturnType<typeof buildApp>>;
  readonly record: ReturnType<typeof createUsabilityRecord>;
  readonly store: ReturnType<typeof memoryAppStore>;
  readonly executor: TestExecutor;
  plan: Plan;
  readonly tester: ReturnType<typeof createSourceTester>;
  readonly checker: ReturnType<typeof createStartupChecker>;
}

async function started(): Promise<Rig> {
  const state: { plan: Plan } = { plan: CHEAP_PLAN };
  const executor = new TestExecutor((call): Promise<ExecuteOutcome> => {
    if (call.templateId === DEGREE_PREVIEW_BOUNDED_ID || call.templateId === DEGREE_PREVIEW_CHEAP_ID) return Promise.resolve({ status: 'rows', rows: [{ c0: 1, c1: 2, c2: 3 }] });
    if (call.templateId === DEGREE_PROBE_ID) return Promise.resolve({ status: 'rows', rows: [{ outgoing: 0, incoming: 0 }], plan: state.plan });
    if (call.templateId === PRIVILEGES_ID) return Promise.resolve({ status: 'unavailable', reason: 'refused' });
    if (call.templateId === 'capabilities') return Promise.resolve({ status: 'rows', rows: [SERVER_FACTS] });
    return Promise.resolve(fittingSchemaAnswer(call));
  });
  const record = createUsabilityRecord();
  const store = memoryAppStore();
  const observing = observingStoreOf(store, record);
  const parts = testSourceGate(mapping, { executor, usability: record });
  const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store: memoryAppStore(), mapping, gate: parts.gate, degreeVerdicts: record });
  const tester = createSourceTester({ gate: parts.gate, mapping, store: observing, clock: () => CHECKED_AT });
  const checker = createStartupChecker({ system: parts.system, mapping, store: { ...observing, markSourceUnchecked: () => Promise.resolve() }, logger: { info: () => undefined, warn: () => undefined }, clock: () => CHECKED_AT });
  return {
    app,
    record,
    store,
    executor,
    tester,
    checker,
    get plan() {
      return state.plan;
    },
    set plan(value: Plan) {
      state.plan = value;
    },
  };
}

const person = { sourceId: 'alpha', ref: { entityType: 'person', stableId: 'P-1' } };
const preview = (rig: Rig) => rig.app.inject({ method: 'POST', url: '/v1/graph/preview-expansion', payload: person });
const templatesRead = (rig: Rig) => rig.executor.calls.map((call) => call.templateId).filter((id) => id.startsWith('degree-preview'));
const principal = async (rig: Rig) => (await rig.store.current()).principal;

describe('which read a degree preview uses', () => {
  it('refuses a source no check has reached, without reading', async () => {
    const rig = await started();
    const response = await preview(rig);
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('SOURCE_UNAVAILABLE');
    expect(templatesRead(rig)).toEqual([]);
    await rig.app.close();
  });

  it('uses the bounded read for a usable mapping whose degree report has not run, and for one that lists another entity type', async () => {
    const rig = await started();
    rig.record.observe({ sourceId: 'alpha', checkedAt: '2026-11-02T10:00:00.000Z', server: SERVER_ROW, mappingChecks: { status: 'pass', findings: [] }, degreeChecks: { status: 'not-run', foundOn: null, types: [], warnings: [] } });
    expect((await preview(rig)).statusCode).toBe(200);
    rig.record.observe({
      sourceId: 'alpha',
      checkedAt: '2026-11-02T10:00:10.000Z',
      server: SERVER_ROW,
      mappingChecks: { status: 'pass', findings: [] },
      degreeChecks: { status: 'pass', foundOn: 'Neo4j 5.26.32', types: [{ entityType: 'order_line', result: 'cheap', basis: 'degree-operator', relationshipTypes: ['HAS LINE'] }], warnings: [] },
    });
    expect((await preview(rig)).statusCode).toBe(200);
    expect(templatesRead(rig)).toEqual([DEGREE_PREVIEW_BOUNDED_ID, DEGREE_PREVIEW_BOUNDED_ID]);
    await rig.app.close();
  });

  it('uses the cheap read after the API check shows the degree to be cheap, adds no capped-count warning, and goes back to the bounded read after a newer check that shows an expand', async () => {
    const rig = await started();
    await rig.tester.run({ traceId: 't', principal: await principal(rig), sourceId: 'alpha' });
    const first = degreePreviewSchema.parse((await preview(rig)).json());
    expect(templatesRead(rig)).toEqual([DEGREE_PREVIEW_CHEAP_ID]);
    expect(first.warnings.map((warning) => warning.code)).not.toContain('counts-capped');
    const revision = rig.record.revisionOf('alpha');
    rig.plan = EXPAND_PLAN;
    await rig.tester.run({ traceId: 't2', principal: await principal(rig), sourceId: 'alpha' });
    const second = degreePreviewSchema.parse((await preview(rig)).json());
    expect(templatesRead(rig)).toEqual([DEGREE_PREVIEW_CHEAP_ID, DEGREE_PREVIEW_BOUNDED_ID]);
    expect(second.warnings.map((warning) => warning.code)).toContain('counts-capped');
    expect(rig.record.revisionOf('alpha')).toBeGreaterThan(revision);
    await rig.app.close();
  });

  it('takes the verdict of the startup check', async () => {
    const rig = await started();
    await rig.checker.run();
    await preview(rig);
    expect(templatesRead(rig)).toEqual([DEGREE_PREVIEW_CHEAP_ID]);
    await rig.app.close();
  });

  it('takes the verdict of a check that another process stored, through the refresh of the record', async () => {
    const rig = await started();
    const other = memoryAppStore();
    await createSourceTester({ gate: testSourceGate(mapping, { executor: new TestExecutor((call) => Promise.resolve(call.templateId === 'capabilities' ? { status: 'rows', rows: [SERVER_FACTS] } : call.templateId === DEGREE_PROBE_ID ? { status: 'rows', rows: [{ outgoing: 0, incoming: 0 }], plan: CHEAP_PLAN } : call.templateId === PRIVILEGES_ID ? { status: 'unavailable', reason: 'refused' } : fittingSchemaAnswer(call))) }).gate, mapping, store: other, clock: () => CHECKED_AT }).run({ traceId: 't3', principal: (await other.current()).principal, sourceId: 'alpha' });
    await refreshUsability(other, rig.record, mapping, '2026-11-02T09:00:00.000Z', { warn: () => undefined });
    await preview(rig);
    expect(templatesRead(rig)).toEqual([DEGREE_PREVIEW_CHEAP_ID]);
    await rig.app.close();
  });

  describe('a stored check whose report cannot be read', () => {
    const readableCheck = (checkedAt: string): VerdictCheck => ({ sourceId: 'alpha', checkedAt, server: SERVER_ROW, mappingChecks: { status: 'pass', findings: [] }, degreeChecks: { status: 'pass', foundOn: 'x', types: [{ entityType: 'person', result: 'cheap', basis: 'degree-operator', relationshipTypes: ['KNOWS', 'HAS LINE'] }], warnings: [] } });
    const unreadableAt = (checkedAt: string) => ({ latestQualifyingChecks: (_sources: unknown, _since: string, onUnreadable?: (sourceId: string, at: string) => void) => (onUnreadable?.('alpha', checkedAt), Promise.resolve([])) });
    const refresh = (record: ReturnType<typeof createUsabilityRecord>, checkedAt: string) => refreshUsability(unreadableAt(checkedAt), record, mapping, '2026-11-02T09:00:00.000Z', { warn: () => undefined });

    it('forgets a cheap verdict when the newest stored report cannot be read, and uses the bounded read from then on', async () => {
      const rig = await started();
      await rig.tester.run({ traceId: 't', principal: await principal(rig), sourceId: 'alpha' });
      await preview(rig);
      const revision = rig.record.revisionOf('alpha');
      await refresh(rig.record, '2026-11-02T10:00:30.000Z');
      expect(rig.record.revisionOf('alpha')).toBeGreaterThan(revision);
      expect(rig.record.isCheap('alpha', 'person', ['KNOWS', 'HAS LINE'])).toBe(false);
      await preview(rig);
      expect(templatesRead(rig)).toEqual([DEGREE_PREVIEW_CHEAP_ID, DEGREE_PREVIEW_BOUNDED_ID]);
      await rig.app.close();
    });

    it('is not undone by a readable check that was made before it and arrives afterwards', async () => {
      const rig = await started();
      rig.record.observe(readableCheck('2026-11-02T10:00:10.000Z'));
      await refresh(rig.record, '2026-11-02T10:00:30.000Z');
      rig.record.observe(readableCheck('2026-11-02T10:00:20.000Z'));
      expect(rig.record.isCheap('alpha', 'person', ['KNOWS'])).toBe(false);
      rig.record.observe(readableCheck('2026-11-02T10:00:40.000Z'));
      expect(rig.record.isCheap('alpha', 'person', ['KNOWS'])).toBe(true);
      await rig.app.close();
    });

    it('is not undone when the cheap set was already empty, and a later readable check still counts', async () => {
      const rig = await started();
      rig.record.observe({ ...readableCheck('2026-11-02T10:00:10.000Z'), degreeChecks: { status: 'not-run', foundOn: null, types: [], warnings: [] } });
      await refresh(rig.record, '2026-11-02T10:00:30.000Z');
      rig.record.observe(readableCheck('2026-11-02T10:00:20.000Z'));
      expect(rig.record.isCheap('alpha', 'person', ['KNOWS'])).toBe(false);
      await rig.app.close();
    });

    it('changes nothing when it is older than the check the record holds', async () => {
      const rig = await started();
      rig.record.observe(readableCheck('2026-11-02T10:00:30.000Z'));
      const revision = rig.record.revisionOf('alpha');
      await refresh(rig.record, '2026-11-02T10:00:10.000Z');
      expect(rig.record.isCheap('alpha', 'person', ['KNOWS'])).toBe(true);
      expect(rig.record.revisionOf('alpha')).toBe(revision);
      await rig.app.close();
    });
  });

  it('keeps the verdict of the newer check when an older one arrives afterwards, and does not move the revision', async () => {
    const rig = await started();
    const newer: VerdictCheck = { sourceId: 'alpha', checkedAt: '2026-11-02T10:00:20.000Z', server: SERVER_ROW, mappingChecks: { status: 'pass', findings: [] }, degreeChecks: { status: 'pass', foundOn: 'x', types: [{ entityType: 'person', result: 'cheap', basis: 'degree-operator', relationshipTypes: ['KNOWS', 'HAS LINE'] }], warnings: [] } };
    rig.record.observe(newer);
    const revision = rig.record.revisionOf('alpha');
    rig.record.observe({ ...newer, checkedAt: '2026-11-02T10:00:10.000Z', degreeChecks: { status: 'not-run', foundOn: null, types: [], warnings: [] } });
    expect(rig.record.revisionOf('alpha')).toBe(revision);
    expect(rig.record.isCheap('alpha', 'person', ['KNOWS'])).toBe(true);
    expect(rig.record.isCheap('alpha', 'person', ['KNOWS', 'OTHER'])).toBe(false);
    await rig.app.close();
  });

  it('does not move the revision for a check that shows the same', async () => {
    const rig = await started();
    const check: VerdictCheck = { sourceId: 'alpha', checkedAt: '2026-11-02T10:00:20.000Z', server: SERVER_ROW, mappingChecks: { status: 'pass', findings: [] }, degreeChecks: { status: 'pass', foundOn: 'x', types: [{ entityType: 'person', result: 'cheap', basis: 'degree-operator', relationshipTypes: ['KNOWS'] }], warnings: [] } };
    rig.record.observe(check);
    const revision = rig.record.revisionOf('alpha');
    rig.record.observe({ ...check, checkedAt: '2026-11-02T10:00:30.000Z' });
    expect(rig.record.revisionOf('alpha')).toBe(revision);
    rig.record.observe({ ...check, checkedAt: '2026-11-02T10:00:40.000Z', degreeChecks: { status: 'warn', foundOn: 'x', types: [{ entityType: 'person', result: 'not-cheap', basis: 'expand', relationshipTypes: ['KNOWS'] }], warnings: ['x'] } });
    expect(rig.record.revisionOf('alpha')).toBe(revision + 1);
    await rig.app.close();
  });
});

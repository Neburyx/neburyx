import { rmSync } from 'node:fs';
import { coverageResponseSchema, type CoverageEntity } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';
import { createLogger } from '../logger.js';
import { parseMapping } from '../mapping/load.js';
import { communitySeams } from '../seams/community-seams.js';
import type { AuditEvent, Seams } from '../seams/seams.js';
import { createUsabilityRecord, type VerdictCheck } from '../source-test/usability.js';
import { memoryAppStore } from '../testing/app-store.js';
import { TestExecutor } from '../testing/gate.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { withOnlineIndexes } from '../testing/search-fixtures.js';
import { testSourceGate } from '../testing/source-gate.js';
import { makeWebRoot } from '../testing/web-root.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

const mapping = parseMapping(
  fileOf(
    baseSource({
      id: 'alpha',
      entities: [
        { type: 'person', label: 'Person', stable_id: 'personId' },
        { type: 'twin_a', label: 'Twin', stable_id: 'twinId' },
        { type: 'twin_b', label: 'Twin', stable_id: 'twinId' },
      ],
      relationships: [
        { type: 'KNOWS', from: 'person', to: 'person' },
        { type: 'TWINNED', from: 'twin_a', to: 'twin_b' },
      ],
    }),
  ),
  'neburyx.yaml',
);
const REACHED = { product: 'Neo4j Kernel', version: '5.26.32', edition: 'community' };
const CHECK: VerdictCheck = { sourceId: 'alpha', checkedAt: '2026-11-02T10:00:00.000Z', server: REACHED, mappingChecks: { status: 'pass', findings: [] }, degreeChecks: { status: 'not-run', foundOn: null, types: [], warnings: [] } };
const AUDIT_ACTION = 'entity.degree_preview';

const entity = (stableId: string, loadedRelationships = 0, sourceId = 'alpha', entityType = 'person', loadedQuality: CoverageEntity['loadedQuality'] = 'exact') => ({ ref: { sourceId, entityType, stableId }, loadedRelationships, loadedQuality });
const counts: Readonly<Record<string, readonly [number, number]>> = { 'P-1': [3, 4], 'P-2': [1, 1], 'P-3': [2, 0], 'T-1': [2, 0] };

interface Options {
  readonly auditFails?: boolean;
  readonly deny?: () => boolean;
  readonly lifetimeMs?: number;
  readonly clock?: () => number;
}

async function started(options: Options = {}) {
  const [source] = mapping.sources;
  if (source === undefined) throw new Error('the mapping has no source');
  const record = createUsabilityRecord();
  record.observe(CHECK);
  const events: AuditEvent[] = [];
  const logged: string[] = [];
  const defaults = communitySeams();
  let admissions = 0;
  const seams: Pick<Seams, 'policy' | 'coordinator' | 'audit'> = {
    policy: { authorizeSource: (request) => (options.deny?.() === true ? Promise.resolve({ allowed: false, reason: 'no' }) : defaults.policy.authorizeSource(request)) },
    coordinator: { acquireRead: (request) => ((admissions += 1), defaults.coordinator.acquireRead(request)) },
    audit: { record: (event) => (events.push(event), options.auditFails === true && event.action === AUDIT_ACTION && event.traceId !== undefined && events.filter((seen) => seen.action === AUDIT_ACTION).length > 1 ? Promise.reject(new Error('down')) : Promise.resolve()) },
  };
  const answer = (call: ExecuteCall): Promise<ExecuteOutcome> => {
    const pair = counts[String(call.parameters['stableId'])] ?? [0, 0];
    // an entity type with one mapped pair is read with one count column
    return Promise.resolve({ status: 'rows', rows: [String(call.parameters['stableId']).startsWith('T-') ? { c0: pair[0] } : { c0: pair[0], c1: pair[1] }] });
  };
  const executor = new TestExecutor(withOnlineIndexes(source, answer));
  const parts = testSourceGate(mapping, { executor, seams });
  const logger = createLogger({ write: (line) => void logged.push(line) });
  const degreeCache = options.lifetimeMs === undefined ? {} : { degreeCache: { lifetimeMs: options.lifetimeMs, ...(options.clock === undefined ? {} : { clock: options.clock }) } };
  const app = await buildApp({ webRoot, logger, store: memoryAppStore(), mapping, gate: parts.gate, seams, degreeVerdicts: record, ...degreeCache });
  const preview = (stableId: string, mask = false) => app.inject({ method: 'POST', url: '/v1/graph/preview-expansion', payload: { sourceId: 'alpha', ref: { entityType: 'person', stableId }, mask } });
  const coverage = (payload: object) => app.inject({ method: 'POST', url: '/v1/graph/coverage', payload });
  const coverageEvents = () => events.filter((event) => event.action === AUDIT_ACTION);
  return { app, record, executor, events, logged, admissions: () => admissions, preview, coverage, coverageEvents };
}

const unknown = { notRetrieved: { quality: 'unknown', scope: 'not yet retrieved' } };

describe('POST /v1/graph/coverage', () => {
  it('answers a previewed node with its total less the relationships loaded, in the quality of the preview (here exact)', async () => {
    const { app, preview, coverage } = await started();
    await preview('P-1');
    const response = await coverage({ sourceId: 'alpha', entities: [entity('P-1', 2)] });
    expect(response.statusCode).toBe(200);
    expect(coverageResponseSchema.parse(response.json())).toEqual({ notRetrieved: { value: 5, quality: 'exact', scope: 'not yet retrieved' } });
    await app.close();
  });

  it('answers unknown, with no value, for a node that was never previewed', async () => {
    const { app, coverage } = await started();
    const response = await coverage({ sourceId: 'alpha', entities: [entity('P-1')] });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(unknown);
    await app.close();
  });

  it('answers unknown for a preview that expired', async () => {
    let now = 0;
    const { app, preview, coverage } = await started({ lifetimeMs: 1000, clock: () => now });
    await preview('P-1');
    now = 1000;
    expect((await coverage({ sourceId: 'alpha', entities: [entity('P-1')] })).json()).toEqual(unknown);
    await app.close();
  });

  it('answers unknown after a newer check changed the degree verdict', async () => {
    const { app, record, preview, coverage } = await started();
    await preview('P-1');
    record.observe({ ...CHECK, checkedAt: '2026-11-02T10:00:10.000Z', degreeChecks: { status: 'pass', foundOn: 'x', types: [{ entityType: 'person', result: 'cheap', basis: 'degree-operator', relationshipTypes: ['KNOWS'] }], warnings: [] } } as VerdictCheck);
    expect((await coverage({ sourceId: 'alpha', entities: [entity('P-1')] })).json()).toEqual(unknown);
    await app.close();
  });

  it('never serves a preview made under the other mask setting', async () => {
    const { app, preview, coverage } = await started();
    await preview('P-1', false);
    expect((await coverage({ sourceId: 'alpha', entities: [entity('P-1')], mask: true })).json()).toEqual(unknown);
    await preview('P-2', true);
    expect((await coverage({ sourceId: 'alpha', entities: [entity('P-2')] })).json()).toEqual(unknown);
    expect((await coverage({ sourceId: 'alpha', entities: [entity('P-2')], mask: true })).json().notRetrieved.value).toBe(2);
    await app.close();
  });

  it('never reads the source, takes no read slot and computes no preview', async () => {
    const { app, executor, admissions, preview, coverage } = await started();
    await preview('P-1');
    const reads = executor.calls.length;
    const slots = admissions();
    await coverage({ sourceId: 'alpha', entities: [entity('P-1'), entity('P-2')] });
    await coverage({ sourceId: 'alpha', entities: [entity('P-3')] });
    expect(executor.calls).toHaveLength(reads);
    expect(admissions()).toBe(slots);
    await app.close();
  });

  it('records one audit event for each request, with no entity reference or stable ID', async () => {
    const { app, events, preview, coverage, coverageEvents } = await started();
    await preview('P-1');
    const before = coverageEvents().length;
    await coverage({ sourceId: 'alpha', entities: [entity('P-1'), entity('P-2'), entity('P-3')] });
    const added = coverageEvents().slice(before);
    expect(added).toHaveLength(1);
    expect(Object.keys(added[0] ?? {}).sort()).toEqual(Object.keys(events[events.length - 1] ?? {}).sort());
    expect(JSON.stringify(added)).not.toMatch(/P-1|P-2|P-3|stableId/);
    await app.close();
  });

  it('still answers, and logs a warning with no event data, when the audit write fails', async () => {
    const { app, logged, preview, coverage } = await started({ auditFails: true });
    await preview('P-1');
    const response = await coverage({ sourceId: 'alpha', entities: [entity('P-1')] });
    expect(response.statusCode).toBe(200);
    const warning = logged.find((line) => line.includes('coverage.audit_failed'));
    expect(warning).toBeDefined();
    expect(warning).not.toMatch(/P-1|actorId/);
    await app.close();
  });

  it('refuses an entity of another source with SOURCE_MISMATCH before looking anything up', async () => {
    const { app, executor, events, coverage } = await started();
    const seen = events.length;
    const response = await coverage({ sourceId: 'alpha', entities: [entity('P-1'), entity('P-9', 0, 'beta')] });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('SOURCE_MISMATCH');
    expect(events).toHaveLength(seen);
    expect(executor.calls).toHaveLength(0);
    await app.close();
  });

  it('refuses a body that is not valid with INVALID_REQUEST', async () => {
    const { app, coverage } = await started();
    const many = Array.from({ length: 501 }, (_unused, index) => entity(`P-${index}`));
    const bodies: object[] = [
      { sourceId: 'alpha', entities: [] },
      { sourceId: 'alpha', entities: many },
      { sourceId: 'alpha', entities: [entity('P-1')], extra: true },
      { sourceId: 'alpha', entities: [entity('P-1', -1)] },
      { sourceId: 'alpha', entities: [entity('P-1', 1.5)] },
      { entities: [entity('P-1')] },
    ];
    for (const body of bodies) {
      const response = await coverage(body);
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('INVALID_REQUEST');
    }
    await app.close();
  });

  it('answers NOT_FOUND for an entity type that is not in the mapping and for a source that is not configured', async () => {
    const { app, coverage } = await started();
    const type = await coverage({ sourceId: 'alpha', entities: [entity('P-1', 0, 'alpha', 'nothing')] });
    expect(type.statusCode).toBe(404);
    const source = await coverage({ sourceId: 'nope', entities: [entity('P-1', 0, 'nope')] });
    expect(source.statusCode).toBe(404);
    expect({ ...type.json().error, traceId: undefined, message: undefined }).toEqual({ ...source.json().error, traceId: undefined, message: undefined });
    await app.close();
  });

  it('uses the preview of an entity whose type shares its label with another type', async () => {
    const { app, coverage } = await started();
    const previewed = await app.inject({ method: 'POST', url: '/v1/graph/preview-expansion', payload: { sourceId: 'alpha', ref: { entityType: 'twin_a', stableId: 'T-1' }, mask: false } });
    expect(previewed.statusCode).toBe(200);
    const response = await coverage({ sourceId: 'alpha', entities: [entity('T-1', 0, 'alpha', 'twin_a')] });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ notRetrieved: { value: 2, quality: 'exact', scope: 'not yet retrieved' } });
    await app.close();
  });

  it('answers NOT_FOUND once the person may no longer read the source, and still answers after a failed mapping check', async () => {
    let denied = false;
    const { app, record, preview, coverage } = await started({ deny: () => denied });
    await preview('P-1');
    record.observe({ ...CHECK, checkedAt: '2026-11-02T10:00:10.000Z', mappingChecks: { status: 'fail', findings: [{ severity: 'fail', check: 'label', message: 'x' }] } });
    const answered = await coverage({ sourceId: 'alpha', entities: [entity('P-1')] });
    expect(answered.statusCode).toBe(200);
    denied = true;
    expect((await coverage({ sourceId: 'alpha', entities: [entity('P-1')] })).statusCode).toBe(404);
    await app.close();
  });

  it('sums two previewed nodes as at best estimated and never exact', async () => {
    const { app, preview, coverage } = await started();
    await preview('P-1');
    await preview('P-2');
    const response = await coverage({ sourceId: 'alpha', entities: [entity('P-1'), entity('P-2')] });
    expect(response.json()).toEqual({ notRetrieved: { value: 9, quality: 'estimated', scope: 'not yet retrieved' } });
    await app.close();
  });

  it('answers the largest remainder as a lower bound when one of several nodes has no preview', async () => {
    const { app, preview, coverage } = await started();
    await preview('P-1');
    const response = await coverage({ sourceId: 'alpha', entities: [entity('P-1', 2), entity('P-2')] });
    expect(response.json()).toEqual({ notRetrieved: { value: 5, quality: 'lowerBound', scope: 'not yet retrieved' } });
    await app.close();
  });

  it('subtracts the relationships loaded at the node, aggregate members included, and says how sure it is', async () => {
    const { app, preview, coverage } = await started();
    await preview('P-1');
    const only = await coverage({ sourceId: 'alpha', entities: [entity('P-1', 3)] });
    expect(only.json()).toEqual({ notRetrieved: { value: 4, quality: 'exact', scope: 'not yet retrieved' } });
    const withUnknown = await coverage({ sourceId: 'alpha', entities: [entity('P-1', 3), entity('P-2')] });
    expect(withUnknown.json()).toEqual({ notRetrieved: { value: 4, quality: 'lowerBound', scope: 'not yet retrieved' } });
    const inexact = await coverage({ sourceId: 'alpha', entities: [entity('P-1', 3, 'alpha', 'person', 'estimated')] });
    expect(inexact.json()).toEqual({ notRetrieved: { value: 4, quality: 'estimated', scope: 'not yet retrieved' } });
    const unknownLoaded = await coverage({ sourceId: 'alpha', entities: [entity('P-1', 3, 'alpha', 'person', 'unknown')] });
    expect(unknownLoaded.json()).toEqual(unknown);
    await app.close();
  });

  it('clamps the remainder to 0 and answers estimated when more is loaded than the preview counted', async () => {
    const { app, preview, coverage } = await started();
    await preview('P-2');
    const response = await coverage({ sourceId: 'alpha', entities: [entity('P-2', 3)] });
    expect(response.json()).toEqual({ notRetrieved: { value: 0, quality: 'estimated', scope: 'not yet retrieved' } });
    await app.close();
  });

  it('refuses the same entity named twice with INVALID_REQUEST', async () => {
    const { app, preview, coverage } = await started();
    await preview('P-1');
    const response = await coverage({ sourceId: 'alpha', entities: [entity('P-1'), entity('P-1', 1)] });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_REQUEST');
    await app.close();
  });
});

import { rmSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import type { ExecuteOutcome } from '../gate/executor.js';
import { createLogger } from '../logger.js';
import { communitySeams } from '../seams/community-seams.js';
import type { AuditEvent, Seams } from '../seams/seams.js';
import { createUsabilityRecord, type VerdictCheck } from '../source-test/usability.js';
import { memoryAppStore } from '../testing/app-store.js';
import { TestExecutor } from '../testing/gate.js';
import { mappingOf, sourceWith } from '../testing/gate-fixtures.js';
import { withOnlineIndexes } from '../testing/search-fixtures.js';
import { testSourceGate } from '../testing/source-gate.js';
import { makeWebRoot } from '../testing/web-root.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

const mapping = mappingOf(sourceWith('alpha'));
const loneMapping = mappingOf(sourceWith('alpha', { relationships: [{ type: 'KNOWS', from: 'person', to: 'person' }] }));
const REACHED = { product: 'Neo4j Kernel', version: '5.26.32', edition: 'community' };
const CHECK: VerdictCheck = { sourceId: 'alpha', checkedAt: '2026-11-02T10:00:00.000Z', server: REACHED, mappingChecks: { status: 'pass', findings: [] }, degreeChecks: { status: 'not-run', foundOn: null, types: [], warnings: [] } };
const body = (mask = false) => ({ sourceId: 'alpha', ref: { entityType: 'person', stableId: 'P-1' }, mask });

async function started(options: { readonly deny?: () => boolean; readonly onRead?: (record: ReturnType<typeof createUsabilityRecord>) => void } = {}) {
  const [source] = mapping.sources;
  if (source === undefined) throw new Error('the mapping has no source');
  const record = createUsabilityRecord();
  record.observe(CHECK);
  const events: AuditEvent[] = [];
  const defaults = communitySeams();
  let admissions = 0;
  const seams: Pick<Seams, 'policy' | 'coordinator' | 'audit'> = {
    policy: { authorizeSource: (request) => (options.deny?.() === true ? Promise.resolve({ allowed: false, reason: 'no' }) : defaults.policy.authorizeSource(request)) },
    coordinator: { acquireRead: (request) => ((admissions += 1), defaults.coordinator.acquireRead(request)) },
    audit: { record: (event) => (events.push(event), Promise.resolve()) },
  };
  const executor = new TestExecutor(
    withOnlineIndexes(source, (): Promise<ExecuteOutcome> => {
      options.onRead?.(record);
      return Promise.resolve({ status: 'rows', rows: [{ c0: 1, c1: 2, c2: 3 }] });
    }),
  );
  const parts = testSourceGate(mapping, { executor, seams });
  const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store: memoryAppStore(), mapping, gate: parts.gate, seams, degreeVerdicts: record });
  const reads = () => executor.calls.filter((call) => call.templateId.startsWith('degree-preview')).length;
  const previews = () => events.filter((event) => event.action === 'entity.degree_preview');
  return { app, record, reads, previews, executor, admissions: () => admissions };
}

const post = (app: Awaited<ReturnType<typeof started>>['app'], payload: object) => app.inject({ method: 'POST', url: '/v1/graph/preview-expansion', payload });

describe('the degree preview cache in the endpoint', () => {
  it('takes one read slot for each read of a preview it reads, and none for a preview it answers from the cache', async () => {
    const { app, executor, admissions } = await started();
    expect((await post(app, body())).statusCode).toBe(200);
    expect(admissions()).toBe(executor.calls.length);
    expect(executor.calls.filter((call) => call.templateId.startsWith('degree-preview'))).toHaveLength(1);
    const before = admissions();
    expect((await post(app, body())).statusCode).toBe(200);
    expect(admissions()).toBe(before);
    await app.close();
  });

  it('answers the same request again without reading the source, and says the same', async () => {
    const { app, reads } = await started();
    const first = await post(app, body());
    const second = await post(app, body());
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(reads()).toBe(1);
    await app.close();
  });

  it('answers the preview of a node whose entity type has no mapped relationship from the cache the second time', async () => {
    const [source] = mapping.sources;
    if (source === undefined) throw new Error('the mapping has no source');
    const record = createUsabilityRecord();
    record.observe(CHECK);
    const loads: string[] = [];
    const executor = new TestExecutor(
      withOnlineIndexes(source, (call): Promise<ExecuteOutcome> => {
        loads.push(call.templateId);
        return Promise.resolve({ status: 'rows', rows: [{ n: { $type: 'node', elementId: '4:fixture:1', labels: ['Order Line'], properties: { id: 'L-1' } } }] });
      }),
    );
    const events: AuditEvent[] = [];
    const defaults = communitySeams();
    const seams: Pick<Seams, 'policy' | 'coordinator' | 'audit'> = { policy: defaults.policy, coordinator: defaults.coordinator, audit: { record: (event) => (events.push(event), Promise.resolve()) } };
    const parts = testSourceGate(loneMapping, { executor, seams });
    const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store: memoryAppStore(), mapping: loneMapping, gate: parts.gate, seams, degreeVerdicts: record });
    const request = { sourceId: 'alpha', ref: { entityType: 'order_line', stableId: 'L-1' } };
    expect((await post(app, request)).statusCode).toBe(200);
    expect((await post(app, request)).statusCode).toBe(200);
    expect(loads.filter((id) => id === 'entity-load')).toHaveLength(1);
    expect(events.filter((event) => event.action !== 'source.schema_indexes').map((event) => `${event.action} ${event.result}`)).toEqual(['entity.load success', 'entity.load success']);
    await app.close();
  });

  it('reads again for the other mask setting and keeps both answers', async () => {
    const { app, reads } = await started();
    await post(app, body(true));
    await post(app, body(false));
    expect(reads()).toBe(2);
    await post(app, body(true));
    await post(app, body(false));
    expect(reads()).toBe(2);
    await app.close();
  });

  it('records one event for a miss and one for a hit', async () => {
    const { app, previews } = await started();
    await post(app, body());
    await post(app, body());
    expect(previews().map((event) => event.result)).toEqual(['success', 'success']);
    await app.close();
  });

  it('answers NOT_FOUND from a cached answer once the person may no longer read the source, and audits the denial', async () => {
    let denied = false;
    const { app, reads, previews } = await started({ deny: () => denied });
    await post(app, body());
    denied = true;
    const response = await post(app, body());
    expect(response.statusCode).toBe(404);
    expect(reads()).toBe(1);
    expect(previews().map((event) => event.result)).toEqual(['success', 'denied']);
    await app.close();
  });

  it('serves a cached answer after a newer mapping check failed for a type that is not the node\'s, with the degree verdict unchanged', async () => {
    const { app, record, reads, previews } = await started();
    const first = await post(app, body());
    record.observe({ ...CHECK, checkedAt: '2026-11-02T10:00:10.000Z', mappingChecks: { status: 'fail', findings: [{ severity: 'fail', check: 'label', message: 'Entity type "order_line" (label "Order Line"): no node carries the label' }] } });
    const response = await post(app, body());
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(first.json());
    expect(reads()).toBe(1);
    expect(previews().map((event) => event.result)).toEqual(['success', 'success']);
    await app.close();
  });

  it('reads the source again, through the guard, while the source has a failing check, when the answer is not cached', async () => {
    const { app, record, reads } = await started();
    record.observe({ ...CHECK, checkedAt: '2026-11-02T10:00:10.000Z', mappingChecks: { status: 'fail', findings: [{ severity: 'fail', check: 'label', message: 'x' }] } });
    expect((await post(app, body())).statusCode).toBe(200);
    expect(reads()).toBe(1);
    await app.close();
  });

  it('reads again after a newer check changed the degree verdict', async () => {
    const { app, record, reads } = await started();
    await post(app, body());
    record.observe({ ...CHECK, checkedAt: '2026-11-02T10:00:10.000Z', degreeChecks: { status: 'pass', foundOn: 'x', types: [{ entityType: 'person', result: 'cheap', basis: 'degree-operator', relationshipTypes: ['KNOWS', 'HAS LINE'] }], warnings: [] } });
    await post(app, body());
    expect(reads()).toBe(2);
    await app.close();
  });

  it('returns but does not keep an answer read while a newer verdict arrived', async () => {
    let arrived = false;
    const { app, reads } = await started({
      onRead: (record) => {
        if (arrived) return;
        arrived = true;
        record.observe({ ...CHECK, checkedAt: '2026-11-02T10:00:10.000Z', degreeChecks: { status: 'pass', foundOn: 'x', types: [{ entityType: 'person', result: 'cheap', basis: 'degree-operator', relationshipTypes: ['KNOWS', 'HAS LINE'] }], warnings: [] } });
      },
    });
    const first = await post(app, body());
    expect(first.statusCode).toBe(200);
    await post(app, body());
    await post(app, body());
    expect(reads()).toBe(2);
    await app.close();
  });

  it('keeps nothing for a read that failed', async () => {
    const [source] = mapping.sources;
    if (source === undefined) throw new Error('no source');
    const record = createUsabilityRecord();
    record.observe(CHECK);
    let fail = true;
    const executor = new TestExecutor(withOnlineIndexes(source, () => Promise.resolve<ExecuteOutcome>(fail ? { status: 'timeout' } : { status: 'rows', rows: [{ c0: 1, c1: 2, c2: 3 }] })));
    const parts = testSourceGate(mapping, { executor });
    const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store: memoryAppStore(), mapping, gate: parts.gate, degreeVerdicts: record });
    expect((await post(app, body())).statusCode).toBe(504);
    fail = false;
    expect((await post(app, body())).statusCode).toBe(200);
    expect(executor.calls.filter((call) => call.templateId.startsWith('degree-preview'))).toHaveLength(2);
    await app.close();
  });
});

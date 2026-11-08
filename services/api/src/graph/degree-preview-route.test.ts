import { rmSync } from 'node:fs';
import { degreePreviewSchema } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';
import { createLogger } from '../logger.js';
import { parseMapping } from '../mapping/load.js';
import { communitySeams } from '../seams/community-seams.js';
import type { AuditEvent, Seams } from '../seams/seams.js';
import { memoryAppStore } from '../testing/app-store.js';
import { entityRows, plainNode } from '../testing/entity-fixtures.js';
import { TestExecutor } from '../testing/gate.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { onlineIndexesOf, schemaAnswer, withOnlineIndexes, withSchema, type IndexRow } from '../testing/search-fixtures.js';
import { testSourceGate } from '../testing/source-gate.js';
import { makeWebRoot } from '../testing/web-root.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

const sourceOf = (extra: Record<string, unknown> = {}) =>
    baseSource({
      id: 'demo',
      entities: [
        { type: 'widget', label: 'Widget', stable_id: 'widgetId' },
        { type: 'gadget', label: 'Gadget', stable_id: 'gadgetId' },
        { type: 'island', label: 'Island', stable_id: 'islandId' },
        { type: 'twin_a', label: 'Twin', stable_id: 'twinId' },
        { type: 'twin_b', label: 'Twin', stable_id: 'twinId' },
      ],
      relationships: [
        { type: 'LINKS', from: 'widget', to: 'gadget' },
        { type: 'LINKS', from: 'widget', to: 'widget' },
        { type: 'KNOWS', from: 'gadget', to: 'widget' },
        { type: 'TWINNED', from: 'twin_a', to: 'twin_b' },
      ],
      ...extra,
    });
const mapping = parseMapping(fileOf(sourceOf()), 'neburyx.yaml');
const defaultMapping = mapping;
const mappingWithThreshold = parseMapping(fileOf(sourceOf({ budgets: { heavy_op_threshold: 40 } })), 'neburyx.yaml');

interface Options {
  readonly degrees?: (call: ExecuteCall) => ExecuteOutcome;
  readonly nodes?: ExecuteOutcome;
  readonly indexes?: (online: readonly IndexRow[]) => readonly IndexRow[];
  readonly deny?: boolean;
  readonly mapping?: typeof mapping;
}

const rowOf = (...counts: number[]): ExecuteOutcome => ({ status: 'rows', rows: [{ ...Object.fromEntries(counts.map((count, index) => [`c${index}`, count])) }] });

async function started(options: Options = {}) {
  const mapping = options.mapping ?? defaultMapping;
  const [source] = mapping.sources;
  if (source === undefined) throw new Error('the mapping has no source');
  const answer = (call: ExecuteCall): Promise<ExecuteOutcome> => {
    if (call.templateId === 'entity-load') return Promise.resolve(options.nodes ?? entityRows(plainNode(['Island'], { islandId: 'I-1' })));
    return Promise.resolve((options.degrees ?? (() => rowOf(2, 501, 4)))(call));
  };
  const online = onlineIndexesOf(source);
  const executor = new TestExecutor(withSchema(() => schemaAnswer(options.indexes?.(online) ?? online), answer));
  const events: AuditEvent[] = [];
  const defaults = communitySeams();
  const seams: Pick<Seams, 'policy' | 'coordinator' | 'audit'> = {
    policy: options.deny === true ? { authorizeSource: () => Promise.resolve({ allowed: false, reason: 'no' }) } : defaults.policy,
    coordinator: defaults.coordinator,
    audit: { record: (event) => (events.push(event), Promise.resolve()) },
  };
  const parts = testSourceGate(mapping, { executor, seams });
  const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store: memoryAppStore(), mapping, gate: parts.gate, seams });
  return { app, executor, events };
}

type Started = Awaited<ReturnType<typeof started>>;
const post = (app: Started['app'], body: object) => app.inject({ method: 'POST', url: '/v1/graph/preview-expansion', payload: body });
const widget = { sourceId: 'demo', ref: { entityType: 'widget', stableId: 'W-1' } };
const degreeCalls = (executor: TestExecutor) => executor.calls.filter((call) => call.templateId === 'degree-preview-bounded');

describe('POST /v1/graph/preview-expansion', () => {
  it('answers 200 with a count for each mapped pair, the entity types at the other ends, and the total with the weakest quality of its parts', async () => {
    const { app } = await started();
    const response = await post(app, widget);
    expect(response.statusCode).toBe(200);
    const preview = degreePreviewSchema.parse(response.json());
    expect(preview.ref).toEqual({ sourceId: 'demo', entityType: 'widget', stableId: 'W-1' });
    expect(preview.byType).toEqual([
      { relationshipType: 'LINKS', direction: 'out', count: { value: 2, quality: 'exact', scope: 'degree:out:LINKS:mapped-relationship-ends' }, neighborTypes: ['gadget', 'widget'] },
      { relationshipType: 'LINKS', direction: 'in', count: { value: 500, quality: 'lowerBound', scope: 'degree:in:LINKS:mapped-relationship-ends' }, neighborTypes: ['widget'] },
      { relationshipType: 'KNOWS', direction: 'in', count: { value: 4, quality: 'exact', scope: 'degree:in:KNOWS:mapped-relationship-ends' }, neighborTypes: ['gadget'] },
    ]);
    expect(preview.total).toEqual({ value: 506, quality: 'lowerBound', scope: 'degree:total:mapped-relationship-ends' });
    expect(preview.byNeighborType).toEqual([
      { entityType: 'gadget', count: { quality: 'unknown', scope: 'degree:neighbor:gadget:mapped-relationship-ends' } },
      { entityType: 'widget', count: { quality: 'unknown', scope: 'degree:neighbor:widget:mapped-relationship-ends' } },
    ]);
    await app.close();
  });

  it('carries the source\'s warning threshold: 500 when the budgets name none, the configured one otherwise, and for a node whose entity type has no mapped relationship', async () => {
    const plain = await started();
    expect(degreePreviewSchema.parse((await post(plain.app, widget)).json()).heavyOpThreshold).toBe(500);
    await plain.app.close();
    const set = await started({ mapping: mappingWithThreshold, degrees: () => rowOf(2, 3, 4) });
    expect(degreePreviewSchema.parse((await post(set.app, widget)).json()).heavyOpThreshold).toBe(40);
    expect(degreePreviewSchema.parse((await post(set.app, { sourceId: 'demo', ref: { entityType: 'island', stableId: 'I-1' } })).json()).heavyOpThreshold).toBe(40);
    await set.app.close();
  });

  it('carries the same threshold from the cache and for a masked request, with nothing else changed by the mask', async () => {
    const { app } = await started({ mapping: mappingWithThreshold, degrees: () => rowOf(2, 3, 4) });
    const first = degreePreviewSchema.parse((await post(app, widget)).json());
    const again = degreePreviewSchema.parse((await post(app, widget)).json());
    const masked = degreePreviewSchema.parse((await post(app, { ...widget, mask: true })).json());
    expect(again).toEqual(first);
    expect(masked.heavyOpThreshold).toBe(40);
    expect({ ...masked, heavyOpThreshold: 0 }).toEqual({ ...first, heavyOpThreshold: 0 });
    await app.close();
  });

  it('adds a capped-count warning for each pair the bounded read counted', async () => {
    const { app } = await started();
    const preview = degreePreviewSchema.parse((await post(app, widget)).json());
    expect(preview.warnings.map((warning) => `${warning.code} ${warning.relationshipType ?? ''}`)).toEqual(['counts-capped LINKS', 'counts-capped LINKS', 'counts-capped KNOWS']);
    await app.close();
  });

  it('carries a duplicate-stable-id warning when a second node has the ID', async () => {
    const { app } = await started({ degrees: () => ({ status: 'rows', rows: [{ c0: 1, c1: 1, c2: 1 }, { c0: 5, c1: 5, c2: 5 }] }) });
    const preview = degreePreviewSchema.parse((await post(app, widget)).json());
    expect(preview.warnings.map((warning) => warning.code)).toContain('duplicate-stable-id');
    await app.close();
  });

  it('answers 200 with empty lists and an exact zero for an existing node whose entity type has no mapped relationship', async () => {
    const { app } = await started();
    const response = await post(app, { sourceId: 'demo', ref: { entityType: 'island', stableId: 'I-1' } });
    expect(response.statusCode).toBe(200);
    expect(degreePreviewSchema.parse(response.json())).toMatchObject({ byType: [], byNeighborType: [], warnings: [], total: { value: 0, quality: 'exact', scope: 'degree:total:mapped-relationship-ends' } });
    await app.close();
  });

  it('carries a duplicate-stable-id warning for an existing node with no mapped relationship when a second node has the ID', async () => {
    const node = plainNode(['Island'], { islandId: 'I-1' });
    const { app } = await started({ nodes: entityRows(node, plainNode(['Island'], { islandId: 'I-1' }, '4:fixture:2')) });
    const response = await post(app, { sourceId: 'demo', ref: { entityType: 'island', stableId: 'I-1' } });
    expect(response.statusCode).toBe(200);
    expect(degreePreviewSchema.parse(response.json()).warnings.map((warning) => warning.code)).toEqual(['duplicate-stable-id']);
    await app.close();
  });

  it('answers the preview of a node whose entity type shares its label with another, for either type, counted on the node with the label and the stable ID', async () => {
    for (const entityType of ['twin_a', 'twin_b']) {
      const { app, executor } = await started({ degrees: () => rowOf(3) });
      const response = await post(app, { sourceId: 'demo', ref: { entityType, stableId: 'T-1' } });
      expect(response.statusCode, entityType).toBe(200);
      const preview = degreePreviewSchema.parse(response.json());
      expect(preview.ref).toEqual({ sourceId: 'demo', entityType, stableId: 'T-1' });
      expect(preview.byType.map((entry) => [entry.relationshipType, entry.direction, entry.count.value])).toEqual([['TWINNED', entityType === 'twin_a' ? 'out' : 'in', 3]]);
      expect(preview.warnings.map((warning) => warning.code)).not.toContain('duplicate-stable-id');
      expect(degreeCalls(executor)[0]?.cypher).toContain('MATCH (n:`Twin`) WHERE n.`twinId` IN [$stableId, $stableInteger]');
      await app.close();
    }
  });

  it('warns duplicate-stable-id for a shared label when the source holds nodes of both types with the stable ID', async () => {
    const { app } = await started({ degrees: () => ({ status: 'rows', rows: [{ c0: 3 }, { c0: 9 }] }) });
    const preview = degreePreviewSchema.parse((await post(app, { sourceId: 'demo', ref: { entityType: 'twin_a', stableId: 'T-1' } })).json());
    expect(preview.byType[0]?.count.value).toBe(3);
    expect(preview.warnings.map((warning) => warning.code)).toContain('duplicate-stable-id');
    await app.close();
  });

  it('answers NOT_FOUND for a shared label only when the node is not in the source', async () => {
    const { app } = await started({ degrees: () => ({ status: 'rows', rows: [] }) });
    expect((await post(app, { sourceId: 'demo', ref: { entityType: 'twin_a', stableId: 'T-1' } })).statusCode).toBe(404);
    await app.close();
  });

  it('answers NOT_FOUND for a missing node, with the same body whatever the cause', async () => {
    const missing = await started({ degrees: () => ({ status: 'rows', rows: [] }) });
    const none = await post(missing.app, widget);
    expect(none.statusCode).toBe(404);
    const body = { ...none.json().error, traceId: undefined };
    const empty = await started({ degrees: () => ({ status: 'rows', rows: [] }) });
    const noType = await post(empty.app, { sourceId: 'demo', ref: { entityType: 'nothing', stableId: 'W-1' } });
    const noSource = await post(empty.app, { sourceId: 'nope', ref: { entityType: 'widget', stableId: 'W-1' } });
    for (const response of [noType, noSource]) {
      expect(response.statusCode).toBe(404);
      expect({ ...response.json().error, traceId: undefined }).toEqual(body);
    }
    expect(degreeCalls(empty.executor)).toEqual([]);
    await missing.app.close();
    await empty.app.close();
  });

  it('answers NOT_FOUND for a source the person may not read, reads nothing and audits the denial', async () => {
    const { app, executor, events } = await started({ deny: true });
    const response = await post(app, widget);
    expect(response.statusCode).toBe(404);
    expect(degreeCalls(executor)).toEqual([]);
    expect(events.map((event) => `${event.action} ${event.result}`)).toEqual(['entity.degree_preview denied']);
    await app.close();
  });

  it.each([
    ['a source that is down', { status: 'unavailable', reason: 'unreachable' } as const, 503, 'SOURCE_UNAVAILABLE'],
    ['a read that outlasts the source timeout', { status: 'timeout' } as const, 504, 'QUERY_TIMEOUT'],
  ])('answers %s with a retryable code, no counts and one failed event', async (_name, outcome, status, code) => {
    const { app, events } = await started({ degrees: () => outcome });
    const response = await post(app, widget);
    expect(response.statusCode).toBe(status);
    expect(response.json().error).toMatchObject({ code, retryable: true });
    expect(response.json()).not.toHaveProperty('byType');
    expect(events.filter((event) => event.action === 'entity.degree_preview').map((event) => event.result)).toEqual(['failed']);
    await app.close();
  });

  it('answers SOURCE_UNAVAILABLE with the reason index-building, retryable, without reading the counts, while the index of the stable ID is building', async () => {
    const { app, executor } = await started({ indexes: (online) => online.map((row) => (row.name === 'Widget' ? { ...row, state: 'POPULATING' } : row)) });
    const response = await post(app, widget);
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toMatchObject({ code: 'SOURCE_UNAVAILABLE', retryable: true, details: { reason: 'index-building' } });
    expect(degreeCalls(executor)).toEqual([]);
    await app.close();
  });

  it('answers SOURCE_BUSY when admission refuses the read', async () => {
    const [source] = mapping.sources;
    if (source === undefined) throw new Error('no source');
    const executor = new TestExecutor(withOnlineIndexes(source, () => Promise.resolve(rowOf(1, 1, 1))));
    const defaults = communitySeams();
    const seams = { policy: defaults.policy, audit: defaults.audit, coordinator: { acquireRead: () => Promise.resolve({ status: 'busy' as const }) } };
    const parts = testSourceGate(mapping, { executor, seams });
    const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store: memoryAppStore(), mapping, gate: parts.gate, seams });
    const response = await post(app, widget);
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toMatchObject({ code: 'SOURCE_BUSY', retryable: true });
    expect(executor.calls).toEqual([]);
    await app.close();
  });

  it.each([
    ['a count above the cap plus one', [{ c0: 502, c1: 0, c2: 0 }]],
    ['a row with the wrong number of columns', [{ c0: 1 }]],
  ])('answers INTERNAL_ERROR with no count for %s', async (_name, rows) => {
    const { app } = await started({ degrees: () => ({ status: 'rows', rows }) });
    const response = await post(app, widget);
    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe('INTERNAL_ERROR');
    expect(response.json()).not.toHaveProperty('total');
    await app.close();
  });

  it.each([
    ['an unknown field', { ...widget, cap: 5 }],
    ['an unknown field in the node', { sourceId: 'demo', ref: { entityType: 'widget', stableId: 'W-1', sourceId: 'demo' } }],
    ['an empty source', { ...widget, sourceId: '' }],
    ['an empty stable ID', { sourceId: 'demo', ref: { entityType: 'widget', stableId: '' } }],
    ['a reference longer than the largest token', { sourceId: 'demo', ref: { entityType: 'widget', stableId: 'a'.repeat(266_692) } }],
  ])('answers INVALID_REQUEST for %s and reads nothing', async (_name, body) => {
    const { app, executor } = await started();
    const response = await post(app, body);
    expect(response.statusCode).toBe(400);
    expect(degreeCalls(executor)).toEqual([]);
    await app.close();
  });

  it.each([
    ['no body', {}],
    ['a body that is not JSON', { payload: 'text', headers: { 'content-type': 'application/json' } }],
  ])('answers INVALID_REQUEST or UNSUPPORTED_MEDIA_TYPE for %s and reads nothing', async (_name, request) => {
    const { app, executor } = await started();
    const response = await app.inject({ method: 'POST', url: '/v1/graph/preview-expansion', ...request });
    expect([400, 415]).toContain(response.statusCode);
    expect(degreeCalls(executor)).toEqual([]);
    await app.close();
  });

  it('refuses a query parameter', async () => {
    const { app } = await started();
    const response = await app.inject({ method: 'POST', url: '/v1/graph/preview-expansion?cap=9', payload: widget });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('writes one preview event for a success, with the source and no stable ID or count (the schema read is its own system event)', async () => {
    const { app, events } = await started();
    await post(app, widget);
    const previews = events.filter((event) => event.action === 'entity.degree_preview');
    expect(previews).toHaveLength(1);
    expect(previews[0]).toMatchObject({ result: 'success', sourceId: 'demo' });
    expect(JSON.stringify(events)).not.toContain('W-1');
    await app.close();
  });
});

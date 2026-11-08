import { rmSync } from 'node:fs';
import { expandResponseSchema } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';
import { EXPAND_NEIGHBORS_ID } from '../gate/templates/expand-neighbors.js';
import { createLogger } from '../logger.js';
import { parseMapping } from '../mapping/load.js';
import { communitySeams } from '../seams/community-seams.js';
import type { AuditEvent, Seams } from '../seams/seams.js';
import { memoryAppStore } from '../testing/app-store.js';
import { entityRows } from '../testing/entity-fixtures.js';
import { plainNode, plainRelationship } from '../testing/normalize-fixtures.js';
import { TestExecutor } from '../testing/gate.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { onlineIndexesOf, schemaAnswer, withSchema } from '../testing/search-fixtures.js';
import { testSourceGate } from '../testing/source-gate.js';
import { makeWebRoot } from '../testing/web-root.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

const mapping = parseMapping(
  fileOf(
    baseSource({
      id: 'demo',
      entities: [
        { type: 'hub', label: 'Hub', stable_id: 'hubId' },
        { type: 'leaf', label: 'Leaf', stable_id: 'leafId' },
        { type: 'other', label: 'Other', stable_id: 'otherId' },
      ],
      relationships: [
        { type: 'LINKED', from: 'hub', to: 'leaf', stable_id: 'relId', observed_at: 'seenAt' },
        { type: 'MET', from: 'hub', to: 'other' },
        { type: 'LOOPS', from: 'hub', to: 'hub' },
      ],
    }),
  ),
  'neburyx.yaml',
);

const hub = plainNode(['Hub'], { hubId: 'H-1' }, 'e-hub');
const leaf = (id: string) => plainNode(['Leaf'], { leafId: id }, `e-${id}`);

interface Options {
  readonly answer?: (call: ExecuteCall) => ExecuteOutcome;
  readonly deny?: boolean;
  readonly absent?: boolean;
  readonly schema?: 'building' | 'refused';
}

const storedRows = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ a: hub, m: leaf(`l${index}`), rel: plainRelationship('LINKED', hub, leaf(`l${index}`), { relId: `r${index}` }, `rel-${index}`), phase: 2, ts: null, id: `r${index}`, rtype: 'LINKED', dir: 'out', ntype: null, flag: null, members: null, first: null }));
const otherRows = [{ a: hub, m: plainNode(['Other'], { otherId: 'o1' }, 'e-o1'), rel: null, phase: 3, ts: null, id: 'o1', rtype: 'MET', dir: 'out', ntype: 'other', flag: null, members: 4, first: null }];

function defaultAnswer(call: ExecuteCall): ExecuteOutcome {
  if (call.parameters['neighborType'] === 'other') return { status: 'rows', rows: otherRows };
  return { status: 'rows', rows: storedRows(3) };
}

async function started(options: Options = {}) {
  const [source] = mapping.sources;
  if (source === undefined) throw new Error('the mapping has no source');
  const respond = (call: ExecuteCall): Promise<ExecuteOutcome> => {
    if (call.templateId === 'entity-load') return Promise.resolve(options.absent === true ? { status: 'rows', rows: [] } : entityRows(plainNode(['Hub'], { hubId: 'H-1' })));
    return Promise.resolve((options.answer ?? defaultAnswer)(call));
  };
  const schema = (): ExecuteOutcome =>
    options.schema === 'refused' ? { status: 'unavailable', reason: 'refused' } : schemaAnswer(onlineIndexesOf(source).map((index) => (options.schema === 'building' ? { ...index, state: 'POPULATING' } : index)));
  const executor = new TestExecutor(withSchema(schema, respond));
  const events: AuditEvent[] = [];
  const lease = { held: 0, max: 0, acquired: 0 };
  const defaults = communitySeams();
  const seams: Pick<Seams, 'policy' | 'coordinator' | 'audit'> = {
    policy: options.deny === true ? { authorizeSource: () => Promise.resolve({ allowed: false, reason: 'no' }) } : defaults.policy,
    coordinator: {
      acquireRead: async (request) => {
        const admission = await defaults.coordinator.acquireRead(request);
        if (admission.status !== 'granted') return admission;
        lease.held += 1;
        lease.acquired += 1;
        lease.max = Math.max(lease.max, lease.held);
        return { status: 'granted', lease: { release: async () => { lease.held -= 1; await admission.lease.release(); } } };
      },
    } as Seams['coordinator'],
    audit: { record: (event) => (events.push(event), Promise.resolve()) },
  };
  const parts = testSourceGate(mapping, { executor, seams });
  const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store: memoryAppStore(), mapping, gate: parts.gate, seams });
  return { app, executor, events, lease };
}

type Started = Awaited<ReturnType<typeof started>>;
const post = (app: Started['app'], body: object) => app.inject({ method: 'POST', url: '/v1/graph/expand', payload: body });
const request = (extra: Record<string, unknown> = {}) => ({ sourceId: 'demo', ref: { entityType: 'hub', stableId: 'H-1' }, neighborTypes: ['leaf'], ...extra });
const expandCalls = (executor: TestExecutor) => executor.calls.filter((call) => call.templateId === EXPAND_NEIGHBORS_ID);

describe('POST /v1/graph/expand', () => {
  it('answers one page for each asked type, in the order asked, each with its own cursor, and the page size it used', async () => {
    const { app } = await started({ answer: (call) => (call.parameters['neighborType'] === 'other' ? { status: 'rows', rows: otherRows } : { status: 'rows', rows: storedRows(3) }) });
    const response = await post(app, request({ neighborTypes: ['other', 'leaf'], limit: 2 }));
    expect(response.statusCode).toBe(200);
    const answer = expandResponseSchema.parse(response.json());
    expect(answer.pageSize).toBe(2);
    expect(answer.pages.map((page) => page.neighborType)).toEqual(['other', 'leaf']);
    expect(answer.pages[0]).toMatchObject({ returned: 1, hasMore: false, matchingTotal: { value: 1, quality: 'exact' } });
    expect(answer.pages[0]?.nextCursor).toBeUndefined();
    expect(answer.pages[1]).toMatchObject({ returned: 2, hasMore: true, matchingTotal: { quality: 'unknown' } });
    expect(answer.pages[1]?.nextCursor).toMatch(/^v1\./);
    expect(answer.nodes.map((node) => node.ref.stableId)).toEqual(['H-1', 'o1', 'l0', 'l1']);
    await app.close();
  });

  it('uses the source default page size when the request names none', async () => {
    const { app, executor } = await started();
    const answer = expandResponseSchema.parse((await post(app, request())).json());
    expect(answer.pageSize).toBe(25);
    expect(expandCalls(executor)[0]?.parameters['limit']).toBe(25);
    await app.close();
  });

  it('reads the types one after another under one lease, and writes one audit event for the request', async () => {
    const { app, lease, events } = await started();
    const response = await post(app, request({ neighborTypes: ['leaf', 'other', 'hub'] }));
    expect(response.statusCode).toBe(200);
    expect(lease.max).toBe(1);
    expect(lease.held).toBe(0);
    expect(lease.acquired).toBe(2);
    expect(events.filter((event) => event.action === 'graph.expand')).toEqual([expect.objectContaining({ result: 'success', sourceId: 'demo' })]);
    expect(events.filter((event) => event.action === 'source.schema_indexes')).toHaveLength(1);
    await app.close();
  });

  it('answers the failure and no page when one type fails, and releases the lease', async () => {
    const { app, lease, events } = await started({ answer: (call) => (call.parameters['neighborType'] === 'other' ? { status: 'timeout' } : { status: 'rows', rows: storedRows(2) }) });
    const response = await post(app, request({ neighborTypes: ['leaf', 'other'] }));
    expect(response.statusCode).toBe(504);
    expect(response.json()).toMatchObject({ error: { code: 'QUERY_TIMEOUT', retryable: true, details: { timeoutMs: 5000 } } });
    expect(response.json()).not.toHaveProperty('pages');
    expect(response.body).not.toMatch(/PARTIAL_RESULT|MATCH|bolt:|neighborType/);
    expect(lease.held).toBe(0);
    expect(events.filter((event) => event.action === 'graph.expand')).toEqual([expect.objectContaining({ result: 'failed' })]);
    await app.close();
  });

  it('continues one type with its cursor and starts the others from their first page', async () => {
    const { app, executor } = await started();
    const first = expandResponseSchema.parse((await post(app, request({ neighborTypes: ['leaf', 'other'], limit: 2 }))).json());
    const cursor = first.pages[0]?.nextCursor;
    expect(cursor).toBeDefined();
    executor.calls.length = 0;
    const second = await post(app, request({ neighborTypes: ['other', 'leaf'], limit: 2, cursors: { leaf: cursor } }));
    expect(second.statusCode).toBe(200);
    const calls = expandCalls(executor);
    expect(calls.map((call) => [call.parameters['neighborType'], call.parameters['cursor'] === null])).toEqual([['other', true], ['leaf', false]]);
    await app.close();
  });

  it('refuses, with CURSOR_INVALIDATED and before any read, a cursor that is altered, or for another type', async () => {
    const { app, executor } = await started();
    const first = expandResponseSchema.parse((await post(app, request({ limit: 2 }))).json());
    const cursor = first.pages[0]?.nextCursor ?? '';
    executor.calls.length = 0;
    const altered = await post(app, request({ limit: 2, cursors: { leaf: `${cursor}x` } }));
    expect(altered.statusCode).toBe(409);
    expect(altered.json()).toMatchObject({ error: { code: 'CURSOR_INVALIDATED' } });
    const foreign = await post(app, request({ neighborTypes: ['other'], limit: 2, cursors: { other: cursor } }));
    expect(foreign.statusCode).toBe(409);
    expect(expandCalls(executor)).toEqual([]);
    await app.close();
  });

  it('answers QUERY_BUDGET_EXCEEDED for a page over the maximum and INVALID_REQUEST for a bad size, and reads nothing', async () => {
    const { app, executor } = await started();
    for (const [limit, status, code] of [[51, 422, 'QUERY_BUDGET_EXCEEDED'], [1_000_000, 422, 'QUERY_BUDGET_EXCEEDED'], [0, 400, 'INVALID_REQUEST'], [1.5, 400, 'INVALID_REQUEST']] as const) {
      const response = await post(app, request({ limit }));
      expect([limit, response.statusCode, response.json().error.code]).toEqual([limit, status, code]);
    }
    expect(expandCalls(executor)).toEqual([]);
    await app.close();
  });

  it.each([
    ['an unmapped neighbor type', { neighborTypes: ['nothing'] }],
    ['a neighbor type no mapping row joins in the asked direction', { neighborTypes: ['other'], direction: 'in' }],
    ['a repeated neighbor type', { neighborTypes: ['leaf', 'leaf'] }],
    ['no neighbor type', { neighborTypes: [] }],
    ['a relationship type that joins none of the asked types', { relTypes: ['LOOPS'] }],
    ['a repeated relationship type', { relTypes: ['LINKED', 'LINKED'] }],
    ['a cursor for a type that is not asked', { cursors: { other: 'v1.x.y' } }],
    ['an unmapped node type', { ref: { entityType: 'nothing', stableId: 'x' } }],
    ['an unknown field', { relationship: 'LINKED' }],
  ])('answers INVALID_REQUEST for %s', async (_name, change) => {
    const { app, executor } = await started();
    const response = await post(app, request(change));
    expect(response.statusCode).toBe(400);
    expect(expandCalls(executor)).toEqual([]);
    await app.close();
  });

  it('applies the relationship types of one request to each type they join, and reads only the types they join', async () => {
    const { app, executor } = await started();
    const response = await post(app, request({ neighborTypes: ['leaf', 'other'], relTypes: ['MET'] }));
    expect(response.statusCode).toBe(200);
    const answer = expandResponseSchema.parse(response.json());
    expect(answer.pages.map((page) => [page.neighborType, page.returned])).toEqual([['leaf', 0], ['other', 1]]);
    expect(expandCalls(executor).map((call) => call.parameters['neighborType'])).toEqual(['other']);
    await app.close();
  });

  it('refuses with SOURCE_UNAVAILABLE, audited as refused and before any data read, when the index of the stable ID is not online', async () => {
    const { app, executor, events } = await started({ schema: 'building' });
    const response = await post(app, request({ neighborTypes: ['leaf', 'other'] }));
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: 'SOURCE_UNAVAILABLE' } });
    expect(expandCalls(executor)).toEqual([]);
    expect(events.filter((event) => event.action === 'graph.expand')).toEqual([expect.objectContaining({ result: 'refused' })]);
    await app.close();
  });

  it('runs unguarded for a login that cannot list indexes, and reads the schema once for several types', async () => {
    const refused = await started({ schema: 'refused' });
    expect((await post(refused.app, request({ neighborTypes: ['leaf', 'other'] }))).statusCode).toBe(200);
    expect(refused.executor.calls.filter((call) => call.templateId === 'schema-indexes')).toHaveLength(1);
    expect(expandCalls(refused.executor)).toHaveLength(2);
    await refused.app.close();
    const online = await started();
    await post(online.app, request({ neighborTypes: ['leaf', 'other', 'hub'] }));
    expect(online.executor.calls.filter((call) => call.templateId === 'schema-indexes')).toHaveLength(1);
    await online.app.close();
  });

  it('never shows a page that says there is more, and gives no way to ask for it, as the end', async () => {
    const broken = storedRows(3).map((row, index) => (index === 1 ? { ...row, id: undefined } : row));
    const { app } = await started({ answer: () => ({ status: 'rows', rows: broken }) });
    const response = await post(app, request({ limit: 2 }));
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
    await app.close();
  });

  it('answers NOT_FOUND when the node is absent, and as the entity read does when the person may not read the source', async () => {
    const absent = await started({ absent: true, answer: () => ({ status: 'rows', rows: [] }) });
    const gone = await post(absent.app, request());
    expect(gone.statusCode).toBe(404);
    await absent.app.close();
    const denied = await started({ deny: true });
    const refused = await post(denied.app, request());
    expect(refused.statusCode).toBe(404);
    expect(denied.events).toEqual([expect.objectContaining({ action: 'graph.expand', result: 'denied' })]);
    expect(expandCalls(denied.executor)).toEqual([]);
    await denied.app.close();
  });
});

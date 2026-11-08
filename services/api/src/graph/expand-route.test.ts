import { rmSync } from 'node:fs';
import { expandResponseSchema } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';
import { EXPAND_COUNT_ID } from '../gate/templates/expand-count.js';
import { EXPAND_NEIGHBORS_ID } from '../gate/templates/expand-neighbors.js';
import { createLogger } from '../logger.js';
import { parseMapping } from '../mapping/load.js';
import { communitySeams } from '../seams/community-seams.js';
import type { AuditEvent, ReadAdmission, Seams } from '../seams/seams.js';
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
        { type: 'leaf', label: 'Leaf', stable_id: 'leafId', filterable: ['band', 'secret'], sortable: ['rating', 'secret'], pii: ['secret'] },
        { type: 'other', label: 'Other', stable_id: 'otherId' },
      ],
      relationships: [
        { type: 'LINKED', from: 'hub', to: 'leaf', stable_id: 'relId', observed_at: 'seenAt', filterable: ['score'], sortable: ['points'] },
        { type: 'MET', from: 'hub', to: 'other', filterable: ['weight'] },
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
  /** The coordinator refuses every read after this many have been granted (the index read and the page are two). */
  readonly refuseAfter?: { readonly granted: number; readonly admission: ReadAdmission };
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
        if (options.refuseAfter !== undefined && lease.acquired >= options.refuseAfter.granted) return options.refuseAfter.admission;
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
  describe('with filters', () => {
    const band = (value: string) => ({ on: 'neighbor', property: 'band', op: 'eq', value: { kind: 'text', value } });

    it('reads with the conditions as parameters, never in the statement text, and keeps a filter that leaves nothing honest', async () => {
      const { app, executor } = await started({ answer: () => ({ status: 'rows', rows: [] }) });
      const response = await post(app, request({ filters: [band('PRIVATE-BAND'), { on: 'relationship', property: 'score', op: 'between', from: { kind: 'number', value: 0.8 } }] }));
      expect(response.statusCode).toBe(200);
      expect(expandResponseSchema.parse(response.json()).pages[0]).toMatchObject({ returned: 0, hasMore: false, matchingTotal: { value: 0, quality: 'exact' } });
      const [call] = expandCalls(executor);
      expect(call?.parameters['filters']).toHaveLength(2);
      expect(call?.cypher).not.toContain('PRIVATE-BAND');
      expect(call?.cypher).toContain('m.`band` IS :: STRING NOT NULL');
      expect(call?.cypher).toContain('r.`score` >= $filters[0].from.value');
      await app.close();
    });

    it.each([
      ['a neighbor property that is not declared', [{ ...band('x'), property: 'leafId' }]],
      ['a relationship property that is not declared', [{ on: 'relationship', property: 'nothing', op: 'eq', value: { kind: 'text', value: 'x' } }]],
      ['a relationship property that only one of the rows read declares', [{ on: 'relationship', property: 'score', op: 'eq', value: { kind: 'number', value: 1 } }]],
      ['an operator outside the set', [{ ...band('x'), op: 'contains' }]],
      ['a name with a backtick', [{ ...band('x'), property: 'band` RETURN 1 //' }]],
    ])('answers INVALID_REQUEST and reads nothing for %s', async (_name, filters) => {
      const { app, executor } = await started();
      const response = await post(app, request({ filters, relTypes: filters[0]?.on === 'relationship' ? ['LINKED', 'MET'] : undefined, neighborTypes: ['leaf'] }));
      expect(response.statusCode).toBe(400);
      expect(expandCalls(executor)).toEqual([]);
      await app.close();
    });

    it('refuses the whole request, before any type is read, when one of the asked types does not declare the property', async () => {
      const { app, executor } = await started();
      const response = await post(app, request({ neighborTypes: ['leaf', 'other'], filters: [band('x')] }));
      expect(response.statusCode).toBe(400);
      expect(expandCalls(executor)).toEqual([]);
      await app.close();
    });

    it('keeps a cursor only for the same conditions, in any order, and refuses it for other conditions', async () => {
      const { app } = await started();
      const filters = [band('a'), { on: 'relationship', property: 'score', op: 'eq', value: { kind: 'number', value: 1 } }];
      const first = expandResponseSchema.parse((await post(app, request({ limit: 2, relTypes: ['LINKED'], filters }))).json());
      const cursor = first.pages[0]?.nextCursor ?? '';
      expect(cursor).not.toBe('');
      const same = await post(app, request({ limit: 2, relTypes: ['LINKED'], filters: [...filters].reverse(), cursors: { leaf: cursor } }));
      expect(same.statusCode).toBe(200);
      const other = await post(app, request({ limit: 2, relTypes: ['LINKED'], filters: [band('b')], cursors: { leaf: cursor } }));
      expect(other.statusCode).toBe(409);
      const none = await post(app, request({ limit: 2, relTypes: ['LINKED'], cursors: { leaf: cursor } }));
      expect(none.statusCode).toBe(409);
      await app.close();
    });

    it('refuses a condition on a personal-data property while masking is asked, and allows it when it is not', async () => {
      const { app, executor } = await started();
      const secret = [{ on: 'neighbor', property: 'secret', op: 'eq', value: { kind: 'text', value: 'x' } }];
      const masked = await post(app, request({ filters: secret, mask: true }));
      expect(masked.statusCode).toBe(400);
      expect(expandCalls(executor)).toEqual([]);
      expect((await post(app, request({ filters: secret, mask: false }))).statusCode).toBe(200);
      await app.close();
    });
  });

  describe('with a rank', () => {
    it('reads in the order asked, as parameters of the template and not as text, and an absent rank leaves the order as it was', async () => {
      const { app, executor } = await started();
      expect((await post(app, request({ rank: { on: 'neighbor', property: 'rating', order: 'asc' } }))).statusCode).toBe(200);
      const [call] = expandCalls(executor);
      expect(call?.cypher).toContain('ORDER BY phase, sk, sv ASC');
      expect(call?.parameters['rank']).toEqual({ on: 'neighbor', property: 'rating', order: 'asc' });
      executor.calls.length = 0;
      await post(app, request());
      expect(expandCalls(executor)[0]?.cypher).toContain('ORDER BY phase, tk, ts DESC');
      await app.close();
    });

    it.each([
      ['a neighbor property that is not declared sortable', { on: 'neighbor', property: 'band', order: 'desc' }],
      ['a relationship property that the row does not declare', { on: 'relationship', property: 'nothing', order: 'desc' }],
      ['an order outside the two', { on: 'neighbor', property: 'rating', order: 'sideways' }],
      ['a name with a backtick', { on: 'neighbor', property: 'rating` RETURN 1 //', order: 'asc' }],
    ])('answers INVALID_REQUEST and reads nothing for %s', async (_name, rank) => {
      const { app, executor } = await started();
      const response = await post(app, request({ rank }));
      expect(response.statusCode).toBe(400);
      expect(expandCalls(executor)).toEqual([]);
      await app.close();
    });

    it('refuses the whole request when one asked type does not declare the property, and reads none of them', async () => {
      const { app, executor } = await started();
      const response = await post(app, request({ neighborTypes: ['leaf', 'other'], rank: { on: 'neighbor', property: 'rating', order: 'asc' } }));
      expect(response.statusCode).toBe(400);
      expect(expandCalls(executor)).toEqual([]);
      await app.close();
    });

    it('refuses a rank on a personal-data property while masking is asked, and allows it when not', async () => {
      const { app, executor } = await started();
      const rank = { on: 'neighbor', property: 'secret', order: 'asc' };
      expect((await post(app, request({ rank, mask: true }))).statusCode).toBe(400);
      expect(expandCalls(executor)).toEqual([]);
      expect((await post(app, request({ rank, mask: false }))).statusCode).toBe(200);
      await app.close();
    });

    it('invalidates a cursor when the rank or its order changes, and keeps it for the same rank', async () => {
      const { app } = await started();
      const asc = { on: 'neighbor', property: 'rating', order: 'asc' };
      const first = expandResponseSchema.parse((await post(app, request({ limit: 2, rank: asc }))).json());
      const cursor = first.pages[0]?.nextCursor ?? '';
      expect(cursor).not.toBe('');
      expect((await post(app, request({ limit: 2, rank: asc, cursors: { leaf: cursor } }))).statusCode).toBe(200);
      expect((await post(app, request({ limit: 2, rank: { ...asc, order: 'desc' }, cursors: { leaf: cursor } }))).statusCode).toBe(409);
      expect((await post(app, request({ limit: 2, cursors: { leaf: cursor } }))).statusCode).toBe(409);
      await app.close();
    });
  });

  describe('the count of what a filter matches', () => {
    const band = [{ on: 'neighbor', property: 'band', op: 'eq', value: { kind: 'text', value: 'high' } }];
    const countCalls = (executor: TestExecutor) => executor.calls.filter((call) => call.templateId === EXPAND_COUNT_ID);
    const answering = (count: ExecuteOutcome) => (call: ExecuteCall): ExecuteOutcome => (call.templateId === EXPAND_COUNT_ID ? count : defaultAnswer(call));

    it('is the exact number the count read gives, in the total of the first page, with the same conditions as parameters', async () => {
      const { app, executor } = await started({ answer: answering({ status: 'rows', rows: [{ total: 4210 }] }) });
      const answer = expandResponseSchema.parse((await post(app, request({ limit: 2, filters: band }))).json());
      expect(answer.pages[0]).toMatchObject({ returned: 2, hasMore: true, matchingTotal: { value: 4210, quality: 'exact' } });
      const [call] = countCalls(executor);
      expect(call?.parameters['filters']).toEqual(expandCalls(executor)[0]?.parameters['filters']);
      expect(call?.cypher).toContain('RETURN sum(c) AS total');
      expect(call?.cypher).not.toMatch(/[$]limit|[$]cursor|ORDER BY phase/);
      await app.close();
    });

    it('is not read for a request with no filter, nor for a page that continues a chain', async () => {
      const { app, executor } = await started({ answer: answering({ status: 'rows', rows: [{ total: 7 }] }) });
      await post(app, request({ limit: 2 }));
      expect(countCalls(executor)).toEqual([]);
      const first = expandResponseSchema.parse((await post(app, request({ limit: 2, filters: band }))).json());
      expect(countCalls(executor)).toHaveLength(1);
      const next = expandResponseSchema.parse((await post(app, request({ limit: 2, filters: band, cursors: { leaf: first.pages[0]?.nextCursor } }))).json());
      expect(countCalls(executor)).toHaveLength(1);
      expect(next.pages[0]?.matchingTotal).toMatchObject({ quality: 'unknown' });
      await app.close();
    });

    it('is unknown, with a warning, when the count times out and the page has more; the page is still answered', async () => {
      const { app } = await started({ answer: answering({ status: 'timeout' }) });
      const response = await post(app, request({ limit: 2, filters: band }));
      expect(response.statusCode).toBe(200);
      const answer = expandResponseSchema.parse(response.json());
      expect(answer.pages[0]).toMatchObject({ returned: 2, hasMore: true, matchingTotal: { quality: 'unknown' } });
      expect(answer.pages[0]?.matchingTotal).not.toHaveProperty('value');
      expect(answer.warnings.join(' ')).toContain('could not be counted');
      await app.close();
    });

    it('falls back to the relationships the page itself holds when the first page holds everything, and says so only by being exact', async () => {
      const { app } = await started({ answer: answering({ status: 'unavailable', reason: 'refused' }) });
      const answer = expandResponseSchema.parse((await post(app, request({ neighborTypes: ['other'], relTypes: ['MET'], filters: [{ on: 'relationship', property: 'weight', op: 'eq', value: { kind: 'number', value: 1 } }] }))).json());
      expect(answer.pages[0]).toMatchObject({ returned: 1, hasMore: false, matchingTotal: { quality: 'exact' } });
      expect(answer.warnings.join(' ')).toContain('could not be counted');
      await app.close();
    });

    it.each([
      ['a source that has no free read slot', { status: 'busy' } as ReadAdmission],
      ['a source the breaker has stopped', { status: 'unavailable', reason: 'repeated-timeouts', retryAfterMs: 30_000 } as ReadAdmission],
      ['a source that is out', { status: 'unavailable' } as ReadAdmission],
    ])('is not read, and the page is still answered with its own total and a warning, for %s', async (_name, admission) => {
      const { app, executor } = await started({ refuseAfter: { granted: 2, admission } });
      const response = await post(app, request({ neighborTypes: ['other'], relTypes: ['MET'], filters: [{ on: 'relationship', property: 'weight', op: 'eq', value: { kind: 'number', value: 1 } }] }));
      expect(response.statusCode).toBe(200);
      const answer = expandResponseSchema.parse(response.json());
      expect(answer.pages[0]).toMatchObject({ returned: 1, hasMore: false, matchingTotal: { quality: 'exact' } });
      expect(answer.warnings.join(' ')).toContain('could not be counted');
      expect(countCalls(executor)).toEqual([]);
      await app.close();
    });

    it('is unknown, not the page total, when the source is out and the page has more', async () => {
      const { app } = await started({ refuseAfter: { granted: 2, admission: { status: 'unavailable' } } });
      const answer = expandResponseSchema.parse((await post(app, request({ limit: 2, filters: band }))).json());
      expect(answer.pages[0]?.matchingTotal).toMatchObject({ quality: 'unknown' });
      await app.close();
    });

    it('is unknown when the count read answers something that is not a number', async () => {
      const { app } = await started({ answer: answering({ status: 'rows', rows: [{ total: 'many' }] }) });
      const answer = expandResponseSchema.parse((await post(app, request({ limit: 2, filters: band }))).json());
      expect(answer.pages[0]?.matchingTotal).toMatchObject({ quality: 'unknown' });
      await app.close();
    });

    it('is refused for a personal-data condition while masking is asked, as the page is, before any read', async () => {
      const { app, executor } = await started();
      const response = await post(app, request({ mask: true, filters: [{ on: 'neighbor', property: 'secret', op: 'eq', value: { kind: 'text', value: 'x' } }] }));
      expect(response.statusCode).toBe(400);
      expect(executor.calls.filter((call) => call.templateId === EXPAND_COUNT_ID || call.templateId === EXPAND_NEIGHBORS_ID)).toEqual([]);
      await app.close();
    });
  });
});

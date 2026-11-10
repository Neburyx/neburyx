import { rmSync } from 'node:fs';
import { derivedNeighborsResponseSchema } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';
import { DERIVED_RULE_RUN_ID } from '../gate/templates/derived-rule-run.js';
import { createLogger } from '../logger.js';
import { parseMapping } from '../mapping/load.js';
import { communitySeams } from '../seams/community-seams.js';
import type { AuditEvent, Seams } from '../seams/seams.js';
import { memoryAppStore } from '../testing/app-store.js';
import { redactItems } from '../gate/redact/index.js';
import { account, chain, hidingRedact, device, DERIVED_ENTITIES, DERIVED_RULE, DERIVED_STORED, pathOf, uses } from '../testing/derived-fixtures.js';
import { entityRows } from '../testing/entity-fixtures.js';
import { TestExecutor } from '../testing/gate.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { plainNode } from '../testing/normalize-fixtures.js';
import { onlineIndexesOf, schemaAnswer, withSchema } from '../testing/search-fixtures.js';
import { testSourceGate } from '../testing/source-gate.js';
import { makeWebRoot } from '../testing/web-root.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

const mappingOf = (entities: readonly Record<string, unknown>[] = DERIVED_ENTITIES, budgets?: Record<string, number>) => parseMapping(fileOf(baseSource({ id: 'demo', entities, relationships: DERIVED_STORED, derived: [DERIVED_RULE], ...(budgets === undefined ? {} : { budgets }) })), 'neburyx.yaml');

interface Options {
  readonly rows?: readonly Record<string, unknown>[];
  readonly outcome?: ExecuteOutcome;
  readonly found?: boolean;
  readonly deny?: boolean;
  readonly busy?: boolean;
  readonly mapping?: ReturnType<typeof mappingOf>;
  readonly hideStableId?: string;
}

async function started(options: Options = {}) {
  const mapping = options.mapping ?? mappingOf();
  const [source] = mapping.sources;
  if (source === undefined) throw new Error('the mapping has no source');
  const answer = (call: ExecuteCall): Promise<ExecuteOutcome> => {
    if (call.templateId === 'entity-load') return Promise.resolve(options.found === false ? { status: 'rows', rows: [] } : entityRows(plainNode(['Maker'], { makerId: 'A-1' })));
    return Promise.resolve(options.outcome ?? { status: 'rows', rows: options.rows ?? [] });
  };
  const executor = new TestExecutor(withSchema(() => schemaAnswer(onlineIndexesOf(source)), answer));
  const events: AuditEvent[] = [];
  const defaults = communitySeams();
  const seams: Pick<Seams, 'policy' | 'coordinator' | 'audit'> = {
    policy: options.deny === true ? { authorizeSource: () => Promise.resolve({ allowed: false, reason: 'no' }) } : defaults.policy,
    coordinator: options.busy === true ? { acquireRead: () => Promise.resolve({ status: 'busy' as const }) } : defaults.coordinator,
    audit: { record: (event) => (events.push(event), Promise.resolve()) },
  };
  const parts = testSourceGate(mapping, { executor, seams, ...(options.hideStableId === undefined ? {} : { redact: hidingRedact(options.hideStableId, redactItems) }) });
  const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store: memoryAppStore(), mapping, gate: parts.gate, seams });
  return { app, executor, events };
}

type Started = Awaited<ReturnType<typeof started>>;
const post = (app: Started['app'], body: object, url = '/v1/graph/derived-neighbors') => app.inject({ method: 'POST', url, payload: body });
const anAccount = { sourceId: 'demo', ref: { entityType: 'maker', stableId: 'A-1' } };
const runs = (executor: TestExecutor) => executor.calls.filter((call) => call.templateId === DERIVED_RULE_RUN_ID);
const others = (count: number) => Array.from({ length: count }, (_unused, index) => chain('A-1', `O-${index + 1}`, `D-${index + 1}`));

describe('POST /v1/graph/derived-neighbors', () => {
  it('answers one result for the rule with an exact count, the other ends, the middle entities and the supports, under the cap', async () => {
    const { app, executor } = await started({ rows: others(2) });
    const response = await post(app, anAccount);
    expect(response.statusCode).toBe(200);
    const body = derivedNeighborsResponseSchema.parse(response.json());
    expect(body.results).toHaveLength(1);
    const [result] = body.results;
    expect(result).toMatchObject({ ruleId: 'shared-tool', ruleVersion: 2, count: { value: 2, quality: 'exact' } });
    expect(result?.edges.filter((edge) => edge.semantics === 'derived')).toHaveLength(2);
    expect(result?.edges.filter((edge) => edge.semantics === 'stored')).toHaveLength(4);
    expect(result?.nodes.map((node) => node.ref.stableId).sort()).toEqual(['A-1', 'D-1', 'D-2', 'O-1', 'O-2']);
    expect(runs(executor)).toHaveLength(1);
    expect(runs(executor)[0]?.parameters).toMatchObject({ limit: 25 });
    await app.close();
  });

  it('counts exactly 25 other ends as exact, because the read found no 26th', async () => {
    const { app } = await started({ rows: others(25) });
    const body = derivedNeighborsResponseSchema.parse((await post(app, anAccount)).json());
    expect(body.results[0]?.count).toMatchObject({ value: 25, quality: 'exact' });
    await app.close();
  });

  it('counts a run that found a 26th other end as a lower bound of 25 and returns 25', async () => {
    const { app } = await started({ rows: others(26) });
    const body = derivedNeighborsResponseSchema.parse((await post(app, anAccount)).json());
    expect(body.results[0]?.count).toMatchObject({ value: 25, quality: 'lowerBound' });
    expect(body.results[0]?.edges.filter((edge) => edge.semantics === 'derived')).toHaveLength(25);
    await app.close();
  });

  it('is bounded by a max_page the source lowered: 10 gives an exact 10 for ten other ends and a lower bound of 10 for eleven, and asks the gate for 10', async () => {
    const lowered = mappingOf(DERIVED_ENTITIES, { max_page: 10 });
    const ten = await started({ rows: others(10), mapping: lowered });
    expect(derivedNeighborsResponseSchema.parse((await post(ten.app, anAccount)).json()).results[0]?.count).toMatchObject({ value: 10, quality: 'exact' });
    expect(runs(ten.executor)[0]?.parameters).toMatchObject({ limit: 10 });
    const eleven = await started({ rows: others(11), mapping: lowered });
    const body = derivedNeighborsResponseSchema.parse((await post(eleven.app, anAccount)).json());
    expect(body.results[0]?.count).toMatchObject({ value: 10, quality: 'lowerBound' });
    expect(body.results[0]?.edges.filter((edge) => edge.semantics === 'derived')).toHaveLength(10);
    await ten.app.close();
    await eleven.app.close();
  });

  it('is not raised by the largest max_page: 50 still caps at 25', async () => {
    const { app, executor } = await started({ rows: others(26), mapping: mappingOf(DERIVED_ENTITIES, { max_page: 50 }) });
    const body = derivedNeighborsResponseSchema.parse((await post(app, anAccount)).json());
    expect(body.results[0]?.count).toMatchObject({ value: 25, quality: 'lowerBound' });
    expect(runs(executor)[0]?.parameters).toMatchObject({ limit: 25 });
    await app.close();
  });

  it('neither counts nor returns a derived edge whose end the mapping does not describe, nor the middle entity only that edge used', async () => {
    const a = account('A-1');
    const d = device('D-HIDDEN');
    const stranger = plainNode(['Stranger'], { id: 'X-1' });
    const hidden = pathOf(a, [
      { relationship: uses(a, d, 'E-1'), end: d },
      { relationship: uses(stranger, d, 'E-2'), end: stranger as never },
    ]);
    const { app } = await started({ rows: [chain('A-1', 'O-1'), hidden] });
    const body = derivedNeighborsResponseSchema.parse((await post(app, anAccount)).json());
    const [result] = body.results;
    expect(result?.count).toMatchObject({ value: 1, quality: 'exact' });
    expect(result?.nodes.map((node) => node.ref.stableId)).not.toContain('D-HIDDEN');
    expect(result?.edges.filter((edge) => edge.semantics === 'derived')).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain('D-HIDDEN');
    await app.close();
  });

  it('neither counts nor returns a derived edge whose end the person cannot see, nor its other end, middle entity or supporting edges, and says nothing of it: no warning, no count of what was left out', async () => {
    const { app } = await started({ rows: [chain('A-1', 'O-1', 'D-1'), chain('A-1', 'O-2', 'D-2')], hideStableId: 'O-1' });
    const response = await post(app, anAccount);
    expect(response.statusCode, response.body).toBe(200);
    const body = derivedNeighborsResponseSchema.parse(response.json());
    const [result] = body.results;
    expect(result?.count).toMatchObject({ value: 1, quality: 'exact' });
    expect(result?.nodes.map((node) => node.ref.stableId).sort()).toEqual(['A-1', 'D-2', 'O-2']);
    expect(result?.edges).toHaveLength(3);
    expect(response.body).not.toMatch(/O-1|D-1/);
    expect(result?.warnings, 'nothing says that a derived relationship was left out').toEqual([]);
    await app.close();
  });

  it('is a lower bound of the number that remained when the run stopped at the cap and an edge was dropped after it, never exact', async () => {
    const a = account('A-1');
    const d = device('D-HIDDEN');
    const stranger = plainNode(['Stranger'], { id: 'X-1' });
    const hidden = pathOf(a, [
      { relationship: uses(a, d, 'E-1'), end: d },
      { relationship: uses(stranger, d, 'E-2'), end: stranger as never },
    ]);
    const { app } = await started({ rows: [hidden, ...others(25)] });
    const body = derivedNeighborsResponseSchema.parse((await post(app, anAccount)).json());
    expect(body.results[0]?.count).toMatchObject({ value: 24, quality: 'lowerBound' });
    await app.close();
  });

  it('answers an exact zero for an entity the rule finds nothing from, after confirming the entity exists', async () => {
    const { app } = await started({ rows: [] });
    const body = derivedNeighborsResponseSchema.parse((await post(app, anAccount)).json());
    expect(body.results).toEqual([expect.objectContaining({ ruleId: 'shared-tool', count: { value: 0, quality: 'exact', scope: 'derived:neighbors' }, nodes: [], edges: [] })]);
    await app.close();
  });

  it('answers NOT_FOUND for an entity that does not exist when the rule finds nothing', async () => {
    const { app } = await started({ rows: [], found: false });
    const response = await post(app, anAccount);
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it('answers an empty list of results, and reads nothing, for an entity type with no rule', async () => {
    const { app, executor } = await started();
    const response = await post(app, { sourceId: 'demo', ref: { entityType: 'tool', stableId: 'D-1' } });
    expect(response.statusCode).toBe(200);
    expect(response.json().results).toEqual([]);
    expect(executor.calls.filter((call) => call.templateId !== 'schema-indexes')).toEqual([]);
    await app.close();
  });

  it('masks the personal properties of the nodes when masking is asked', async () => {
    const entities = [{ ...DERIVED_ENTITIES[0], pii: [{ property: 'makerNote', class: 'text' }] }, DERIVED_ENTITIES[1]];
    const rows = [chain('A-1', 'O-1', 'D-1', { makerNote: 'NOTE-SECRET' })];
    const { app } = await started({ rows, mapping: mappingOf(entities) });
    const masked = await post(app, { ...anAccount, mask: true });
    expect(masked.statusCode).toBe(200);
    expect(masked.body).not.toContain('NOTE-SECRET');
    expect(JSON.stringify(masked.json())).toContain('"masked":true');
    const plain = await post(app, anAccount);
    expect(plain.body).toContain('NOTE-SECRET');
    await app.close();
  });

  it('answers INVALID_REQUEST, reading nothing, when masking is asked and the stop list of the rule is personal data', async () => {
    const entities = [DERIVED_ENTITIES[0], { ...DERIVED_ENTITIES[1], pii: [{ property: 'isCommon', class: 'text' }] }];
    const { app, executor } = await started({ rows: others(1), mapping: mappingOf(entities) });
    const response = await post(app, { ...anAccount, mask: true });
    expect(response.statusCode).toBe(400);
    expect(runs(executor)).toEqual([]);
    await app.close();
  });
});

describe('the failure paths of POST /v1/graph/derived-neighbors', () => {
  it.each([
    ['an unknown field', { ...anAccount, extra: 1 }],
    ['a rule named by the request', { ...anAccount, ruleId: 'shared-tool' }],
    ['a bad reference', { sourceId: 'demo', ref: { entityType: 'maker' } }],
    ['no body', {}],
  ])('answers INVALID_REQUEST for %s and reads nothing', async (_name, body) => {
    const { app, executor } = await started({ rows: others(1) });
    const response = await post(app, body);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_REQUEST');
    expect(runs(executor)).toEqual([]);
    await app.close();
  });

  it('answers INVALID_REQUEST for a query parameter', async () => {
    const { app } = await started();
    const response = await post(app, anAccount, '/v1/graph/derived-neighbors?limit=1');
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('answers NOT_FOUND, with one body, for an unknown source, an unknown entity type and a source the person may not read, and audits the denial', async () => {
    const open = await started();
    const noSource = await post(open.app, { sourceId: 'nope', ref: anAccount.ref });
    const noType = await post(open.app, { sourceId: 'demo', ref: { entityType: 'nothing', stableId: 'A-1' } });
    const denied = await started({ deny: true });
    const noAccess = await post(denied.app, anAccount);
    for (const response of [noSource, noType, noAccess]) {
      expect(response.statusCode).toBe(404);
      expect({ ...response.json().error, traceId: undefined }).toEqual({ ...noSource.json().error, traceId: undefined });
    }
    expect(runs(denied.executor)).toEqual([]);
    expect(denied.events.map((event) => `${event.action} ${event.result}`)).toEqual(['entity.derived_rule_run denied']);
    await open.app.close();
    await denied.app.close();
  });

  it.each([
    ['a source that is down', { status: 'unavailable', reason: 'unreachable' } as const, 503, 'SOURCE_UNAVAILABLE'],
    ['a read that outlasts the source timeout', { status: 'timeout' } as const, 504, 'QUERY_TIMEOUT'],
  ])('answers %s with a retryable code, no results and one failed event', async (_name, outcome, status, code) => {
    const { app, events } = await started({ outcome });
    const response = await post(app, anAccount);
    expect(response.statusCode).toBe(status);
    expect(response.json().error).toMatchObject({ code, retryable: true });
    expect(response.json()).not.toHaveProperty('results');
    expect(response.body).not.toMatch(/MATCH|bolt:/);
    expect(events.filter((event) => event.action === 'entity.derived_rule_run').map((event) => event.result)).toEqual(['failed']);
    await app.close();
  });

  it('answers SOURCE_BUSY when admission refuses the read', async () => {
    const { app, executor } = await started({ busy: true });
    const response = await post(app, anAccount);
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('SOURCE_BUSY');
    expect(runs(executor)).toEqual([]);
    await app.close();
  });

  it('writes one event for a success, with the source and no stable ID, property value or count', async () => {
    const { app, events } = await started({ rows: others(2) });
    await post(app, anAccount);
    const written = events.filter((event) => event.action === 'entity.derived_rule_run');
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ sourceId: 'demo', result: 'success' });
    expect(JSON.stringify(written[0])).not.toMatch(/A-1|O-1|shared-tool/);
    await app.close();
  });
});

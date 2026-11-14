import { rmSync } from 'node:fs';
import { pathsOkSchema, pathsResponseSchema } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildApp } from '../app.js';
import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';
import { SHORTEST_PATHS_ID } from '../gate/templates/shortest-paths.js';
import { SHORTEST_PATHS_COUNT_ID } from '../gate/templates/shortest-paths-count.js';
import { createLogger } from '../logger.js';
import { communitySeams } from '../seams/community-seams.js';
import type { AuditEvent, Seams } from '../seams/seams.js';
import { memoryAppStore } from '../testing/app-store.js';
import { LINKED_RELATIONSHIPS, linkedMappingOf } from '../testing/linked-entities-fixtures.js';
import { makerNodes, PATHS_ENTITIES } from '../testing/paths-fixtures.js';
import { TestExecutor } from '../testing/gate.js';
import { onlineIndexesOf, schemaAnswer, withSchema } from '../testing/search-fixtures.js';
import { testSourceGate } from '../testing/source-gate.js';
import { makeWebRoot } from '../testing/web-root.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

interface Options {
  readonly rows?: readonly Record<string, unknown>[];
  readonly deny?: boolean;
  readonly evidence?: boolean;
  /** The path read times out: with the rows it streamed, or with none. */
  readonly timeout?: 'with-rows' | 'no-rows';
  readonly budgets?: Record<string, number>;
  /** What the probe reads: the relationships at the first and at the second end, or its whole row. */
  readonly probe?: { readonly fromDegree: number; readonly toDegree: number } | Record<string, unknown> | 'timeout';
}

async function started(options: Options = {}) {
  const mapping = linkedMappingOf({ entities: PATHS_ENTITIES, ...(options.budgets === undefined ? {} : { budgets: options.budgets }), ...(options.evidence === true ? { relationships: LINKED_RELATIONSHIPS.map((relationship) => (relationship.type === 'LINKS' ? { ...relationship, evidence: ['recordId'] } : relationship)) } : {}) });
  const [source] = mapping.sources;
  if (source === undefined) throw new Error('the mapping has no source');
  const probeRow = options.probe === undefined ? { toFound: true, fromDegree: 1, toDegree: 1 } : options.probe;
  const answer = (call: ExecuteCall): Promise<ExecuteOutcome> => {
    if (call.templateId === SHORTEST_PATHS_ID && options.timeout !== undefined) return Promise.resolve(options.timeout === 'with-rows' ? { status: 'timeout', rows: options.rows ?? [] } : { status: 'timeout' });
    if (call.templateId !== SHORTEST_PATHS_COUNT_ID) return Promise.resolve({ status: 'rows', rows: options.rows ?? [] });
    if (probeRow === 'timeout') return Promise.resolve({ status: 'timeout', rows: [{ toFound: true, fromDegree: 1, toDegree: 1 }] });
    return Promise.resolve({ status: 'rows', rows: 'fromDegree' in probeRow && !('toFound' in probeRow) ? [{ toFound: true, ...probeRow }] : [probeRow] });
  };
  const executor = new TestExecutor(withSchema(() => schemaAnswer(onlineIndexesOf(source)), answer));
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
const ask = (params: Record<string, unknown> = {}) => ({ sourceId: 'demo', from: { entityType: 'maker', stableId: 'A-1' }, to: { entityType: 'maker', stableId: 'Z-1' }, relTypes: ['LINKS'], maxHops: 3, limit: 5, ...params });
const post = (app: Started['app'], body: object) => app.inject({ method: 'POST', url: '/v1/graph/paths', payload: body });
const reads = (executor: TestExecutor) => executor.calls.filter((call) => call.templateId === SHORTEST_PATHS_ID);
const probes = (executor: TestExecutor) => executor.calls.filter((call) => call.templateId === SHORTEST_PATHS_COUNT_ID);
const ref = (stableId: string) => ({ sourceId: 'demo', entityType: 'maker', stableId });

describe('POST /v1/graph/paths', () => {
  it('answers the shortest paths between two entities, each step with its ends, type and evidence, and the nodes and relationships the steps name', async () => {
    const { rows } = makerNodes();
    const { app, executor } = await started({ rows: rows('A-1', 'Z-1', [['A-1', 'M-2', 'Z-1'], ['A-1', 'M-1', 'Z-1']]) });
    const response = await post(app, ask());
    expect(response.statusCode).toBe(200);
    const body = pathsOkSchema.parse(response.json());
    expect(body).toMatchObject({ status: 'ok', capReached: false, partial: false, warnings: [] });
    expect(body.paths.map((path) => path.hops)).toEqual([2, 2]);
    expect(body.paths.map((path) => path.steps.map((step) => step.to.stableId))).toEqual([['M-1', 'Z-1'], ['M-2', 'Z-1']]);
    expect(body.paths[0]?.steps[0]).toEqual({ from: ref('A-1'), to: ref('M-1'), relationshipType: 'LINKS', evidenceRefs: [] });
    expect(body.nodes.map((node) => node.ref.stableId).sort()).toEqual(['A-1', 'M-1', 'M-2', 'Z-1']);
    expect(body.edges).toHaveLength(4);
    expect(reads(executor)).toHaveLength(1);
    await app.close();
  });

  it('gives each step the evidence references of its relationship', async () => {
    const { rows } = makerNodes();
    const { app } = await started({ evidence: true, rows: rows('A-1', 'Z-1', [['A-1', 'M-1', 'Z-1']], { recordId: 'REC-7' }) });
    const body = pathsOkSchema.parse((await post(app, ask())).json());
    expect(body.paths[0]?.steps.map((step) => step.evidenceRefs)).toEqual([['REC-7'], ['REC-7']]);
    await app.close();
  });

  it('writes the statement from the mapping with the entity values as parameters only, and reads in a read transaction', async () => {
    const { rows } = makerNodes();
    const { app, executor } = await started({ rows: rows('A-1', 'Z-1', []) });
    await post(app, ask());
    const [call] = reads(executor);
    expect(call?.cypher).toContain('allShortestPaths((a)-[:`LINKS`*1..3]-(b))');
    expect(call?.cypher).not.toContain('A-1');
    expect(call?.cypher).not.toContain('Z-1');
    expect(call).toMatchObject({ accessMode: 'READ', parameters: { ends: [{ entityType: 'maker', stableId: 'A-1' }, { entityType: 'maker', stableId: 'Z-1' }], limit: 5 } });
    await app.close();
  });

  it('reads in the direction asked and refuses one that is not out, in or both before any read', async () => {
    const { rows } = makerNodes();
    const { app, executor } = await started({ rows: rows('A-1', 'Z-1', []) });
    for (const [direction, text] of [['out', '(a)-[:`LINKS`*1..3]->(b)'], ['in', '(a)<-[:`LINKS`*1..3]-(b)'], ['both', '(a)-[:`LINKS`*1..3]-(b)']] as const) {
      await post(app, ask({ direction }));
      expect(reads(executor).at(-1)?.cypher).toContain(text);
    }
    const before = reads(executor).length;
    expect((await post(app, ask({ direction: 'sideways' }))).statusCode).toBe(400);
    expect(reads(executor)).toHaveLength(before);
    await app.close();
  });

  it('names the ends of a step in the order the path is walked, and the stored direction in the edge, for a path walked against the stored relationships', async () => {
    const { maker, path } = makerNodes();
    const { app } = await started({ rows: [{ a: maker('A-1'), b: maker('Z-1'), p: path(['A-1', 'Z-1'], 'LINKS', {}, 'reverse') }] });
    const body = pathsOkSchema.parse((await post(app, ask({ direction: 'in' }))).json());
    expect(body.paths[0]?.steps[0]).toMatchObject({ from: ref('A-1'), to: ref('Z-1') });
    expect(body.edges[0]).toMatchObject({ from: ref('Z-1'), to: ref('A-1') });
    await app.close();
  });

  it('answers no paths, not cut and not partial, for two entities that are not connected within the bounds', async () => {
    const { rows } = makerNodes();
    const { app } = await started({ rows: rows('A-1', 'Z-1', []) });
    const body = pathsOkSchema.parse((await post(app, ask())).json());
    expect(body).toMatchObject({ paths: [], nodes: [], edges: [], capReached: false, partial: false });
    await app.close();
  });

  it('answers the limit and says the cap was reached when more paths exist, naming nothing of the one that was cut', async () => {
    const { rows } = makerNodes();
    const { app } = await started({ rows: rows('A-1', 'Z-1', [['A-1', 'M-1', 'Z-1'], ['A-1', 'M-2', 'Z-1']]) });
    const body = pathsOkSchema.parse((await post(app, ask({ limit: 1 }))).json());
    expect(body.paths).toHaveLength(1);
    expect(body.capReached).toBe(true);
    expect(body.nodes.map((node) => node.ref.stableId).sort()).toEqual(['A-1', 'M-1', 'Z-1']);
    expect(body.edges).toHaveLength(2);
    await app.close();
  });

  it('leaves out a path that crosses a relationship the mapping does not describe and says so by reason', async () => {
    const { rows, path } = makerNodes();
    const described = rows('A-1', 'Z-1', [['A-1', 'M-1', 'Z-1']]);
    const { app } = await started({ rows: [...described, { ...described[0], p: path(['A-1', 'M-2', 'Z-1'], 'UNMAPPED') }] });
    const body = pathsOkSchema.parse((await post(app, ask())).json());
    expect(body.paths).toHaveLength(1);
    expect(body.warnings.length).toBeGreaterThan(0);
    await app.close();
  });

  it('answers NOT_FOUND when an end is not in the source, with no entity value in the message', async () => {
    const { rows } = makerNodes();
    const first = await started({ rows: [] });
    const noStart = await post(first.app, ask());
    expect(noStart.statusCode).toBe(404);
    expect(noStart.body).not.toContain('A-1');
    await first.app.close();
    const second = await started({ rows: rows('A-1', 'Z-1', []).map((entry) => ({ ...entry, b: null })) });
    expect((await post(second.app, ask())).statusCode).toBe(404);
    await second.app.close();
  });

  it('masks the pii properties of the nodes when the request asks', async () => {
    const { rows } = makerNodes();
    const plain = await started({ rows: rows('A-1', 'Z-1', [['A-1', 'Z-1']]) });
    expect((await post(plain.app, ask())).body).toContain('Owner of A-1');
    await plain.app.close();
    const masked = await started({ rows: rows('A-1', 'Z-1', [['A-1', 'Z-1']]) });
    const response = await post(masked.app, ask({ mask: true }));
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('Owner of A-1');
    await masked.app.close();
  });

  it('audits each gate read once with the template action, holding no entity value, and audits a denial', async () => {
    const { rows } = makerNodes();
    const ok = await started({ rows: rows('A-1', 'Z-1', [['A-1', 'Z-1']]) });
    await post(ok.app, ask());
    expect(ok.events.filter((event) => event.action === 'graph.shortest_paths_run')).toMatchObject([{ result: 'success' }]);
    expect(JSON.stringify(ok.events)).not.toContain('A-1');
    await ok.app.close();
    const denied = await started({ deny: true });
    expect((await post(denied.app, ask())).statusCode).toBe(404);
    expect(denied.events.filter((event) => event.action === 'graph.shortest_paths_run')).toMatchObject([{ result: 'denied' }]);
    await denied.app.close();
  });
});

const refusals = (events: readonly AuditEvent[]) => events.filter((event) => event.action === 'graph.shortest_paths_run').map((event) => event.result);
const errorBodySchema = z.object({ error: z.object({ code: z.string(), details: z.record(z.string(), z.unknown()).optional() }) });
const errorOf = (response: { json(): unknown }) => errorBodySchema.parse(response.json()).error;

describe('POST /v1/graph/paths refuses before any read', () => {
  it('refuses more hops than the source allows, up to and above the product ceiling, with the cap', async () => {
    const { app, executor, events } = await started({ rows: [] });
    for (const maxHops of [5, 9]) {
      const response = await post(app, ask({ maxHops }));
      expect(response.statusCode).toBe(422);
      expect(errorOf(response)).toMatchObject({ code: 'QUERY_BUDGET_EXCEEDED', details: { maxHops: 4 } });
    }
    expect(reads(executor)).toHaveLength(0);
    expect(refusals(events)).toEqual(['refused', 'refused']);
    await app.close();
  });

  it('refuses a limit above path_results_cap with that cap, and above a lower max_page with max_page', async () => {
    const { app, executor } = await started({ rows: [] });
    const above = await post(app, ask({ limit: 26 }));
    expect(above.statusCode).toBe(422);
    expect(errorOf(above)).toMatchObject({ code: 'QUERY_BUDGET_EXCEEDED', details: { pathResultsCap: 25 } });
    expect(reads(executor)).toHaveLength(0);
    await app.close();
    const tight = await started({ rows: [], budgets: { max_page: 10, default_page: 10 } });
    const low = await post(tight.app, ask({ limit: 11 }));
    expect(errorOf(low)).toMatchObject({ code: 'QUERY_BUDGET_EXCEEDED', details: { maxPage: 10 } });
    expect(reads(tight.executor)).toHaveLength(0);
    await tight.app.close();
  });

  it('refuses a body the contract does not allow: no relationship type, an end missing, a count below one, a repeat, an unknown field', async () => {
    const { app, executor } = await started({ rows: [] });
    const bodies = [ask({ relTypes: [] }), ask({ from: undefined }), ask({ to: undefined }), ask({ maxHops: 0 }), ask({ limit: 0 }), ask({ extra: true }), ask({ relTypes: ['LINKS', 'LINKS'] }), ask({ relTypes: ['NOPE'] }), ask({ from: { entityType: 'nope', stableId: 'A-1' } })];
    for (const body of bodies) {
      const response = await post(app, body);
      expect({ status: response.statusCode, code: errorOf(response).code }).toEqual({ status: 400, code: 'INVALID_REQUEST' });
    }
    expect(reads(executor)).toHaveLength(0);
    await app.close();
  });

  it('refuses two ends that are one entity, and answers NOT_FOUND for an end that is not in the source', async () => {
    const { app, executor } = await started({ rows: [] });
    expect((await post(app, ask({ to: { entityType: 'maker', stableId: 'A-1' } }))).statusCode).toBe(400);
    expect(reads(executor)).toHaveLength(0);
    const missing = await post(app, ask());
    expect({ status: missing.statusCode, code: errorOf(missing).code }).toEqual({ status: 404, code: 'NOT_FOUND' });
    await app.close();
  });

  it('answers NOT_FOUND for a source the person may not read and for a source that is not configured', async () => {
    const denied = await started({ deny: true });
    expect((await post(denied.app, ask())).statusCode).toBe(404);
    expect(reads(denied.executor)).toHaveLength(0);
    await denied.app.close();
    const unknown = await started({ rows: [] });
    expect((await post(unknown.app, ask({ sourceId: 'nope' }))).statusCode).toBe(404);
    await unknown.app.close();
  });
});

describe('POST /v1/graph/paths estimates before it searches', () => {
  it('runs the probe first, in the same call, and labels the estimate exact when the ends are under the threshold', async () => {
    const { rows } = makerNodes();
    const { app, executor } = await started({ rows: rows('A-1', 'Z-1', [['A-1', 'Z-1']]), probe: { fromDegree: 3, toDegree: 4 } });
    const body = pathsOkSchema.parse((await post(app, ask())).json());
    expect(body).toMatchObject({ status: 'ok', estimate: { value: 7, quality: 'exact' } });
    expect(probes(executor)).toHaveLength(1);
    expect(reads(executor)).toHaveLength(1);
    expect(probes(executor)[0]?.cypher).toContain('LIMIT $countCap + 1');
    expect(probes(executor)[0]?.parameters).toMatchObject({ countCap: 500 });
    await app.close();
  });

  it('stops as heavy with a lower bound at the threshold, the threshold and the continue limit, and runs no search', async () => {
    const { app, executor } = await started({ probe: { fromDegree: 300, toDegree: 300 } });
    const response = await post(app, ask({ limit: 25 }));
    expect(response.statusCode).toBe(200);
    expect(pathsResponseSchema.parse(response.json())).toEqual({ status: 'heavy', estimate: { value: 500, quality: 'lowerBound', scope: 'paths:estimate' }, threshold: 500, continueLimit: 25, warnings: [] });
    expect(reads(executor)).toHaveLength(0);
    await app.close();
  });

  it('lowers the continue limit to the limit asked, and to the source cap', async () => {
    const { app } = await started({ probe: { fromDegree: 600, toDegree: 0 } });
    expect(pathsResponseSchema.parse((await post(app, ask({ limit: 5 }))).json())).toMatchObject({ status: 'heavy', continueLimit: 5 });
    await app.close();
  });

  it('skips the probe on a continue, runs at most 25 paths and carries no estimate', async () => {
    const { rows } = makerNodes();
    const { app, executor } = await started({ rows: rows('A-1', 'Z-1', [['A-1', 'Z-1']]), probe: { fromDegree: 900, toDegree: 900 } });
    const body = pathsOkSchema.parse((await post(app, ask({ continue: true, limit: 25 }))).json());
    expect(body).toMatchObject({ status: 'ok' });
    expect('estimate' in body).toBe(false);
    expect(probes(executor)).toHaveLength(0);
    expect(reads(executor)[0]?.parameters).toMatchObject({ limit: 25 });
    await app.close();
  });

  it('answers QUERY_TIMEOUT and runs no search when the probe times out', async () => {
    const { app, executor } = await started({ probe: 'timeout' });
    const response = await post(app, ask());
    expect({ status: response.statusCode, code: errorOf(response).code }).toEqual({ status: 504, code: 'QUERY_TIMEOUT' });
    expect(reads(executor)).toHaveLength(0);
    await app.close();
  });

  it('answers NOT_FOUND when the probe finds no second end, with or without a continue, and reads no probe for a request beyond the bounds', async () => {
    const lonely = await started({ probe: { toFound: false, fromDegree: 0, toDegree: 0 } });
    expect((await post(lonely.app, ask())).statusCode).toBe(404);
    expect(reads(lonely.executor)).toHaveLength(0);
    await lonely.app.close();
    const none = await started({ rows: [] });
    expect((await post(none.app, ask({ continue: true }))).statusCode).toBe(404);
    expect(probes(none.executor)).toHaveLength(0);
    expect((await post(none.app, ask({ maxHops: 9 }))).statusCode).toBe(422);
    expect(probes(none.executor)).toHaveLength(0);
    await none.app.close();
  });

  it('audits the probe with its own action and the search with the template action, once each', async () => {
    const { rows } = makerNodes();
    const { app, events } = await started({ rows: rows('A-1', 'Z-1', [['A-1', 'Z-1']]) });
    await post(app, ask());
    expect(events.filter((event) => event.action === 'graph.shortest_paths_count').map((event) => event.result)).toEqual(['success']);
    expect(events.filter((event) => event.action === 'graph.shortest_paths_run').map((event) => event.result)).toEqual(['success']);
    await app.close();
  });
});

describe('POST /v1/graph/paths when the read times out', () => {
  it('answers the paths read, labelled partial with the counts kept and asked for, and never says the cap was reached', async () => {
    const { rows } = makerNodes();
    const { app, events } = await started({ timeout: 'with-rows', rows: rows('A-1', 'Z-1', [['A-1', 'M-1', 'Z-1'], ['A-1', 'M-2', 'Z-1']]) });
    const response = await post(app, ask({ limit: 5 }));
    expect(response.statusCode).toBe(200);
    const body = pathsOkSchema.parse(response.json());
    expect(body).toMatchObject({ partial: true, retained: 2, requested: 5, capReached: false });
    expect(body.paths).toHaveLength(2);
    expect(body.nodes.map((node) => node.ref.stableId).sort()).toEqual(['A-1', 'M-1', 'M-2', 'Z-1']);
    expect(events.filter((event) => event.action === 'graph.shortest_paths_run').map((event) => event.result)).toEqual(['partial']);
    await app.close();
  });

  it('is still partial when the limit was read before the time ran out, since nothing shows that no more exist', async () => {
    const { rows } = makerNodes();
    const { app } = await started({ timeout: 'with-rows', rows: rows('A-1', 'Z-1', [['A-1', 'M-1', 'Z-1']]) });
    expect(pathsOkSchema.parse((await post(app, ask({ limit: 1 }))).json())).toMatchObject({ partial: true, retained: 1, requested: 1, capReached: false });
    await app.close();
  });

  it('answers QUERY_TIMEOUT with the limit that stopped it when no path was read', async () => {
    const { app, events } = await started({ timeout: 'no-rows' });
    const response = await post(app, ask());
    expect({ status: response.statusCode, error: errorOf(response) }).toMatchObject({ status: 504, error: { code: 'QUERY_TIMEOUT', details: { timeoutMs: 5000 } } });
    expect(events.filter((event) => event.action === 'graph.shortest_paths_run').map((event) => event.result)).toEqual(['failed']);
    await app.close();
  });

  it('passes the partial rows through the stages of the gate, so the nodes are masked when the request asks', async () => {
    const { rows } = makerNodes();
    const { app } = await started({ timeout: 'with-rows', rows: rows('A-1', 'Z-1', [['A-1', 'Z-1']]) });
    const response = await post(app, ask({ mask: true }));
    expect(pathsOkSchema.parse(response.json()).partial).toBe(true);
    expect(response.body).not.toContain('Owner of A-1');
    await app.close();
  });

  it('keeps nothing of a probe that timed out: no search runs and no partial answer is made of it', async () => {
    const { app, executor } = await started({ probe: 'timeout' });
    expect((await post(app, ask())).statusCode).toBe(504);
    expect(reads(executor)).toHaveLength(0);
    await app.close();
  });

  it('counts a partial read as a timeout for the circuit breaker of the source', async () => {
    const { rows } = makerNodes();
    const { app } = await started({ timeout: 'with-rows', rows: rows('A-1', 'Z-1', [['A-1', 'Z-1']]), budgets: { breaker_failures: 2 } });
    for (let attempt = 0; attempt < 2; attempt += 1) expect((await post(app, ask())).statusCode).toBe(200);
    const open = await post(app, ask());
    expect({ status: open.statusCode, code: errorOf(open).code }).toEqual({ status: 503, code: 'SOURCE_UNAVAILABLE' });
    await app.close();
  });
});

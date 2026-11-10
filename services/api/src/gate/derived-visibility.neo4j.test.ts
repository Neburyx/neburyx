import { rmSync } from 'node:fs';
import { derivedNeighborsResponseSchema, edgeRefSegmentOf, type GraphEdge } from '@neburyx/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createLogger } from '../logger.js';
import { memoryAppStore } from '../testing/app-store.js';
import { makeWebRoot } from '../testing/web-root.js';
import { createNeo4jExecutor } from '../sources/executor.js';
import { communitySeams } from '../seams/community-seams.js';
import { hidingEdgeRedact, hidingRedact } from '../testing/derived-fixtures.js';
import { gateRequest, LOCAL_PRINCIPAL } from '../testing/gate.js';
import { envFor, NEO4J_SERIES, runAdmin, runAll, sourceFor, startNeo4j, type RunningNeo4j } from '../testing/neo4j-server.js';
import { assembleGate } from './assemble.js';
import { isNormalizedSupports, type NormalizedSupports } from './normalize/derived-run.js';
import { redactItems } from './redact/index.js';
import { DERIVED_EDGE_SUPPORT_ID } from './templates/derived-edge-support.js';
import { DERIVED_RULE_RUN_ID } from './templates/derived-rule-run.js';
import type { Gate, GateContext, Item } from './types.js';

/**
 * The visibility rule of a derived relationship, proved against a real graph: it is shown only if both ends, every middle entity and every supporting relationship of its chain are visible.
 * What the gate answers is the items before the route's own checks: the stored elements around a hidden one stay in the page here, and the route answers NOT_FOUND for a derived relationship with a hidden element (`edges/derived-edge-route.test.ts`). So this file proves the derived relationships the gate lets out and the ones it drops. The Community policy hides nothing, so a stage that takes one element out of the result stands for a policy that does (as in the route tests); everything else is the real adapter, templates and normalizer.
 */
let server: RunningNeo4j;
const closers: (() => Promise<void>)[] = [];

const entities = [
  { type: 'maker', label: 'VMaker', stable_id: 'makerId' },
  { type: 'tool', label: 'VTool', stable_id: 'toolId' },
];
const relationships = [{ type: 'USES_TOOL', from: 'maker', to: 'tool', stable_id: 'useId' }];
const derived = [{ id: 'shared-tool', from: 'maker', to: 'maker', via: ['USES_TOOL', 'tool', 'USES_TOOL'], rule_version: 1 }];

const end = (stableId: string) => ({ sourceId: 'graph', entityType: 'maker', stableId });
type Redact = (items: readonly Item[], context: GateContext) => readonly Item[];

beforeAll(async () => {
  server = await startNeo4j();
  await runAdmin(server, 'CREATE CONSTRAINT v_maker FOR (n:VMaker) REQUIRE n.makerId IS UNIQUE');
  await runAdmin(server, 'CREATE INDEX v_tool FOR (n:VTool) ON (n.toolId)');
  await runAdmin(server, "CREATE (:VMaker {makerId: 'v1'}), (:VMaker {makerId: 'v2'}), (:VMaker {makerId: 'v3'}), (:VMaker {makerId: 'v4'}), (:VTool {toolId: 't1'}), (:VTool {toolId: 't2'}), (:VTool {toolId: 't3'})");
  await runAdmin(server, "UNWIND [['v1', 't1'], ['v2', 't1'], ['v1', 't2'], ['v3', 't2'], ['v1', 't3'], ['v4', 't3']] AS pair MATCH (a:VMaker {makerId: pair[0]}), (d:VTool {toolId: pair[1]}) CREATE (a)-[:USES_TOOL {useId: pair[0] + pair[1]}]->(d)");
  await runAdmin(server, 'CALL db.awaitIndexes(300)');
}, 300_000);

afterAll(async () => {
  await runAll([...closers.map((close) => () => close()), () => server?.stop()]);
});

/** The real gate over the real adapter, with a stage in front of the gate's own redaction, and the real API over that gate. */
async function gateWith(hide?: (redact: Redact) => Redact) {
  const defaults = communitySeams();
  const executor = createNeo4jExecutor({ sources: [sourceFor(server, { entities, relationships, derived })], env: envFor(server), logger: { warn: () => undefined } });
  closers.push(() => executor.close());
  const mapping = { sources: [sourceFor(server, { entities, relationships, derived })] };
  const seams = { policy: defaults.policy, coordinator: defaults.coordinator, audit: defaults.audit };
  const { gate } = assembleGate({ mapping, seams, executor, logger: { warn: () => undefined }, redact: hide === undefined ? redactItems : hide(redactItems) });
  const webRoot = makeWebRoot();
  const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store: memoryAppStore(), mapping, gate, seams });
  closers.push(async () => {
    await app.close();
    rmSync(webRoot, { recursive: true, force: true });
  });
  return { gate, app };
}

type Api = Awaited<ReturnType<typeof gateWith>>['app'];

/** What a person is shown by the two routes of the inspector that carry a derived relationship: the neighbors of v1 with their count, and the evidence of v1 and another maker. */
async function shown(app: Api, to: string) {
  const list = await app.inject({ method: 'POST', url: '/v1/graph/derived-neighbors', payload: { sourceId: 'graph', ref: { entityType: 'maker', stableId: 'v1' } } });
  expect(list.statusCode, list.body).toBe(200);
  const [result] = derivedNeighborsResponseSchema.parse(list.json()).results;
  const edge = await app.inject({ method: 'GET', url: `/v1/edges/${edgeRefSegmentOf({ sourceId: 'graph', derived: { ruleId: 'shared-tool', from: end('v1'), to: end(to) } })}` });
  return { listBody: list.body, count: result?.count, derivedEdges: (result?.edges ?? []).filter((each) => each.semantics === 'derived'), warnings: result?.warnings ?? [], edgeStatus: edge.statusCode, edgeBody: edge.body };
}


async function neighbors(gate: Gate, from = 'v1') {
  const page = await gate.run(gateRequest({ sourceId: 'graph', principal: LOCAL_PRINCIPAL, templateId: DERIVED_RULE_RUN_ID, params: { entityType: 'maker', stableId: from, ruleId: 'shared-tool' }, limit: 25 }));
  const [item] = page.items;
  const edges = ((item as unknown as { edges?: GraphEdge[] } | undefined)?.edges ?? []).filter((edge) => edge.semantics === 'derived');
  return { page, edges, targets: edges.map((edge) => edge.to.stableId).sort(), derivedText: JSON.stringify(edges) };
}

async function supports(gate: Gate, to: string) {
  const page = await gate.run(gateRequest({ sourceId: 'graph', principal: LOCAL_PRINCIPAL, templateId: DERIVED_EDGE_SUPPORT_ID, params: { ruleId: 'shared-tool', ends: [end('v1'), end(to)] }, limit: 25 }));
  const [item] = page.items;
  const edges = item !== undefined && isNormalizedSupports(item as never) ? ((item as unknown as NormalizedSupports).edges as GraphEdge[]) : [];
  return { derivedEdges: edges.filter((edge) => edge.semantics === 'derived'), derivedText: JSON.stringify(edges) };
}

describe(`the visibility rule of a derived relationship on ${NEO4J_SERIES}`, () => {
  it('shows every derived relationship of v1 when everything is visible', async () => {
    const { gate, app } = await gateWith();
    expect((await neighbors(gate)).targets).toEqual(['v2', 'v3', 'v4']);
    for (const to of ['v2', 'v3', 'v4']) expect((await supports(gate, to)).derivedEdges, to).toHaveLength(1);
    const all = await shown(app, 'v2');
    expect(all.count).toMatchObject({ value: 3, quality: 'exact' });
    expect(all.edgeStatus).toBe(200);
  });

  it.each([
    { what: 'an end', hide: 'v2', gone: 'v2', kept: ['v3', 'v4'] },
    { what: 'a middle entity', hide: 't2', gone: 'v3', kept: ['v2', 'v4'] },
  ])('shows no derived relationship when $what is not visible, from the rule run or the supports', async ({ hide, gone, kept }) => {
    const { gate, app } = await gateWith((redact) => hidingRedact(hide, redact));
    const run = await neighbors(gate);
    expect(run.targets).toEqual(kept);
    expect(run.derivedText, 'no derived relationship names the hidden element').not.toContain(`"${hide}"`);
    const read = await supports(gate, gone);
    expect(read.derivedEdges).toEqual([]);
    for (const to of kept) expect((await supports(gate, to)).derivedEdges, to).toHaveLength(1);
    await expectHidden(app, hide, gone, kept.length);
  });

  it('shows no derived relationship when one supporting relationship is not visible and both of its ends are', async () => {
    const { gate, app } = await gateWith((redact) => hidingEdgeRedact('v3t2', redact));
    const run = await neighbors(gate);
    expect(run.targets).toEqual(['v2', 'v4']);
    expect(run.derivedText).not.toContain('v3t2');
    const read = await supports(gate, 'v3');
    expect(read.derivedEdges).toEqual([]);
    expect((await supports(gate, 'v2')).derivedEdges).toHaveLength(1);
    await expectHidden(app, 'v3t2', 'v3', 2);
  });
});

/** The rule whole, as a person meets it: the neighbors hold no derived relationship through the hidden element and their count does not reveal it (the kept ones, exact), no warning says that one was left out, and the evidence of the hidden pair is not found. */
async function expectHidden(app: Api, hidden: string, gone: string, kept: number): Promise<void> {
  const seen = await shown(app, gone);
  expect(seen.count, 'the count is the derived relationships that remain').toMatchObject({ value: kept, quality: 'exact' });
  expect(seen.derivedEdges).toHaveLength(kept);
  expect(seen.derivedEdges.map((edge) => edge.to.stableId)).not.toContain(gone);
  expect(seen.listBody, 'the neighbors do not name the hidden element').not.toContain(`"${hidden}"`);
  expect(seen.warnings, 'nothing says that one was left out, and no count does').toEqual([]);
  expect(seen.edgeStatus).toBe(404);
  expect(seen.edgeBody).not.toContain(`"${hidden}"`);
}

import neo4j, { type ProfiledPlan } from 'neo4j-driver';
import type { GraphEdge } from '@neburyx/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allowlistFromMapping } from './allowlist.js';
import { defaultCatalog } from './assemble.js';
import { isNormalizedSupports, type NormalizedSupports } from './normalize/derived-run.js';
import { renderTemplate } from './render.js';
import { communitySeams } from '../seams/community-seams.js';
import { gateRequest, LOCAL_PRINCIPAL } from '../testing/gate.js';
import { envFor, NEO4J_SERIES, runAdmin, runAll, sourceFor, startNeo4j, type RunningNeo4j } from '../testing/neo4j-server.js';
import { createSourceGate, type SourceGate } from './source-gate.js';
import { DERIVED_EDGE_SUPPORT_ID } from './templates/derived-edge-support.js';

let server: RunningNeo4j;
let parts: SourceGate;

const entities = [
  { type: 'maker', label: 'XMaker', stable_id: 'makerId' },
  { type: 'tool', label: 'XTool', stable_id: 'toolId' },
];
const relationships = [
  { type: 'USES_TOOL', from: 'maker', to: 'tool', stable_id: 'useId' },
  { type: 'SEEN_WITH', from: 'maker', to: 'tool' },
  { type: 'LINKED', from: 'tool', to: 'tool' },
];
const derived = [
  { id: 'shared-tool', from: 'maker', to: 'maker', via: ['USES_TOOL', 'tool', 'USES_TOOL'], rule_version: 1, stop_list_property: 'isCommon' },
  { id: 'seen-together', from: 'maker', to: 'maker', via: ['SEEN_WITH', 'tool', 'SEEN_WITH'], rule_version: 1 },
  { id: 'tool-linked', from: 'maker', to: 'maker', via: ['USES_TOOL', 'tool', 'LINKED', 'tool', 'USES_TOOL'], rule_version: 1 },
];

beforeAll(async () => {
  server = await startNeo4j();
  await runAdmin(server, 'CREATE CONSTRAINT x_maker FOR (n:XMaker) REQUIRE n.makerId IS UNIQUE');
  await runAdmin(server, 'CREATE INDEX x_tool FOR (n:XTool) ON (n.toolId)');
  await runAdmin(server, "CREATE (:XMaker {makerId: 'a1'}), (:XMaker {makerId: 'a2'}), (:XMaker {makerId: 'a3'}), (:XMaker {makerId: 'a4'}), (:XTool {toolId: 'd1'}), (:XTool {toolId: 'd2', isCommon: true}), (:XTool {toolId: 'd3'})");
  await runAdmin(server, "UNWIND [['a1', 'd1'], ['a2', 'd1'], ['a1', 'd2'], ['a3', 'd2'], ['a1', 'd3'], ['a4', 'd3']] AS pair MATCH (a:XMaker {makerId: pair[0]}), (d:XTool {toolId: pair[1]}) CREATE (a)-[:USES_TOOL {useId: pair[0] + pair[1]}]->(d)");
  await runAdmin(server, "UNWIND [['a1', 'd1'], ['a1', 'd1'], ['a2', 'd1']] AS pair MATCH (a:XMaker {makerId: pair[0]}), (d:XTool {toolId: pair[1]}) CREATE (a)-[:SEEN_WITH]->(d)");
  await runAdmin(server, "CREATE (:XMaker {makerId: 'm1'}), (:XMaker {makerId: 'm2'})");
  await runAdmin(server, "UNWIND range(1, 40) AS i CREATE (:XTool {toolId: 'mt' + toString(i)})");
  await runAdmin(server, "MATCH (t:XTool) WHERE t.toolId STARTS WITH 'mt' MATCH (a:XMaker) WHERE a.makerId IN ['m1', 'm2'] CREATE (a)-[:USES_TOOL {useId: a.makerId + t.toolId}]->(t)");
  await runAdmin(server, "CREATE (:XMaker {makerId: 'q1'}), (:XMaker {makerId: 'q2'}), (:XTool {toolId: 'pt'})");
  await runAdmin(server, "MATCH (a:XMaker {makerId: 'q1'}), (t:XTool {toolId: 'pt'}) UNWIND range(1, 2000) AS i CREATE (a)-[:SEEN_WITH]->(t)");
  await runAdmin(server, "MATCH (a:XMaker {makerId: 'q2'}), (t:XTool {toolId: 'pt'}) CREATE (a)-[:SEEN_WITH]->(t)");
  await runAdmin(server, "MATCH (a:XMaker {makerId: 'q1'}), (b:XMaker {makerId: 'q2'}) UNWIND range(1, 24) AS i CREATE (x:XTool {toolId: 'qt' + toString(i)}), (a)-[:SEEN_WITH]->(x), (b)-[:SEEN_WITH]->(x)");
  await runAdmin(server, "CREATE (:XMaker {makerId: 'l1'}), (:XMaker {makerId: 'l2'}), (:XTool {toolId: 'lt1'}), (:XTool {toolId: 'lt2'})");
  await runAdmin(server, "UNWIND [['l1', 'lt1'], ['l2', 'lt2']] AS pair MATCH (a:XMaker {makerId: pair[0]}), (d:XTool {toolId: pair[1]}) CREATE (a)-[:USES_TOOL {useId: pair[0] + pair[1]}]->(d)");
  await runAdmin(server, "MATCH (x:XTool {toolId: 'lt1'}), (y:XTool {toolId: 'lt2'}) UNWIND range(1, 2000) AS i CREATE (x)-[:LINKED]->(y)");
  await runAdmin(server, 'CALL db.awaitIndexes(300)');
  const defaults = communitySeams();
  parts = createSourceGate({ mapping: { sources: [sourceFor(server, { entities, relationships, derived })] }, env: envFor(server), seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit: defaults.audit }, logger: { warn: () => undefined } });
}, 300_000);

afterAll(async () => {
  await runAll([() => parts?.close(), () => server?.stop()]);
});

const end = (stableId: string) => ({ sourceId: 'graph', entityType: 'maker', stableId });

async function supports(from: string, to: string, ruleId = 'shared-tool', limit = 25) {
  const page = await parts.gate.run(gateRequest({ sourceId: 'graph', principal: LOCAL_PRINCIPAL, templateId: DERIVED_EDGE_SUPPORT_ID, params: { ruleId, ends: [end(from), end(to)] }, limit }));
  const [item] = page.items;
  if (item === undefined || !isNormalizedSupports(item as never)) throw new Error('no supports item');
  const found = item as unknown as NormalizedSupports;
  return { page, found, edges: found.edges as GraphEdge[], derivedEdges: (found.edges as GraphEdge[]).filter((edge) => edge.semantics === 'derived') };
}

describe(`the supports of a derived relationship on ${NEO4J_SERIES}`, () => {
  it('finds the chain through the shared tool, with its two stored supports and one derived edge, and not through a stop-listed tool', async () => {
    const { found, derivedEdges } = await supports('a1', 'a2');
    expect(found.chains).toHaveLength(1);
    expect(found.chains[0]?.middle.map((ref) => ref.stableId)).toEqual(['d1']);
    expect(derivedEdges).toHaveLength(1);
    expect(derivedEdges[0]?.derivation?.supportingEdgeRefs).toHaveLength(2);
    expect((await supports('a1', 'a3')).found.chains).toEqual([]);
  });

  it('answers a support with no stable ID as an aggregate edge, and holds no value of any member', async () => {
    const { found, edges } = await supports('a1', 'a2', 'seen-together');
    expect(found.chains).toHaveLength(1);
    expect(edges.filter((edge) => 'aggregate' in edge.ref)).toHaveLength(2);
    expect(JSON.stringify(edges)).not.toMatch(/elementId|"4:/);
  });

  it('answers no row, and no error, for a pair with no chain and for an end that does not exist', async () => {
    expect((await supports('a3', 'a4')).found.chains).toEqual([]);
    const { page, derivedEdges } = await supports('nobody', 'a1');
    expect(page.hasMore).toBe(false);
    expect(derivedEdges).toEqual([]);
    expect((await supports('nobody', 'a1')).found.chains).toEqual([]);
  });

  it('answers at most the limit and a cut for 40 shared tools, and the read stays bounded', async () => {
    const { page, found } = await supports('m1', 'm2');
    expect(found.chains).toHaveLength(25);
    expect(page.hasMore).toBe(true);
    const small = await supports('m1', 'm2', 'shared-tool', 10);
    expect(small.found.chains).toHaveLength(10);
  });

  it('counts 2,000 parallel relationships between the same two nodes as one chain, within the read timeout', async () => {
    const { found, page } = await supports('q1', 'q2', 'seen-together', 50);
    expect(page.hasMore).toBe(false);
    expect(found.chains).toHaveLength(25);
    expect(new Set(found.chains.map((chain) => chain.middle[0]?.stableId)).size).toBe(25);
  });

  it('answers one chain through two middle entities joined by 2,000 parallel relationships, with the aggregate support between them', async () => {
    const { found, edges } = await supports('l1', 'l2', 'tool-linked');
    expect(found.chains).toHaveLength(1);
    expect(found.chains[0]?.middle.map((ref) => ref.stableId)).toEqual(['lt1', 'lt2']);
    expect(found.chains[0]?.supports).toHaveLength(3);
    expect(edges.filter((edge) => 'aggregate' in edge.ref)).toHaveLength(1);
  });

  it('records the database hits of the read with 2,000 parallel relationships between two middle entities', async () => {
    const template = defaultCatalog().find(DERIVED_EDGE_SUPPORT_ID);
    if (template === undefined) throw new Error('no template');
    const allowlist = allowlistFromMapping(sourceFor(server, { entities, relationships, derived }));
    const ends = [end('l1'), end('l2')].map((each) => ({ ...each, stableInteger: null }));
    const rendered = renderTemplate(template, { ruleId: 'tool-linked', ends }, allowlist, 25, 500);
    const session = server.admin.session({ database: server.database });
    try {
      const result = await session.run(`PROFILE ${rendered.cypher}`, { ...rendered.parameters, limit: neo4j.int(25) });
      const operators = (plan: ProfiledPlan | false): ProfiledPlan[] => (plan === false ? [] : [plan, ...plan.children.flatMap(operators)]);
      const hits = operators(result.summary.profile).reduce((sum, operator) => sum + Number(operator.dbHits), 0);
      process.stdout.write(`derived-edge-support PROFILE (two middle entities, 2,000 parallel): ${result.records.length} rows, ${hits} db hits\n`);
      expect(result.records).toHaveLength(1);
      expect(hits).toBeLessThan(100_000);
    } finally {
      await session.close();
    }
  });

  it('records the database hits of the read with 2,000 parallel relationships', async () => {
    const template = defaultCatalog().find(DERIVED_EDGE_SUPPORT_ID);
    if (template === undefined) throw new Error('no template');
    const allowlist = allowlistFromMapping(sourceFor(server, { entities, relationships, derived }));
    const ends = [end('q1'), end('q2')].map((each) => ({ ...each, stableInteger: null }));
    const rendered = renderTemplate(template, { ruleId: 'seen-together', ends }, allowlist, 25, 500);
    const session = server.admin.session({ database: server.database });
    try {
      const result = await session.run(`PROFILE ${rendered.cypher}`, { ...rendered.parameters, limit: neo4j.int(25) });
      const operators = (plan: ProfiledPlan | false): ProfiledPlan[] => (plan === false ? [] : [plan, ...plan.children.flatMap(operators)]);
      const hits = operators(result.summary.profile).reduce((sum, operator) => sum + Number(operator.dbHits), 0);
      process.stdout.write(`derived-edge-support PROFILE: ${result.records.length} rows, ${hits} db hits\n`);
      expect(result.records).toHaveLength(25);
      expect(hits).toBeLessThan(100_000);
    } finally {
      await session.close();
    }
  });

  it('writes nothing: the data is the same after the runs', async () => {
    const count = async (): Promise<number> => {
      const session = server.admin.session({ database: server.database });
      try {
        return Number((await session.run('MATCH (n) RETURN count(n) AS nodes')).records[0]?.get('nodes'));
      } finally {
        await session.close();
      }
    };
    const before = await count();
    await supports('a1', 'a2');
    expect(await count()).toBe(before);
  });
});

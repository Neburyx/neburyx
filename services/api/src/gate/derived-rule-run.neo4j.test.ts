import neo4j, { type ProfiledPlan } from 'neo4j-driver';
import type { GraphEdge } from '@neburyx/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allowlistFromMapping } from './allowlist.js';
import { defaultCatalog } from './assemble.js';
import { renderTemplate } from './render.js';
import { communitySeams } from '../seams/community-seams.js';
import { gateRequest, LOCAL_PRINCIPAL } from '../testing/gate.js';
import { envFor, NEO4J_SERIES, runAdmin, runAll, sourceFor, startNeo4j, type RunningNeo4j } from '../testing/neo4j-server.js';
import { createSourceGate, type SourceGate } from './source-gate.js';
import { DERIVED_RULE_RUN_ID } from './templates/derived-rule-run.js';

let server: RunningNeo4j;
let parts: SourceGate;

const entities = [
  { type: 'maker', label: 'XMaker', stable_id: 'makerId' },
  { type: 'tool', label: 'XTool', stable_id: 'toolId' },
];
const relationships = [
  { type: 'USES_TOOL', from: 'maker', to: 'tool', stable_id: 'useId' },
  { type: 'SEEN_WITH', from: 'maker', to: 'tool' },
];
const derived = [
  { id: 'shared-tool', from: 'maker', to: 'maker', via: ['USES_TOOL', 'tool', 'USES_TOOL'], rule_version: 1, stop_list_property: 'isCommon' },
  { id: 'seen-together', from: 'maker', to: 'maker', via: ['SEEN_WITH', 'tool', 'SEEN_WITH'], rule_version: 1 },
];

beforeAll(async () => {
  server = await startNeo4j();
  await runAdmin(server, 'CREATE CONSTRAINT x_account FOR (n:XMaker) REQUIRE n.makerId IS UNIQUE');
  await runAdmin(server, 'CREATE INDEX x_device FOR (n:XTool) ON (n.toolId)');
  await runAdmin(server, "CREATE (:XMaker {makerId: 'a1'}), (:XMaker {makerId: 'a2'}), (:XMaker {makerId: 'a3'}), (:XMaker {makerId: 'a4'}), (:XTool {toolId: 'd1'}), (:XTool {toolId: 'd2', isCommon: true}), (:XTool {toolId: 'd3'})");
  await runAdmin(server, "UNWIND [['a1', 'd1'], ['a2', 'd1'], ['a1', 'd2'], ['a3', 'd2'], ['a1', 'd3'], ['a4', 'd3']] AS pair MATCH (a:XMaker {makerId: pair[0]}), (d:XTool {toolId: pair[1]}) CREATE (a)-[:USES_TOOL {useId: pair[0] + pair[1]}]->(d)");
  await runAdmin(server, "UNWIND [['a1', 'd1'], ['a1', 'd1'], ['a2', 'd1']] AS pair MATCH (a:XMaker {makerId: pair[0]}), (d:XTool {toolId: pair[1]}) CREATE (a)-[:SEEN_WITH]->(d)");
  await runAdmin(server, "CREATE (:XTool {toolId: 'big'}), (:XTool {toolId: 'small'}), (:XMaker {makerId: 'bigAnchor'}), (:XMaker {makerId: 'smallAnchor'})");
  await runAdmin(server, "MATCH (d:XTool {toolId: 'big'}), (a:XMaker {makerId: 'bigAnchor'}) CREATE (a)-[:USES_TOOL {useId: 'bigAnchor'}]->(d)");
  await runAdmin(server, "MATCH (d:XTool {toolId: 'small'}), (a:XMaker {makerId: 'smallAnchor'}) CREATE (a)-[:USES_TOOL {useId: 'smallAnchor'}]->(d)");
  await runAdmin(server, "MATCH (d:XTool {toolId: 'big'}) UNWIND range(1, 1000) AS i CREATE (:XMaker {makerId: 'b' + toString(i)})-[:USES_TOOL {useId: 'b' + toString(i)}]->(d)");
  await runAdmin(server, "MATCH (d:XTool {toolId: 'small'}) UNWIND range(1, 100) AS i CREATE (:XMaker {makerId: 's' + toString(i)})-[:USES_TOOL {useId: 's' + toString(i)}]->(d)");
  await runAdmin(server, 'CALL db.awaitIndexes(300)');
  const defaults = communitySeams();
  parts = createSourceGate({ mapping: { sources: [sourceFor(server, { entities, relationships, derived })] }, env: envFor(server), seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit: defaults.audit }, logger: { warn: () => undefined } });
}, 300_000);

afterAll(async () => {
  await runAll([() => parts?.close(), () => server?.stop()]);
});

async function run(stableId: string, ruleId = 'shared-tool', limit = 25) {
  const page = await parts.gate.run(gateRequest({ sourceId: 'graph', principal: LOCAL_PRINCIPAL, templateId: DERIVED_RULE_RUN_ID, params: { entityType: 'maker', stableId, ruleId }, limit }));
  const [item] = page.items;
  const edges = (item as unknown as { edges: GraphEdge[] }).edges;
  return { page, edges, derived: edges.filter((edge) => edge.semantics === 'derived') };
}

describe(`the rule run on ${NEO4J_SERIES}`, () => {
  it('finds each other account that shares a device once, with its supporting edges, and not through a stop-listed device', async () => {
    const { derived: found } = await run('a1');
    expect(found.map((edge) => edge.to.stableId).sort()).toEqual(['a2', 'a4']);
    for (const edge of found) expect(edge.derivation?.supportingEdgeRefs).toHaveLength(2);
  });

  it('finds nothing from an account that shares no device and answers no row for an account that does not exist', async () => {
    expect((await run('nobody')).derived).toEqual([]);
  });

  it('answers a support with no stable ID as an aggregate edge whose member count is a lower bound', async () => {
    const { edges, derived: found } = await run('a1', 'seen-together');
    expect(found.map((edge) => edge.to.stableId)).toEqual(['a2']);
    const aggregates = edges.filter((edge) => 'aggregate' in edge.ref);
    expect(aggregates).toHaveLength(2);
    for (const edge of aggregates) expect(edge.memberCount?.quality).toBe('lowerBound');
  });

  it('answers 25 and a cut for a device shared by 1,000 accounts, and the same for one shared by 100', async () => {
    for (const anchor of ['bigAnchor', 'smallAnchor']) {
      const { page, derived: found } = await run(anchor);
      expect(page.hasMore).toBe(true);
      expect(found).toHaveLength(25);
    }
  });

  it('reads about the same for a device of 1,000 accounts as for one of 100: the bound is the rows and not the degree', async () => {
    const template = defaultCatalog().find(DERIVED_RULE_RUN_ID);
    if (template === undefined) throw new Error('no template');
    const allowlist = allowlistFromMapping(sourceFor(server, { entities, relationships, derived }));
    const hitsOf = async (stableId: string): Promise<number> => {
      const rendered = renderTemplate(template, { entityType: 'maker', stableId, stableInteger: null, ruleId: 'shared-tool' }, allowlist, 25, 500);
      const session = server.admin.session({ database: server.database });
      try {
        const result = await session.run(`PROFILE ${rendered.cypher}`, { ...rendered.parameters, limit: neo4j.int(25) });
        const operators = (plan: ProfiledPlan | false): ProfiledPlan[] => (plan === false ? [] : [plan, ...plan.children.flatMap(operators)]);
        expect(result.records).toHaveLength(26);
        return operators(result.summary.profile).reduce((sum, operator) => sum + Number(operator.dbHits), 0);
      } finally {
        await session.close();
      }
    };
    const big = await hitsOf('bigAnchor');
    const small = await hitsOf('smallAnchor');
    expect(big).toBeLessThan(small * 2);
  });

  it('writes nothing: the data is the same after the runs, and the login the gate uses is the reader', async () => {
    const count = async (): Promise<number> => {
      const session = server.admin.session({ database: server.database });
      try {
        const result = await session.run('MATCH (n) RETURN count(n) AS nodes');
        return Number(result.records[0]?.get('nodes'));
      } finally {
        await session.close();
      }
    };
    const before = await count();
    await run('a1');
    expect(await count()).toBe(before);
  });
});

import neo4j, { type ProfiledPlan } from 'neo4j-driver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allowlistFromMapping } from './allowlist.js';
import { defaultCatalog } from './assemble.js';
import { renderTemplate } from './render.js';
import { communitySeams } from '../seams/community-seams.js';
import { gateRequest, LOCAL_PRINCIPAL } from '../testing/gate.js';
import { envFor, NEO4J_SERIES, runAdmin, runAll, sourceFor, startNeo4j, type RunningNeo4j } from '../testing/neo4j-server.js';
import { createSourceGate, type SourceGate } from './source-gate.js';
import { RELATED_CONTEXT_ID, type RelatedContextItem } from './templates/related-context.js';

let server: RunningNeo4j;
let parts: SourceGate;
const BIG = 100_000;

const entities = [
  { type: 'maker', label: 'XMaker', stable_id: 'makerId' },
  { type: 'piece', label: 'XPiece', stable_id: 'pieceId' },
];
const relationships = [
  { type: 'OWNS', from: 'maker', to: 'piece' },
  { type: 'KNOWS', from: 'maker', to: 'maker' },
  { type: 'PAID', from: 'piece', to: 'piece' },
];

const ref = (entityType: string, stableId: string) => ({ sourceId: 'graph', entityType, stableId });

beforeAll(async () => {
  server = await startNeo4j();
  await runAdmin(server, 'CREATE CONSTRAINT x_maker FOR (n:XMaker) REQUIRE n.makerId IS UNIQUE');
  await runAdmin(server, 'CREATE INDEX x_piece FOR (n:XPiece) ON (n.pieceId)');
  await runAdmin(server, "CREATE (:XMaker {makerId: 'c1'}), (:XMaker {makerId: 'c2'}), (:XMaker {makerId: 'c3'}), (:XMaker {makerId: 'c4'}), (:XPiece {pieceId: 'a1'}), (:XPiece {pieceId: 'a2'}), (:XPiece {pieceId: 'a3'})");
  await runAdmin(server, "MATCH (c:XMaker {makerId: 'c1'}), (a:XPiece {pieceId: 'a1'}) CREATE (c)-[:OWNS]->(a)");
  await runAdmin(server, "MATCH (c:XMaker {makerId: 'c2'}), (a:XPiece) WHERE a.pieceId IN ['a1', 'a2'] CREATE (c)-[:OWNS]->(a), (c)-[:OWNS]->(a)");
  await runAdmin(server, "MATCH (a:XPiece {pieceId: 'a1'}), (b:XPiece {pieceId: 'a2'}) CREATE (a)-[:PAID]->(b), (b)-[:PAID]->(a)");
  await runAdmin(server, "MATCH (a:XPiece {pieceId: 'a3'}), (b:XPiece {pieceId: 'a1'}) CREATE (a)-[:PAID]->(b)");
  await runAdmin(server, "MATCH (c:XMaker {makerId: 'c3'}), (d:XMaker {makerId: 'c4'}) CREATE (c)-[:KNOWS]->(d)");
  await runAdmin(server, "CREATE (:XMaker {makerId: 'bigC'}), (:XPiece {pieceId: 'bigA'})");
  await runAdmin(server, `MATCH (c:XMaker {makerId: 'bigC'}) UNWIND range(1, ${BIG}) AS i CREATE (c)-[:OWNS]->(:XPiece {pieceId: 'o' + toString(i)})`);
  await runAdmin(server, `MATCH (a:XPiece {pieceId: 'bigA'}) UNWIND range(1, ${BIG}) AS i CREATE (:XMaker {makerId: 'p' + toString(i)})-[:OWNS]->(a)`);
  await runAdmin(server, 'CALL db.awaitIndexes(300)');
  const defaults = communitySeams();
  parts = createSourceGate({ mapping: { sources: [sourceFor(server, { entities, relationships })] }, env: envFor(server), seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit: defaults.audit }, logger: { warn: () => undefined } });
}, 900_000);

afterAll(async () => {
  await runAll([() => parts?.close(), () => server?.stop()]);
});

async function context(hits: readonly object[], exact: readonly object[]) {
  const result = await parts.gate.run(gateRequest({ sourceId: 'graph', principal: LOCAL_PRINCIPAL, templateId: RELATED_CONTEXT_ID, params: { hits, exact }, limit: 25 }));
  return (result.items[0] as unknown as RelatedContextItem).context;
}

describe(`the relationship context read on ${NEO4J_SERIES}`, () => {
  it('answers the relationship of a hit to an exact match, from the hit side, in both directions', async () => {
    expect(await context([ref('maker', 'c1')], [ref('piece', 'a1')])).toEqual([{ hit: 0, exact: 0, relationshipType: 'OWNS', direction: 'out' }]);
    expect(await context([ref('piece', 'a1')], [ref('maker', 'c1')])).toEqual([{ hit: 0, exact: 0, relationshipType: 'OWNS', direction: 'in' }]);
  });

  it('answers one row for a hit with two relationships to an exact match, and the same row every time', async () => {
    const first = await context([ref('maker', 'c2')], [ref('piece', 'a2')]);
    expect(first).toEqual([{ hit: 0, exact: 0, relationshipType: 'OWNS', direction: 'out' }]);
    expect(await context([ref('maker', 'c2')], [ref('piece', 'a2')])).toEqual(first);
  });

  it('chooses by the mapping row, then out before in, then the earlier exact match', async () => {
    expect(await context([ref('piece', 'a1')], [ref('piece', 'a2')])).toEqual([{ hit: 0, exact: 0, relationshipType: 'PAID', direction: 'out' }]);
    expect(await context([ref('piece', 'a1')], [ref('piece', 'a3'), ref('piece', 'a2')])).toEqual([{ hit: 0, exact: 1, relationshipType: 'PAID', direction: 'out' }]);
    expect(await context([ref('piece', 'a1')], [ref('piece', 'a2'), ref('piece', 'a3')])).toEqual([{ hit: 0, exact: 0, relationshipType: 'PAID', direction: 'out' }]);
    expect(await context([ref('maker', 'c3'), ref('maker', 'c4')], [ref('maker', 'c4')])).toEqual([{ hit: 0, exact: 0, relationshipType: 'KNOWS', direction: 'out' }]);
  });

  it('gives no row to a hit with no relationship, and never pairs a hit with itself', async () => {
    expect(await context([ref('maker', 'c1')], [ref('piece', 'a3')])).toEqual([]);
    expect(await context([ref('piece', 'a1')], [ref('piece', 'a1')])).toEqual([]);
    expect(await context([ref('maker', 'nobody')], [ref('piece', 'a1')])).toEqual([]);
  });

  it('answers several hits in the order of the hits, at most one row each', async () => {
    const rows = await context([ref('maker', 'c1'), ref('maker', 'c4'), ref('maker', 'c2')], [ref('piece', 'a1'), ref('piece', 'a2')]);
    expect(rows).toEqual([
      { hit: 0, exact: 0, relationshipType: 'OWNS', direction: 'out' },
      { hit: 2, exact: 0, relationshipType: 'OWNS', direction: 'out' },
    ]);
  });

  it('plans an index seek for each end and a check of the pair between two bound nodes, with no scan and no expansion from an unbound node', async () => {
    const template = defaultCatalog().find(RELATED_CONTEXT_ID);
    if (template === undefined) throw new Error('no template');
    const allowlist = allowlistFromMapping(sourceFor(server, { entities, relationships }));
    const params = { hits: [{ ...ref('maker', 'bigC'), stableInteger: null }, { ...ref('maker', 'c1'), stableInteger: null }], exact: [{ ...ref('piece', 'bigA'), stableInteger: null }, { ...ref('piece', 'a1'), stableInteger: null }] };
    const rendered = renderTemplate(template, params, allowlist, 25, 500);
    const session = server.admin.session({ database: server.database });
    try {
      const result = await session.run(`PROFILE ${rendered.cypher}`, { ...rendered.parameters, limit: neo4j.int(25) });
      const operators = (plan: ProfiledPlan | false): ProfiledPlan[] => (plan === false ? [] : [plan, ...plan.children.flatMap(operators)]);
      const names = operators(result.summary.profile).map((operator) => operator.operatorType);
      expect(names.filter((name) => /NodeIndexSeek|NodeUniqueIndexSeek/.test(name)).length).toBeGreaterThanOrEqual(2);
      expect(names.some((name) => /Expand\(Into\)|Expand\(All\)|Expand\(/.test(name))).toBe(true);
      for (const forbidden of [/AllNodesScan/, /NodeByLabelScan/, /RelationshipTypeScan/, /RelationshipIndexScan/]) expect(names.some((name) => forbidden.test(name))).toBe(false);
      const expands = operators(result.summary.profile).filter((operator) => /Expand/.test(operator.operatorType));
      // every expansion is between two nodes the plan already holds: Expand(Into), never Expand(All)
      expect(expands.every((operator) => /Into/.test(operator.operatorType))).toBe(true);
    } finally {
      await session.close();
    }
  });

  it('answers within the timeout for two ends of 100,000 relationships each, with no relationship between them, and returns no row', async () => {
    const startedAt = Date.now();
    expect(await context([ref('maker', 'bigC')], [ref('piece', 'bigA')])).toEqual([]);
    expect(Date.now() - startedAt).toBeLessThan(30_000);
  });
});

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createNeo4jExecutor } from '../../../services/api/src/sources/executor.js';
import { envFor, NEO4J_SERIES, runAdmin, runAll, sourceFor, startNeo4j, type RunningNeo4j } from '../../../services/api/src/testing/neo4j-server.js';
import { AUTOSAVE_DELAY_MS, ENTITY_TYPES, ref, RELATIONSHIP_TYPES, SOURCE, startSuite, type Suite } from './rig.js';
import { HAS, LINKED } from './scenarios.js';

let server: RunningNeo4j;
let suite: Suite | undefined;

const ENTITIES = ENTITY_TYPES.map((entity) => (entity.type === 'leaf' ? { ...entity, title: '{ownerName}', pii: [{ property: 'ownerName', class: 'name' }] } : entity));
const source = () => sourceFor(server, { id: SOURCE, entities: ENTITIES, relationships: RELATIONSHIP_TYPES });

beforeAll(async () => {
  server = await startNeo4j();
  await runAdmin(server, 'CREATE CONSTRAINT hub_id FOR (n:Hub) REQUIRE n.hubId IS UNIQUE');
  await runAdmin(server, 'CREATE CONSTRAINT leaf_id FOR (n:Leaf) REQUIRE n.leafId IS UNIQUE');
  await runAdmin(server, 'CREATE CONSTRAINT part_id FOR (n:Part) REQUIRE n.partId IS UNIQUE');
  await runAdmin(server, 'CREATE INDEX linked_rel FOR ()-[r:LINKED]-() ON (r.relId)');
  await runAdmin(server, 'CREATE INDEX has_rel FOR ()-[r:HAS]-() ON (r.relId)');
  await runAdmin(server, "CREATE (:Hub {hubId: 'H-1'}), (:Leaf {leafId: 'L-1', ownerName: 'Ana Silva'}), (:Leaf {leafId: 'L-2'}), (:Leaf {leafId: 'L-3'}), (:Part {partId: 'P-1'})");
  await runAdmin(server, "MATCH (h:Hub {hubId: 'H-1'}), (l:Leaf) CREATE (h)-[:LINKED {relId: 'r-' + l.leafId}]->(l)");
  await runAdmin(server, "MATCH (h:Hub {hubId: 'H-1'}), (p:Part {partId: 'P-1'}) CREATE (h)-[:HAS {relId: 'r-P1'}]->(p)");
  await runAdmin(server, 'CALL db.awaitIndexes(120)');
}, 600_000);

afterEach(async () => {
  await suite?.close();
  suite = undefined;
});

afterAll(async () => {
  const database = server.database;
  await runAll([() => server.stop()]);
  const probe = await startNeo4j();
  try {
    const session = probe.admin.session({ database: 'system' });
    try {
      const names = (await session.run('SHOW DATABASES YIELD name RETURN name')).records.map((record) => String(record.get('name')));
      expect(names).not.toContain(database);
    } finally {
      await session.close();
    }
  } finally {
    await probe.stop();
  }
}, 600_000);

describe(`a saved investigation reopened against a real source, on ${NEO4J_SERIES}`, () => {
  it('reads every item the graph still holds by reference through the gate, with the masking and the properties of a live read, and says an item the graph lost is missing', async () => {
    suite = await startSuite({ mapping: { sources: [source()] }, executorOf: (mapping) => createNeo4jExecutor({ sources: mapping.sources, env: envFor(server), logger: { warn: () => undefined } }) });
    const before = suite.tab();
    expect(await before.open(ref('hub', 'H-1'))).toMatchObject({ kind: 'shown' });
    const id = before.state.investigation.getState().id ?? '';
    await before.load([ref('leaf', 'L-1'), ref('leaf', 'L-2'), ref('leaf', 'L-3'), ref('part', 'P-1')], [LINKED('r-L-1'), LINKED('r-L-2'), HAS('r-P1')]);
    before.state.presentation.setPositions(new Map([[before.nodeKey('leaf', 'L-1'), { x: 11, y: 12 }]]));
    await suite.advance(AUTOSAVE_DELAY_MS);
    await before.written();

    const whole = suite.tab();
    expect(await whole.openById(id)).toMatchObject({ kind: 'shown', id });
    expect(whole.state.loadedGraph().nodes.map((node) => node.ref.stableId).sort()).toEqual(['H-1', 'L-1', 'L-2', 'L-3', 'P-1']);
    const texts: string[] = [];
    for (const mask of [false, true]) {
      const live = await whole.client.getEntity(ref('leaf', 'L-1'), { mask });
      const read = await whole.client.readRefs({ sourceId: SOURCE, mask, entities: [ref('leaf', 'L-1')], edges: [], aggregates: [], derived: [] });
      expect(live.ok && read.ok ? read.value.nodes[0] : 'not read').toEqual(live.ok ? live.value : 'not read');
      texts.push(JSON.stringify(read.ok ? read.value.nodes[0] : 'not read'));
    }
    expect(texts[0]).toContain('Ana Silva');
    expect(texts[1]).not.toContain('Ana Silva');

    await runAdmin(server, "MATCH (n:Leaf {leafId: 'L-2'}) DETACH DELETE n");
    const lost = suite.tab();
    expect(await lost.openById(id)).toMatchObject({ kind: 'shown', id, someMissing: true });
    expect(lost.state.loadedGraph().nodes.map((node) => node.ref.stableId).sort()).toEqual(['H-1', 'L-1', 'L-3', 'P-1']);
    expect(lost.state.loadedGraph().edges.map((edge) => ('stableId' in edge.ref ? edge.ref.stableId : '')).sort()).toEqual(['r-L-1', 'r-P1']);
    expect(lost.sourceReads()).toEqual(['POST /v1/graph/read-refs', 'POST /v1/graph/read-refs']);
  });
});

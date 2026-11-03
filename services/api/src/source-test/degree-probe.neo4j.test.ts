import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assembleGate, defaultCatalog } from '../gate/assemble.js';
import { createTemplateCatalog, type TemplateDefinition } from '../gate/catalog.js';
import { degreeProbeItemSchema, degreeProbeTemplate, DEGREE_PROBE_ID } from '../gate/templates/degree-probe.js';
import type { SystemRunner } from '../gate/types.js';
import { communitySeams } from '../seams/community-seams.js';
import { createNeo4jExecutor, type Neo4jExecutor } from '../sources/executor.js';
import { mappingOf, sourceWith } from '../testing/gate-fixtures.js';
import { envFor, neo4jImageFrom, NEO4J_ENV_PASSWORD, NEO4J_ENV_USER, runAdmin, runAll, startNeo4j, type RunningNeo4j } from '../testing/neo4j-container.js';
import { ALWAYS_USABLE } from '../testing/usability.js';
import { judgePlan } from './degree-judge.js';

const image = neo4jImageFrom(process.env);
let server: RunningNeo4j;
let executor: Neo4jExecutor;
let system: SystemRunner;

const auth = { kind: 'basic', username_env: NEO4J_ENV_USER, password_env: NEO4J_ENV_PASSWORD };
const entities = [
  { type: 'hub', label: 'Hub', stable_id: 'id' },
  { type: 'small', label: 'Small', stable_id: 'id' },
  { type: 'leaf', label: 'Leaf', stable_id: 'id' },
];
const relationships = [
  { type: 'LINKED', from: 'hub', to: 'leaf' },
  { type: 'LINKED', from: 'small', to: 'leaf' },
];
const SUPERNODE = 30_000;

/** The same count with the label of the anchor on the far end (the planner then expands into the anchor), and with a predicate on the relationship: the two shapes whose plans expand. They exist in this test's catalog only. */
const shapes: Record<string, TemplateDefinition> = {
  endpointLabel: {
    ...degreeProbeTemplate,
    id: 'test-endpoint-label',
    cypher:
      'PROFILE MATCH (n:@entity(entityType)) WITH n LIMIT 1 RETURN COUNT { (n)-[:@relationship(relationshipType)]->(:@entity(entityType)) } AS outgoing, COUNT { (n)<-[:@relationship(relationshipType)]-(:@entity(entityType)) } AS incoming',
  },
  relationshipPredicate: {
    ...degreeProbeTemplate,
    id: 'test-relationship-predicate',
    cypher:
      'PROFILE MATCH (n:@entity(entityType)) WITH n LIMIT 1 RETURN COUNT { (n)-[r:@relationship(relationshipType)]->() WHERE r.weight = 1 } AS outgoing, COUNT { (n)<-[r:@relationship(relationshipType)]-() WHERE r.weight = 1 } AS incoming',
  },
};

/** What each supported image shows, per shape: the verdict and the operator that decides it. A difference between the images is written here, not assumed. */
const SAME = {
  cheap: { result: 'cheap', basis: 'degree-operator', decidedBy: 'Projection' },
  endpointLabel: { result: 'not-cheap', basis: 'expand', decidedBy: 'Expand(Into)' },
  relationshipPredicate: { result: 'not-cheap', basis: 'expand', decidedBy: 'Expand(All)' },
} as const;
const EXPECTED: Record<string, typeof SAME> = { 'neo4j:5.26': SAME, 'neo4j:2026': SAME };

beforeAll(async () => {
  server = await startNeo4j();
  await runAdmin(server, `CREATE (:Hub {id: 'h'}) WITH 1 AS one UNWIND range(1, ${SUPERNODE}) AS i MATCH (h:Hub) CREATE (h)-[:LINKED]->(:Leaf {id: 'leaf' + i})`);
  await runAdmin(server, `CREATE (s:Small {id: 's'}) WITH s UNWIND range(1, 10) AS i MATCH (l:Leaf {id: 'leaf' + i}) CREATE (s)-[:LINKED]->(l)`);
  const mapping = mappingOf(sourceWith('alpha', { uri: server.boltUri, database: 'neo4j', auth, entities, relationships }));
  executor = createNeo4jExecutor({ sources: mapping.sources, env: envFor(server), logger: { warn: () => undefined } });
  const defaults = communitySeams();
  const catalog = createTemplateCatalog({ templates: [...Object.values(shapes), ...[DEGREE_PROBE_ID].flatMap((id) => defaultCatalog().find(id) ?? [])] });
  system = assembleGate({ usability: ALWAYS_USABLE, mapping, seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit: defaults.audit }, executor, logger: { warn: () => undefined }, catalog }).system;
}, 300_000);

afterAll(async () => {
  await runAll([() => executor?.close(), () => server?.stop()]);
});

async function planOf(templateId: string, entityType: string) {
  const started = Date.now();
  const page = await system.run({ traceId: 'tr-degree', sourceId: 'alpha', templateId, params: { entityType, relationshipType: 'LINKED' }, limit: 1 });
  const item = degreeProbeItemSchema.parse(page.items[0]);
  return { operators: item.operators ?? [], elapsedMs: Date.now() - started };
}

const hits = (operators: readonly { dbHits: number }[]): number => operators.reduce((sum, operator) => sum + operator.dbHits, 0);

describe(`the degree probe against ${image}`, () => {
  it('names the degree function and no expansion for a node with 30,000 relationships and for one with 10, within one gate deadline, with equal db hits', async () => {
    const hub = await planOf(DEGREE_PROBE_ID, 'hub');
    const small = await planOf(DEGREE_PROBE_ID, 'small');
    for (const found of [hub, small]) {
      expect(found.operators.some((operator) => operator.details?.includes('getDegree(') === true)).toBe(true);
      expect(found.operators.some((operator) => operator.name.includes('Expand'))).toBe(false);
      expect(found.elapsedMs).toBeLessThan(10_000);
    }
    expect(hits(hub.operators)).toBe(hits(small.operators));
    expect(hits(hub.operators)).toBeLessThan(20);
  });

  it('shows, for the three shapes, what this image is expected to show: the verdict and the operator that decides it', async () => {
    const table = EXPECTED[image];
    expect(table, `no expected row for ${image}`).toBeDefined();
    const capture: Record<string, { result: string; basis: string; decidedBy: string | undefined }> = {};
    for (const [shape, templateId] of [['cheap', DEGREE_PROBE_ID], ['endpointLabel', 'test-endpoint-label'], ['relationshipPredicate', 'test-relationship-predicate']] as const) {
      const { operators } = await planOf(templateId, 'hub');
      const verdict = judgePlan(operators);
      const decisive = operators.find((operator) => (verdict.basis === 'expand' ? operator.name.includes('Expand') : operator.details?.includes('getDegree(') === true));
      capture[shape] = { result: verdict.result, basis: verdict.basis, decidedBy: decisive?.name };
    }
    expect(capture, `the plans of ${image} differ from its expected row; edit EXPECTED to say what this image does`).toEqual(table);
  });
});

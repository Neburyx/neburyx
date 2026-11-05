import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALWAYS_USABLE } from '../testing/usability.js';
import { createSourceGate, type SourceGate } from '../gate/source-gate.js';
import { communitySeams } from '../seams/community-seams.js';
import { memoryAppStore } from '../testing/app-store.js';
import { mappingOf, sourceWith } from '../testing/gate-fixtures.js';
import { LOCAL_PRINCIPAL } from '../testing/gate.js';
import { firstSource } from '../testing/mapping.js';
import { envFor, NEO4J_SERIES, NEO4J_ENV_PASSWORD, NEO4J_ENV_USER, runAdmin, runAll, startNeo4j, type RunningNeo4j } from '../testing/neo4j-server.js';
import { seedFittingGraph } from '../testing/seed-graph.js';
import { createSourceTester } from './tester.js';

const image = NEO4J_SERIES;
let server: RunningNeo4j;
let schemaOnly: RunningNeo4j;
const gates: SourceGate[] = [];

const auth = { kind: 'basic', username_env: NEO4J_ENV_USER, password_env: NEO4J_ENV_PASSWORD };
const entities = [
  { type: 'gadget', label: 'Gadget', stable_id: 'gadgetId', search: ['title'], reference: ['extRef'] },
  { type: 'person', label: 'Person', stable_id: 'personId' },
  { type: 'thing', label: 'Thing', stable_id: 'thingId' },
];
const relationships = [{ type: 'MADE_BY', from: 'gadget', to: 'person', stable_id: 'linkId', observed_at: 'madeAt', evidence: ['recordId'] }];

const mappingFor = (target: RunningNeo4j) => mappingOf(sourceWith('alpha', { uri: target.boltUri, database: target.database, auth, entities, relationships }));

beforeAll(async () => {
  [server, schemaOnly] = await Promise.all([startNeo4j(), startNeo4j()]);
  await Promise.all([server, schemaOnly].map((target) => seedFittingGraph(target, firstSource(mappingFor(target)))));
  // the labels and types stay on the server's lists through their constraints and indexes, with no node left
  await runAdmin(schemaOnly, 'MATCH (n) DETACH DELETE n');
}, 300_000);

afterAll(async () => {
  await runAll([...gates.map((gate) => () => gate.close()), () => server?.stop(), () => schemaOnly?.stop()]);
});

async function report(target: RunningNeo4j) {
  const mapping = mappingFor(target);
  const gate = createSourceGate({ usability: ALWAYS_USABLE, mapping, env: envFor(target), seams: communitySeams(), logger: { warn: () => undefined } });
  gates.push(gate);
  return createSourceTester({ gate: gate.gate, mapping, store: memoryAppStore() }).run({ traceId: 'tr-degree', principal: LOCAL_PRINCIPAL, sourceId: 'alpha' });
}

describe(`the degree probes against ${image}`, () => {
  it('find the count of neighbors answered from the degree for each entity type that has a relationship, and list no other', async () => {
    const found = await report(server);
    expect(found).toMatchObject({ outcome: 'pass', state: 'connected', stateReason: null });
    expect(found.degreeChecks).toEqual({
      status: 'pass',
      foundOn: expect.stringMatching(/^Neo4j (5\.26|2026)\.\d+/),
      types: [
        { entityType: 'gadget', result: 'cheap', basis: 'degree-operator', relationshipTypes: ['MADE_BY'] },
        { entityType: 'person', result: 'cheap', basis: 'degree-operator', relationshipTypes: ['MADE_BY'] },
      ],
      warnings: [],
    });
    expect(found.degreeChecks.foundOn).toBe(`Neo4j ${found.server?.version}`);
  });

  it('still judge the plan for a label that has its schema and no node', async () => {
    const found = await report(schemaOnly);
    expect(found.mappingChecks.status).toBe('pass');
    expect(found.degreeChecks).toMatchObject({ status: 'pass', types: [{ result: 'cheap' }, { result: 'cheap' }] });
  });
});

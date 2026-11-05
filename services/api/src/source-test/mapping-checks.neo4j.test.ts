import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ALWAYS_USABLE } from '../testing/usability.js';
import { createSourceGate, type SourceGate } from '../gate/source-gate.js';
import { communitySeams } from '../seams/community-seams.js';
import { memoryAppStore } from '../testing/app-store.js';
import { mappingOf, sourceWith } from '../testing/gate-fixtures.js';
import { LOCAL_PRINCIPAL } from '../testing/gate.js';
import { envFor, NEO4J_SERIES, NEO4J_ENV_PASSWORD, NEO4J_ENV_USER, runAdmin, runAll, startNeo4j, type RunningNeo4j } from '../testing/neo4j-server.js';
import { constraintName, createSchema, dropConstraint, dropIndex, nodeIndexName, relationshipIndexName, seedFittingGraph } from '../testing/seed-graph.js';
import { firstSource } from '../testing/mapping.js';
import { createSourceTester } from './tester.js';

const image = NEO4J_SERIES;
let server: RunningNeo4j;
let empty: RunningNeo4j;
let gates: SourceGate[] = [];

const auth = { kind: 'basic', username_env: NEO4J_ENV_USER, password_env: NEO4J_ENV_PASSWORD };
const entities = [
  { type: 'gadget', label: 'Gadget', stable_id: 'gadgetId', search: ['title'], reference: ['extRef'] },
  { type: 'person', label: 'Person', stable_id: 'personId' },
];
const relationships = [{ type: 'MADE_BY', from: 'gadget', to: 'person', stable_id: 'linkId', observed_at: 'madeAt', evidence: ['recordId'] }];

const mappingFor = (target: RunningNeo4j) => mappingOf(sourceWith('alpha', { uri: target.boltUri, database: target.database, auth, entities, relationships }));
const sourceOf = (target: RunningNeo4j) => firstSource(mappingFor(target));

beforeAll(async () => {
  [server, empty] = await Promise.all([startNeo4j(), startNeo4j()]);
  await seedFittingGraph(server, sourceOf(server));
});

afterAll(async () => {
  await runAll([...gates.map((gate) => () => gate.close()), () => server?.stop(), () => empty?.stop()]);
});

afterEach(async () => {
  // put the graph back as the seeding made it, whatever a test dropped, added or duplicated
  await runAdmin(server, 'MATCH (n:Gadget) WITH n.gadgetId AS value, collect(n) AS nodes WHERE size(nodes) > 1 FOREACH (extra IN tail(nodes) | DETACH DELETE extra)');
  for (const name of ['idx_Gadget_gadgetId_text', 'idx_Gadget_gadgetId_plain', 'idx_Gadget_title_pair', 'ft_Gadget', 'idx_Secret_code']) await dropIndex(server, name);
  await runAdmin(server, 'MATCH (n:Secret) DETACH DELETE n');
  await createSchema(server, sourceOf(server));
});

async function report(target: RunningNeo4j = server) {
  const mapping = mappingFor(target);
  const gate = createSourceGate({ usability: ALWAYS_USABLE, mapping, env: envFor(target), seams: communitySeams(), logger: { warn: () => undefined } });
  gates.push(gate);
  return createSourceTester({ gate: gate.gate, mapping, store: memoryAppStore() }).run({ traceId: 'tr-mapping', principal: LOCAL_PRINCIPAL, sourceId: 'alpha' });
}

const checks = (found: Awaited<ReturnType<typeof report>>) => found.mappingChecks.findings.map((entry) => [entry.check, entry.entityType ?? entry.relationshipType, entry.property]);

describe(`the mapping checks against ${image}`, () => {
  it('pass for a graph that fits the mapping', async () => {
    expect(await report()).toMatchObject({ outcome: 'pass', state: 'connected', stateReason: null, mappingChecks: { status: 'pass', findings: [] } });
  });

  it('fail for a label nothing on the server uses, and for a relationship type the source lacks', async () => {
    // a label with a constraint or an index stays on the server's list without nodes, so the missing ones are names with no schema
    const mapping = mappingOf(
      sourceWith('alpha', {
        uri: server.boltUri,
        database: server.database,
        auth,
        entities: [...entities, { type: 'ghost', label: 'Ghost', stable_id: 'ghostId' }],
        relationships: [...relationships, { type: 'HAUNTS', from: 'ghost', to: 'person' }],
      }),
    );
    const gate = createSourceGate({ usability: ALWAYS_USABLE, mapping, env: envFor(server), seams: communitySeams(), logger: { warn: () => undefined } });
    gates.push(gate);
    const found = await createSourceTester({ gate: gate.gate, mapping, store: memoryAppStore() }).run({ traceId: 'tr-mapping', principal: LOCAL_PRINCIPAL, sourceId: 'alpha' });
    expect(found).toMatchObject({ outcome: 'fail', state: 'unavailable', mappingChecks: { status: 'fail' } });
    expect(checks(found)).toEqual([
      ['label', 'ghost', undefined],
      ['relationship-type', 'HAUNTS', undefined],
    ]);
    expect(found.mappingChecks.findings[1]).toMatchObject({ from: 'ghost', to: 'person' });
  });

  it('fail the same way, with no other finding, on an empty database', async () => {
    const found = await report(empty);
    expect(found).toMatchObject({ outcome: 'fail', state: 'unavailable' });
    expect(checks(found)).toEqual([
      ['label', 'gadget', undefined],
      ['label', 'person', undefined],
      ['relationship-type', 'MADE_BY', undefined],
    ]);
  });

  it.each([
    ['search', nodeIndexName('Gadget', 'title'), 'search-index', 'gadget', 'title'],
    ['reference', nodeIndexName('Gadget', 'extRef'), 'reference-index', 'gadget', 'extRef'],
    ['evidence', relationshipIndexName('MADE_BY', 'recordId'), 'evidence-index', 'MADE_BY', 'recordId'],
  ])('fail for a missing %s index, on that check only', async (_kind, indexName, check, subject, property) => {
    await dropIndex(server, indexName);
    const found = await report();
    expect(found).toMatchObject({ outcome: 'fail', state: 'unavailable' });
    expect(checks(found)).toEqual([[check, subject, property]]);
  });

  it('only warn for a missing sort index: degraded', async () => {
    await dropIndex(server, relationshipIndexName('MADE_BY', 'madeAt'));
    const found = await report();
    expect(found).toMatchObject({ outcome: 'warn', state: 'degraded', mappingChecks: { status: 'warn' } });
    expect(checks(found)).toEqual([['sort-index', 'MADE_BY', 'madeAt']]);
  });

  it('warn for a relationship stable id with no index, and nothing for one that has an index', async () => {
    await dropIndex(server, relationshipIndexName('MADE_BY', 'linkId'));
    expect(checks(await report())).toEqual([['rel-stable-id-unindexed', 'MADE_BY', 'linkId']]);
  });

  it('do not count a composite index, and a TEXT index counts', async () => {
    await dropIndex(server, nodeIndexName('Gadget', 'title'));
    await runAdmin(server, 'CREATE INDEX idx_Gadget_title_pair FOR (n:Gadget) ON (n.title, n.other)');
    await runAdmin(server, 'CALL db.awaitIndexes(60)');
    expect(checks(await report())).toEqual([['search-index', 'gadget', 'title']]);
    await dropIndex(server, 'idx_Gadget_title_pair');
    await runAdmin(server, `CREATE TEXT INDEX ${'`'}${nodeIndexName('Gadget', 'title')}${'`'} FOR (n:Gadget) ON (n.title)`);
    await runAdmin(server, 'CALL db.awaitIndexes(60)');
    expect((await report()).mappingChecks.status).toBe('pass');
  });

  it('do not count a FULLTEXT index, and never carry an unmapped label or property name', async () => {
    await dropIndex(server, nodeIndexName('Gadget', 'title'));
    await runAdmin(server, 'CREATE (:Secret {code: 1})');
    await runAdmin(server, 'CREATE FULLTEXT INDEX ft_Gadget FOR (n:Gadget|Secret) ON EACH [n.title, n.code]');
    await runAdmin(server, 'CREATE INDEX idx_Secret_code FOR (n:Secret) ON (n.code)');
    await runAdmin(server, 'CALL db.awaitIndexes(60)');
    const found = await report();
    expect(checks(found)).toEqual([['search-index', 'gadget', 'title']]);
    expect(JSON.stringify(found)).not.toMatch(/Secret|code/);
  });
});

describe(`the stable ids against ${image}`, () => {
  /** Drops the unique constraint of Gadget and puts a plain index of the given kind on its stable id instead. */
  async function withoutConstraint(kind: 'RANGE' | 'TEXT' | 'NONE'): Promise<void> {
    await dropConstraint(server, constraintName('Gadget'));
    if (kind !== 'NONE') {
      await runAdmin(server, `CREATE ${kind === 'TEXT' ? 'TEXT ' : ''}INDEX idx_Gadget_gadgetId_${kind === 'TEXT' ? 'text' : 'plain'} FOR (n:Gadget) ON (n.gadgetId)`);
      await runAdmin(server, 'CALL db.awaitIndexes(60)');
    }
  }

  it('give no finding when a constraint makes them unique', async () => {
    expect((await report()).mappingChecks.status).toBe('pass');
  });

  it('fail on duplicates with the count and no value, when an index and no constraint stand in', async () => {
    await withoutConstraint('RANGE');
    await runAdmin(server, "CREATE (:Gadget {gadgetId: 'gadget-gadgetId-1', title: 'dup', extRef: 'a'}), (:Gadget {gadgetId: 'second', title: 'x', extRef: 'b'}), (:Gadget {gadgetId: 'second', title: 'y', extRef: 'c'})");
    const found = await report();
    expect(found).toMatchObject({ outcome: 'fail', state: 'unavailable' });
    expect(found.mappingChecks.findings).toEqual([expect.objectContaining({ check: 'stable-id-unique', entityType: 'gadget', property: 'gadgetId' })]);
    expect(found.mappingChecks.findings[0]?.message).toContain('2 values occur more than once');
    expect(JSON.stringify(found)).not.toContain('second');
  });

  it('warn that no constraint enforces them when no duplicate is found', async () => {
    await withoutConstraint('RANGE');
    const found = await report();
    expect(found).toMatchObject({ outcome: 'warn', state: 'degraded' });
    expect(checks(found)).toEqual([['stable-id-unenforced', 'gadget', 'gadgetId']]);
  });

  it('ignore a node that has no stable id', async () => {
    await withoutConstraint('RANGE');
    await runAdmin(server, "CREATE (:Gadget {title: 'no id'}), (:Gadget {title: 'no id either'})");
    expect(checks(await report())).toEqual([['stable-id-unenforced', 'gadget', 'gadgetId']]);
    await runAdmin(server, 'MATCH (n:Gadget) WHERE n.gadgetId IS NULL DELETE n');
  });

  it.each([
    ['no index and no constraint', 'NONE'],
    ['a TEXT index only', 'TEXT'],
  ] as const)('fail with %s, without scanning', async (_name, kind) => {
    await withoutConstraint(kind);
    const found = await report();
    expect(found).toMatchObject({ outcome: 'fail', state: 'unavailable' });
    // the stable id is not a search property here, so only the stable id check speaks
    expect(checks(found)).toEqual([['stable-id-unindexed', 'gadget', 'gadgetId']]);
    expect(found.mappingChecks.findings[0]?.message).toContain('needs a uniqueness constraint or a RANGE index');
  });

  it('is an index scan with an ordered aggregation: the plan of the Cypher the gate sends', async () => {
    await withoutConstraint('RANGE');
    const session = server.admin.session({ database: server.database });
    try {
      const cypher = 'EXPLAIN MATCH (n:`Gadget`) USING INDEX n:`Gadget`(`gadgetId`) WHERE n.`gadgetId` IS NOT NULL WITH n.`gadgetId` AS value, count(*) AS c WHERE c > 1 RETURN toFloat(count(value)) AS duplicated';
      const { summary } = await session.run(cypher);
      const operators: string[] = [];
      const walk = (plan: { operatorType: string; children: unknown[] }): void => {
        operators.push(plan.operatorType);
        for (const child of plan.children) walk(child as { operatorType: string; children: unknown[] });
      };
      if (summary.plan === undefined || summary.plan === null) throw new Error('the server returned no plan');
      walk(summary.plan as unknown as { operatorType: string; children: unknown[] });
      expect(operators.some((name) => name.startsWith('NodeIndexScan'))).toBe(true);
      expect(operators.some((name) => name.startsWith('OrderedAggregation'))).toBe(true);
      expect(operators.some((name) => name.startsWith('NodeByLabelScan'))).toBe(false);
    } finally {
      await session.close();
    }
  });
});
